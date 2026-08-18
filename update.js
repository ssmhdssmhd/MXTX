/**
 * 超级嗅探 - 在线更新模块
 *
 * 功能：
 *   支持「浏览器更新」和「源码更新」两种独立更新，
 *   各自下载、解压、替换、验证、回滚，互不干扰。
 *   支持「稳定版 / 先行版」两种更新源：
 *     稳定版 -> main 分支（旧包，稳定发布）
 *     先行版 -> cs1 分支（新包，先行体验）
 *   用户可在后台自由切换更新源，更新到对应分支版本。
 *
 * 环境变量（MX_ 前缀，兼容旧变量名）：
 *   MX_GITHUB_OWNER   GitHub 用户名（旧：GITHUB_OWNER）
 *   MX_GITHUB_REPO    GitHub 仓库名（旧：GITHUB_REPO）
 *   MX_GITHUB_TOKEN   GitHub Token（旧：GITHUB_TOKEN），私有仓库更新需要
 *   MX_CHROME_PATH    Chrome 可执行路径，用于版本检查（旧：CHROME_PATH）
 *   MX_PROXY          下载代理（如 http://127.0.0.1:7890），可选
 *
 * 更新源：
 *   GitHub Releases（默认 ssmhdssmhd/MXTX）
 *   资产命名约定（各更新各的，按分支区分）：
 *     super-sniffer-source_<version>.zip      稳定版源码包（main 分支）
 *     super-sniffer-browser_<version>.zip     稳定版浏览器包（main 分支）
 *     super-sniffer-source_<version>-cs1.zip  先行版源码包（cs1 分支）
 *     super-sniffer-browser_<version>-cs1.zip 先行版浏览器包（cs1 分支）
 *
 * 安全机制：
 *   更新前自动备份，更新后自动验证；
 *   验证失败自动回滚到旧版本，保证服务不中断。
 */

'use strict';

// ========== 依赖 ==========
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ========== 环境变量读取（优先 MX_ 前缀，兼容旧名，再默认值） ==========
/** 读取字符串环境变量 */
function envS(mxKey, legacyKey, defVal) {
  const v = process.env[mxKey];
  if (v !== undefined && v !== '') return v;
  if (legacyKey) {
    const lv = process.env[legacyKey];
    if (lv !== undefined && lv !== '') return lv;
  }
  return defVal;
}

// ---------- 更新源配置 ----------
/** GitHub 用户名（所属组织/账号） */
const GITHUB_OWNER = envS('MX_GITHUB_OWNER', 'GITHUB_OWNER', 'ssmhdssmhd');
/** GitHub 仓库名 */
const GITHUB_REPO  = envS('MX_GITHUB_REPO',  'GITHUB_REPO',  'MXTX');
/** GitHub Token（可选，私有仓库更新需要，或突破 API 限流） */
const GITHUB_TOKEN = envS('MX_GITHUB_TOKEN', 'GITHUB_TOKEN', '');
/** 下载代理（可选） */
const MX_PROXY     = envS('MX_PROXY', null, '');

/** GitHub API 基础路径 */
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

// ---------- 路径常量 ----------
/** 项目根目录（= update.js 所在目录） */
const ROOT_DIR = __dirname;
/** 更新备份目录（更新失败回滚时使用） */
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
/** 临时解压目录（系统 tmp） */
const TMP_DIR = path.join(os.tmpdir(), 'super-sniffer-update');
/** 更新源持久化文件（记录用户选的 stable / beta） */
const CONFIG_FILE = path.join(ROOT_DIR, 'update-config.json');

// ========== 更新源 / 分支映射 ==========
/** 更新源字符串 -> 分支名 */
const SOURCE_BRANCH = {
  stable: 'main', // 稳定版 -> main 分支
  beta: 'cs1'     // 先行版 -> cs1 分支
};
/** 分支名 -> Release 资产名后缀 */
const BRANCH_SUFFIX = {
  main: '',   // main 分支资产无后缀
  cs1: '-cs1' // cs1 分支资产带 -cs1 后缀
};

// ========== 源码更新涉及的文件列表（不含 node_modules / chrome） ==========
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
  '.env.example'  // v2.0+ 新增的环境变量配置模板
];

// ============================================================
// 工具函数
// ============================================================

/**
 * 获取当前更新源（stable / beta），默认 stable
 * @returns {'stable'|'beta'}
 */
function getUpdateSource() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg.source === 'beta' ? 'beta' : 'stable';
  } catch (e) {
    return 'stable';
  }
}

/**
 * 设置更新源（写入 CONFIG_FILE 持久化）
 * @param {'stable'|'beta'} source
 * @returns {'stable'|'beta'}
 */
function setUpdateSource(source) {
  if (!['stable', 'beta'].includes(source)) {
    throw new Error('无效的更新源，仅支持 stable / beta');
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ source }, null, 2));
  return source;
}

/**
 * 当前更新源对应的分支名
 * @returns {'main'|'cs1'}
 */
function getBranch() {
  return SOURCE_BRANCH[getUpdateSource()];
}

/** 当前更新源的完整信息（UI 展示用） */
function getSourceInfo() {
  const source = getUpdateSource();
  return {
    source,
    branch: SOURCE_BRANCH[source],
    label: source === 'beta' ? '先行版' : '稳定版'
  };
}

/**
 * 读取当前版本号（从 package.json 的 version 字段）
 * @returns {string}
 */
function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

/**
 * 获取 Chrome 版本（可执行路径优先用 MX_CHROME_PATH/CHROME_PATH）
 * @returns {string} 版本号 / "未安装" / "不可用"
 */
function getChromeVersion() {
  const chromePath =
    envS('MX_CHROME_PATH', 'CHROME_PATH', path.join(ROOT_DIR, 'chrome-linux64', 'chrome'));
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

/**
 * 发送 GitHub API 请求（带 UA/Accept/Token，若设置代理也会使用）
 * @param {string} url 完整 URL
 * @returns {Promise<any>} JSON 结果
 */
async function githubApi(url) {
  const headers = {
    'User-Agent': 'super-sniffer-updater',
    Accept: 'application/vnd.github+json'
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

  // 代理支持（走 undici/fetch 的 dispatcher，这里简单用环境变量让 Node 自动走代理）
  let dispatcher = undefined;
  if (MX_PROXY) {
    try {
      // 动态加载 undici 的 ProxyAgent，若无 undici 依赖则跳过
      const { ProxyAgent } = require('undici');
      dispatcher = new ProxyAgent(MX_PROXY);
    } catch (e) {
      // 没有 undici 时，把代理写入系统变量供 fetch 底层尝试
      process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || MX_PROXY;
      process.env.HTTP_PROXY  = process.env.HTTP_PROXY  || MX_PROXY;
    }
  }
  const res = await fetch(url, { headers, dispatcher });
  if (!res.ok) {
    throw new Error(`GitHub API 请求失败 (${res.status})`);
  }
  return await res.json();
}

/**
 * 获取当前更新源分支的最新 Release
 *  - main 分支：tag 不含 -cs1 的最新 release
 *  - cs1  分支：tag 包含 -cs1 的最新 release
 * @returns {Promise<any>} Release 对象
 */
async function getLatestRelease() {
  const branch = getBranch();
  const releases = await githubApi(`${API_BASE}/releases?per_page=30`);
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

/**
 * 从 Release 中查找指定类型的资产，按当前分支匹配命名后缀
 * @param {any} release Release 对象
 * @param {'browser'|'source'} type 资产类型
 * @returns {any|null}
 */
function findAsset(release, type) {
  const branch = getBranch();
  const suffix = BRANCH_SUFFIX[branch];
  const base = type === 'browser' ? 'super-sniffer-browser_' : 'super-sniffer-source_';
  const assets = release.assets || [];
  if (suffix) {
    const match = assets.find((a) => a.name.startsWith(base) && a.name.includes(suffix));
    if (match) return match;
  }
  // 回退：找不到带后缀的资产时，匹配不带 -cs1 的普通资产
  return assets.find((a) => a.name.startsWith(base) && !a.name.includes('-cs1'));
}

/**
 * 下载文件（支持代理、大文件流式写入）
 * @param {string} url
 * @param {string} dest 目标路径
 * @returns {Promise<number>} 写入字节数
 */
async function downloadFile(url, dest) {
  const headers = { 'User-Agent': 'super-sniffer-updater' };
  let dispatcher = undefined;
  if (MX_PROXY) {
    try {
      const { ProxyAgent } = require('undici');
      dispatcher = new ProxyAgent(MX_PROXY);
    } catch (e) {
      process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || MX_PROXY;
      process.env.HTTP_PROXY  = process.env.HTTP_PROXY  || MX_PROXY;
    }
  }
  const res = await fetch(url, { headers, dispatcher });
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);
  // 流写入，避免大文件占爆内存
  const fileStream = fs.createWriteStream(dest);
  // Node 18+ fetch body 是 ReadableStream，需要转写
  // @ts-ignore
  const reader = res.body.getReader();
  let written = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    written += value.length;
  }
  fileStream.end();
  // 等 writeStream 完成
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
  return written;
}

/**
 * 解压 zip 到指定目录（依赖系统 unzip 命令）
 */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
}

/** 递归删除目录/文件（无视报错） */
function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

/**
 * 版本号比较（语义化 x.y.z）
 * @returns 正数 a > b，负数 a < b，0 相等
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 在 dir 下递归查找名为 name 的第一个目录
 * @returns {string|null}
 */
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

/** 字节数格式化（GB/MB/KB/B） */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

// ============================================================
// 浏览器更新
// ============================================================
async function updateBrowser(log) {
  log('开始浏览器更新...');
  const release = await getLatestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = findAsset(release, 'browser');
  if (!asset) throw new Error('最新 Release 中未找到浏览器包资产');

  const zipPath = path.join(TMP_DIR, 'browser.zip');
  const extractDir = path.join(TMP_DIR, 'browser-extract');
  const chromeDir = path.join(ROOT_DIR, 'chrome-linux64');
  const backupChromeDir = path.join(BACKUP_DIR, 'chrome-linux64');

  // 1. 下载
  log(`下载浏览器包 ${asset.name} (${formatSize(asset.size)})...`);
  rmrf(TMP_DIR);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  await downloadFile(asset.browser_download_url, zipPath);
  log('下载完成，开始解压...');

  // 2. 解压
  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  // 3. 定位解压后的 chrome-linux64 目录
  let newChromeDir = path.join(extractDir, 'chrome-linux64');
  if (!fs.existsSync(path.join(newChromeDir, 'chrome'))) {
    const found = findDir(extractDir, 'chrome-linux64');
    if (found) newChromeDir = found;
    else throw new Error('浏览器包中未找到 chrome 可执行文件');
  }

  // 4. 备份当前浏览器
  rmrf(backupChromeDir);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(chromeDir)) {
    fs.cpSync(chromeDir, backupChromeDir, { recursive: true });
    log('已备份当前浏览器');
  }

  // 5. 替换
  rmrf(chromeDir);
  fs.cpSync(newChromeDir, chromeDir, { recursive: true });
  log('已替换浏览器');

  // 6. 验证
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

  // 7. 清理
  rmrf(backupChromeDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`浏览器更新完成，当前版本: ${getChromeVersion()}`);
  return { type: 'browser', version };
}

// ============================================================
// 源码更新
// ============================================================
async function updateSource(log) {
  log('开始源码更新...');
  const release = await getLatestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = findAsset(release, 'source');
  if (!asset) throw new Error('最新 Release 中未找到源码包资产');

  const zipPath = path.join(TMP_DIR, 'source.zip');
  const extractDir = path.join(TMP_DIR, 'source-extract');
  const backupSourceDir = path.join(BACKUP_DIR, 'source');

  // 1. 下载
  log(`下载源码包 ${asset.name} (${formatSize(asset.size)})...`);
  rmrf(TMP_DIR);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  await downloadFile(asset.browser_download_url, zipPath);
  log('下载完成，开始解压...');

  // 2. 解压
  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  // 3. 定位源码根目录（兼容 zip 里多一层目录的情况）
  let srcRoot = extractDir;
  const entries = fs.readdirSync(extractDir);
  if (
    entries.length === 1 &&
    fs.statSync(path.join(extractDir, entries[0])).isDirectory()
  ) {
    srcRoot = path.join(extractDir, entries[0]);
  }

  // 4. 备份当前源码文件
  rmrf(backupSourceDir);
  fs.mkdirSync(backupSourceDir, { recursive: true });
  for (const file of SOURCE_FILES) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(backupSourceDir, file), { recursive: true });
    }
  }
  log('已备份当前源码');

  // 5. 替换源码文件
  for (const file of SOURCE_FILES) {
    const src = path.join(srcRoot, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(ROOT_DIR, file), { recursive: true });
    }
  }
  log('已替换源码文件');

  // 6. 语法验证（node --check 新 node.js）
  try {
    execSync(`node --check "${path.join(ROOT_DIR, 'node.js')}"`, { stdio: 'pipe' });
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

  // 7. 清理
  rmrf(backupSourceDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`源码更新完成，新版本: ${version}`);
  return { type: 'source', version };
}

// ============================================================
// 服务重启（源码更新成功后调用）
// ============================================================
function restartServer(log) {
  log('正在重启服务...');
  const mainFile = path.join(ROOT_DIR, 'node.js');
  const logFile = path.join(ROOT_DIR, 'restart.log');
  // 以独立子进程方式启动新服务，日志追加到 restart.log
  // node.js 内部实现了端口占用自动重试，无需 sleep 等待端口释放
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [mainFile], {
    detached: true,
    stdio: ['ignore', out, out],
    cwd: ROOT_DIR
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// ============================================================
// 导出
// ============================================================
module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  getCurrentVersion,
  getChromeVersion,
  getLatestRelease,
  updateBrowser,
  updateSource,
  restartServer,
  compareVersions,
  formatSize,
  getUpdateSource,
  setUpdateSource,
  getBranch,
  getSourceInfo
};
