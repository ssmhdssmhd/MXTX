/**
 * v2 万能嗅探更新模块，MX_ 变量支持
 *
 * 功能：
 *   支持「浏览器更新」和「源码更新」两种独立更新，
 *   各自下载、解压、替换、验证、回滚，互不干扰。
 *   支持「稳定版 / 先行版」两种更新源：
 *     稳定版 -> main 分支（旧包，稳定发布）
 *     先行版 -> cs1 分支（新包，先行体验）
 *   用户可在后台自由切换更新源，更新到对应分支版本。
 *
 * 更新源：
 *   GitHub Releases（ssmhdssmhd/MXTX）
 *   资产命名约定（各更新各的，按分支区分）：
 *     super-sniffer-source_<version>.zip      稳定版源码包（main 分支）
 *     super-sniffer-browser_<version>.zip     稳定版浏览器包（main 分支）
 *     super-sniffer-source_<version>-cs1.zip  先行版源码包（cs1 分支）
 *     super-sniffer-browser_<version>-cs1.zip 先行版浏览器包（cs1 分支）
 *
 * 安全机制：
 *   更新前自动备份，更新后自动验证；
 *   验证失败自动回滚到旧版本，保证服务不中断。
 *
 * MX_ 变量系统：
 *   所有环境变量均支持 MX_ 前缀（MX_GITHUB_OWNER / MX_GITHUB_REPO / MX_GITHUB_TOKEN / MX_PROXY 等），
 *   优先读取 MX_ 前缀版本，回退到无前缀版本。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { Agent, ProxyAgent, fetch, setGlobalDispatcher, getGlobalDispatcher } = require('undici');

// ========== MX_ 变量环境工具函数 ==========
function envS(key, fallback = '') {
  const mxKey = `MX_${key}`;
  const val = process.env[mxKey];
  if (val !== undefined && val !== '') return val;
  const plainVal = process.env[key];
  if (plainVal !== undefined && plainVal !== '') return plainVal;
  return fallback;
}

// ========== 配置 ==========
const GITHUB_OWNER = envS('GITHUB_OWNER', 'ssmhdssmhd');
const GITHUB_REPO = envS('GITHUB_REPO', 'MXTX');
const GITHUB_TOKEN = envS('GITHUB_TOKEN', '');
const MX_PROXY = envS('PROXY', '');
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

// 代理自动探测：优先 MX_PROXY，其次标准系统代理变量（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 及小写）。
// 沙箱 / 公司内网即使不配 MX_PROXY，也能通过系统代理访问 GitHub API 与下载更新包。
function detectProxy() {
  const candidates = [
    'MX_PROXY',
    'PROXY',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy'
  ];
  for (const key of candidates) {
    const val = process.env[key];
    if (val && val !== '') return val;
  }
  return '';
}

// 网络参数：大文件下载必须放宽超时（undici 默认 bodyTimeout 300s，
// 200MB 浏览器包走慢速代理时极易超时被掐断 -> 下载失败）。
const AGENT_OPTS = {
  bodyTimeout: 30 * 60 * 1000,  // 完整响应体最长等待 30 分钟（针对大文件下载）
  headersTimeout: 120000,       // 响应头最长等待 120s
  connectTimeout: 30000         // TCP 连接建立最长等待 30s
};

// 与 node.js 保持一致：优先 MX_PROXY，未配置时自动读取系统代理变量，无代理则直连
let dispatcher;
if (MX_PROXY) {
  try {
    dispatcher = new ProxyAgent(Object.assign({ uri: MX_PROXY }, AGENT_OPTS));
    setGlobalDispatcher(dispatcher);
  } catch (e) {
    dispatcher = new Agent(AGENT_OPTS);
  }
} else {
  const sysProxy = detectProxy();
  if (sysProxy) {
    dispatcher = new ProxyAgent(Object.assign({ uri: sysProxy }, AGENT_OPTS));
  } else {
    dispatcher = new Agent(AGENT_OPTS);
  }
  setGlobalDispatcher(dispatcher);
}

const ROOT_DIR = __dirname;
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
const TMP_DIR = path.join(os.tmpdir(), 'super-sniffer-update');
// 确保下载/解压临时目录存在，否则 createWriteStream 会抛 ENOENT 导致进程崩溃
fs.mkdirSync(TMP_DIR, { recursive: true });
const CONFIG_FILE = path.join(ROOT_DIR, 'update-config.json');

const SOURCE_BRANCH = {
  stable: 'main',
  beta: 'cs1'
};
const BRANCH_SUFFIX = {
  main: '',
  cs1: '-cs1'
};

const SOURCE_FILES = [
  'node.js',
  'api.php',
  'package.json',
  'package-lock.json',
  'admin.html',
  'update.js',
  'README.md',
  'CHANGELOG.md',
  '.gitignore',
  '.user.ini',
  '1.sh',
  '.env.example'
];

// ========== 工具函数 ==========

function getUpdateSource() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.source === 'beta' ? 'beta' : 'stable';
  } catch (e) {
    return 'stable';
  }
}

function setUpdateSource(source) {
  if (!['stable', 'beta'].includes(source)) {
    throw new Error('无效的更新源，仅支持 stable / beta');
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ source }, null, 2));
  return source;
}

function getBranch() {
  return SOURCE_BRANCH[getUpdateSource()];
}

function getSourceInfo() {
  const source = getUpdateSource();
  return {
    source,
    branch: SOURCE_BRANCH[source],
    label: source === 'beta' ? '先行版' : '稳定版'
  };
}

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

function getChromeVersion() {
  const chromePath =
    envS('CHROME_PATH', path.join(ROOT_DIR, 'chrome-linux64', 'chrome'));
  if (!fs.existsSync(chromePath)) return '未安装';
  try {
    const out = execSync(`"${chromePath}" --version 2>&1`, { timeout: 10000 })
      .toString()
      .trim();
    return out.replace(/^Chrome\s*/, '');
  } catch (e) {
    return '不可用';
  }
}

async function githubApi(url) {
  const headers = {
    'User-Agent': 'super-sniffer-updater',
    Accept: 'application/vnd.github+json'
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, dispatcher });
  if (!res.ok) {
    throw new Error(`GitHub API 请求失败 (${res.status})`);
  }
  return await res.json();
}

async function getLatestRelease() {
  const branch = getBranch();
  let releases;
  try {
    releases = await githubApi(`${API_BASE}/releases?per_page=30`);
  } catch (e) {
    // API 限流（403/429，匿名 60 次/小时，共享/NAT IP 极易耗尽）时，
    // 回退到 GitHub Releases Atom Feed（不受 API 限流），仍可正常检查/更新
    const viaFeed = await getLatestReleaseViaFeed();
    if (viaFeed) return viaFeed;
    throw e;
  }
  const filtered = releases.filter((r) => {
    const tag = String(r.tag_name || '');
    if (branch === 'cs1') return tag.includes('-cs1');
    return !tag.includes('-cs1');
  });
  if (filtered.length === 0) {
    throw new Error(`${branch} 分支暂无发布版本`);
  }
  return filtered[0];
}

// 按资产命名约定构造资产对象（feed 不含资产列表，但项目资产名固定可推导）
function buildAsset(type, tag, version, suffix) {
  const prefix = type === 'browser' ? 'super-sniffer-browser_' : 'super-sniffer-source_';
  const name = `${prefix}${version}${suffix}.zip`;
  return {
    name,
    size: 0,
    browser_download_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${name}`
  };
}

// 回退：GitHub API 限流时，从 releases.atom 源解析最新发布标签
async function getLatestReleaseViaFeed() {
  const branch = getBranch();
  const suffix = BRANCH_SUFFIX[branch];
  const res = await fetch(
    `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases.atom`,
    { headers: { 'User-Agent': 'super-sniffer-updater' }, dispatcher }
  );
  if (!res.ok) throw new Error(`GitHub Releases 源访问失败 (HTTP ${res.status})`);
  const xml = await res.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const entry of entries) {
    const idMatch = entry.match(/<id>tag:[^<]*\/([^\/<]+)<\/id>/);
    const linkMatch = entry.match(/href="[^"]*\/releases\/tag\/([^"\/]+)"/);
    const titleMatch = entry.match(/<title>([^<]*)<\/title>/);
    const tag = (idMatch && idMatch[1]) || (linkMatch && linkMatch[1]);
    if (!tag) continue;
    if (suffix) {
      if (!tag.includes(suffix)) continue;
    } else if (tag.includes('-cs1')) {
      continue;
    }
    const version = String(tag).replace(/^v/i, '');
    const baseVersion = version.split('-')[0]; // 剥离 -cs1 分支后缀，资产名用基础版本
    return {
      tag_name: tag,
      name: titleMatch ? titleMatch[1] : tag,
      assets: [
        buildAsset('source', tag, baseVersion, suffix),
        buildAsset('browser', tag, baseVersion, suffix)
      ]
    };
  }
  throw new Error(`${branch} 分支暂无发布版本`);
}

function findAsset(release, type) {
  const branch = getBranch();
  const suffix = BRANCH_SUFFIX[branch];
  const base =
    type === 'browser' ? 'super-sniffer-browser_' : 'super-sniffer-source_';
  const assets = release.assets || [];
  if (suffix) {
    const match = assets.find(
      (a) => a.name.startsWith(base) && a.name.includes(suffix)
    );
    if (match) return match;
  }
  return assets.find((a) => a.name.startsWith(base) && !a.name.includes('-cs1'));
}

// 单次下载尝试（流式写盘 + 节流进度回调）
async function downloadOnce(url, dest, headers, onProgress) {
  const res = await fetch(url, { headers, dispatcher });
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);

  const contentLength = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastEmit = 0;

  // 确保下载目录存在（防御性，配合模块加载时创建 TMP_DIR）
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fileStream = fs.createWriteStream(dest);
  const reader = res.body.getReader();

  // 捕获写盘错误（磁盘满/权限/目录不可写），转成 Promise 拒绝而不是进程崩溃
  let streamErr = null;
  fileStream.on('error', (err) => { streamErr = err; });

  const emit = (force) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    // 节流：至少 200ms 才推送一次进度，避免每块刷屏拖垮 SSE
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const pct =
      contentLength > 0
        ? Math.min(100, Math.round((received / contentLength) * 100))
        : 0;
    onProgress(received, contentLength, pct);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (streamErr) throw streamErr;
      received += value.length;
      // 写回退压：write 返回 false 时等待 drain，避免大文件（如 127MB 浏览器包）内存暴涨
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise((resolve) => fileStream.once('drain', resolve));
      }
      emit(false);
    }
  } finally {
    fileStream.end();
    await reader.cancel().catch(() => {});
  }

  if (streamErr) throw streamErr;

  // 完整性校验：Content-Length 存在但字节数对不上 -> 视为下载失败（大文件半途截断）
  if (contentLength > 0 && received !== contentLength) {
    throw new Error(`文件不完整：期望 ${contentLength} 字节，实际 ${received} 字节`);
  }
  emit(true); // 收尾补一次 100%
  return received;
}

async function downloadFile(url, dest, onProgress) {
  const headers = { 'User-Agent': 'super-sniffer-updater' };
  if (GITHUB_TOKEN && url.includes('github.com')) {
    headers.Authorization = `token ${GITHUB_TOKEN}`;
  }

  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(url, dest, headers, onProgress);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        // 指数退避后重试，应对网络抖动 / 代理瞬断
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw lastErr || new Error('下载失败');
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  } catch (e) {
    // unzip 缺失（精简 Docker / 部分宝塔环境）时回退到 python3 内置 zipfile 解压
    try {
      execSync(`python3 -m zipfile -e "${zipPath}" "${destDir}"`, { stdio: 'pipe' });
    } catch (e2) {
      throw new Error('解压失败：缺少 unzip，且 python3 解压也失败');
    }
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function findDir(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === name) return path.join(dir, e.name);
      const sub = findDir(path.join(dir, e.name), name);
      if (sub) return sub;
    }
  }
  return null;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

// 规范化版本号：去掉 v 前缀与 "-cs1" 等分支后缀，仅保留纯数字段。
// 例如 "v2.2.1-cs1" -> "2.2.1"，保证 cs1/main 两分支版本可正确比较（递增判断）。
function normalizeVersion(v) {
  return String(v || '').replace(/^v/i, '').split('-')[0].trim();
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ========== 浏览器更新 ==========

async function updateBrowser(log, onProgress) {
  log('开始浏览器更新...');
  const release = await getLatestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = findAsset(release, 'browser');
  if (!asset) throw new Error('最新 Release 中未找到浏览器包资产');

  const zipPath = path.join(TMP_DIR, 'browser.zip');
  const extractDir = path.join(TMP_DIR, 'browser-extract');
  const chromeDir = path.join(ROOT_DIR, 'chrome-linux64');
  const backupChromeDir = path.join(BACKUP_DIR, 'chrome-linux64');

  log(`下载浏览器包 ${asset.name} (${formatSize(asset.size)})...`);
  await downloadFile(asset.browser_download_url, zipPath, (received, total, pct) => {
    if (typeof onProgress === 'function') onProgress({ phase: 'browser', received, total, pct });
  });
  log('下载完成，开始解压...');

  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  let newChromeDir = path.join(extractDir, 'chrome-linux64');
  if (!fs.existsSync(path.join(newChromeDir, 'chrome'))) {
    const found = findDir(extractDir, 'chrome-linux64');
    if (found) newChromeDir = found;
    else throw new Error('浏览器包中未找到 chrome 可执行文件');
  }

  rmrf(backupChromeDir);
  if (fs.existsSync(chromeDir)) {
    fs.cpSync(chromeDir, backupChromeDir, { recursive: true });
    log('已备份当前浏览器');
  }

  rmrf(chromeDir);
  fs.cpSync(newChromeDir, chromeDir, { recursive: true });
  log('已替换浏览器');

  const chromeBin = path.join(chromeDir, 'chrome');
  if (fs.existsSync(chromeBin)) fs.chmodSync(chromeBin, 0o755);
  try {
    const ver = execSync(`"${chromeBin}" --version 2>&1`, { timeout: 15000 })
      .toString()
      .trim();
    log(`浏览器验证通过: ${ver}`);
  } catch (e) {
    rmrf(chromeDir);
    if (fs.existsSync(backupChromeDir)) {
      fs.cpSync(backupChromeDir, chromeDir, { recursive: true });
      log('浏览器验证失败，已自动回滚到旧版本');
    }
    throw new Error('浏览器验证失败，已自动回滚');
  }

  rmrf(backupChromeDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`浏览器更新完成，当前版本: ${getChromeVersion()}`);
  return { type: 'browser', version };
}

// ========== 源码更新 ==========

async function updateSource(log, onProgress) {
  log('开始源码更新...');
  const release = await getLatestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = findAsset(release, 'source');
  if (!asset) throw new Error('最新 Release 中未找到源码包资产');

  // 版本递增保护：仅当新版本号高于当前版本才更新，防止降级 / 同版本重复覆盖
  const baseVersion = normalizeVersion(version);
  if (compareVersions(baseVersion, getCurrentVersion()) <= 0) {
    log(`已是最新版本（v${getCurrentVersion()}），无需更新`);
    return { type: 'source', version, skipped: true };
  }

  const zipPath = path.join(TMP_DIR, 'source.zip');
  const extractDir = path.join(TMP_DIR, 'source-extract');
  const backupSourceDir = path.join(BACKUP_DIR, 'source');

  log(`下载源码包 ${asset.name} (${formatSize(asset.size)})...`);
  await downloadFile(asset.browser_download_url, zipPath, (received, total, pct) => {
    if (typeof onProgress === 'function') onProgress({ phase: 'source', received, total, pct });
  });
  log('下载完成，开始解压...');

  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  let srcRoot = extractDir;
  const entries = fs.readdirSync(extractDir);
  if (
    entries.length === 1 &&
    fs.statSync(path.join(extractDir, entries[0])).isDirectory()
  ) {
    srcRoot = path.join(extractDir, entries[0]);
  }

  rmrf(backupSourceDir);
  fs.mkdirSync(backupSourceDir, { recursive: true });
  for (const file of SOURCE_FILES) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(backupSourceDir, file), { recursive: true });
    }
  }
  log('已备份当前源码');

  for (const file of SOURCE_FILES) {
    const src = path.join(srcRoot, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(ROOT_DIR, file), { recursive: true });
    }
  }
  log('已替换源码文件');

  try {
    execSync(`node --check "${path.join(ROOT_DIR, 'node.js')}"`, {
      stdio: 'pipe'
    });
    log('新源码语法验证通过');
  } catch (e) {
    for (const file of SOURCE_FILES) {
      const backup = path.join(backupSourceDir, file);
      if (fs.existsSync(backup)) {
        fs.cpSync(backup, path.join(ROOT_DIR, file), { recursive: true });
      }
    }
    log('新源码验证失败，已自动回滚到旧版本');
    throw new Error('新源码验证失败，已自动回滚');
  }

  rmrf(backupSourceDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`源码更新完成，新版本: ${version}`);
  return { type: 'source', version };
}

// ========== 重启服务 ==========

function restartServer(log) {
  log('正在重启服务...');
  const mainFile = path.join(ROOT_DIR, 'node.js');
  const logFile = path.join(ROOT_DIR, 'restart.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [mainFile], {
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

module.exports = {
  envS,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_TOKEN,
  MX_PROXY,
  SOURCE_BRANCH,
  BRANCH_SUFFIX,
  SOURCE_FILES,
  getUpdateSource,
  setUpdateSource,
  getBranch,
  getSourceInfo,
  getCurrentVersion,
  getChromeVersion,
  githubApi,
  getLatestRelease,
  findAsset,
  downloadFile,
  extractZip,
  rmrf,
  findDir,
  formatSize,
  normalizeVersion,
  compareVersions,
  updateBrowser,
  updateSource,
  restartServer
};
