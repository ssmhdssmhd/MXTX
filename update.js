/**
 * 超级嗅探 - 在线更新模块
 *
 * 功能：
 *   支持「浏览器更新」和「源码更新」两种独立更新，
 *   各自下载、解压、替换、验证、回滚，互不干扰。
 *
 * 更新源：
 *   GitHub Releases（ssmhdssmhd/MXTX）
 *   资产命名约定（各更新各的）：
 *     super-sniffer-source_<version>.zip    源码包（不含浏览器）
 *     super-sniffer-browser_<version>.zip   浏览器包（仅浏览器）
 *
 * 安全机制：
 *   更新前自动备份，更新后自动验证；
 *   验证失败自动回滚到旧版本，保证服务不中断。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// ========== 配置 ==========
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'ssmhdssmhd';
const GITHUB_REPO = process.env.GITHUB_REPO || 'MXTX';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''; // 可选，私有仓库需要
const API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

const ROOT_DIR = __dirname;
const BACKUP_DIR = path.join(ROOT_DIR, 'backup');
const TMP_DIR = path.join(os.tmpdir(), 'super-sniffer-update');

// 源码包中包含的文件列表（用于替换，不含 node_modules 与浏览器）
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
  '1.sh'
];

// ========== 工具函数 ==========

// 获取当前版本号（从 package.json）
function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (e) {
    return '0.0.0';
  }
}

// 获取 Chrome 版本
function getChromeVersion() {
  const chromePath =
    process.env.CHROME_PATH || path.join(ROOT_DIR, 'chrome-linux64', 'chrome');
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

// GitHub API 请求
async function githubApi(url) {
  const headers = {
    'User-Agent': 'super-sniffer-updater',
    Accept: 'application/vnd.github+json'
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API 请求失败 (${res.status})`);
  }
  return await res.json();
}

// 获取最新 release
async function getLatestRelease() {
  return await githubApi(`${API_BASE}/releases/latest`);
}

// 从 release 中查找指定类型的资产
function findAsset(release, type) {
  const prefix =
    type === 'browser' ? 'super-sniffer-browser_' : 'super-sniffer-source_';
  return (release.assets || []).find((a) => a.name.startsWith(prefix));
}

// 下载文件
async function downloadFile(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'super-sniffer-updater' }
  });
  if (!res.ok) throw new Error(`下载失败 (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

// 解压 zip
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
}

// 删除目录或文件
function rmrf(p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

// 版本号比较（返回正数表示 a 新于 b）
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

// 递归查找指定名称的目录
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

// 格式化文件大小
function formatSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

// ========== 浏览器更新 ==========

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

  // 下载
  log(`下载浏览器包 ${asset.name} (${formatSize(asset.size)})...`);
  await downloadFile(asset.browser_download_url, zipPath);
  log('下载完成，开始解压...');

  // 解压
  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  // 定位解压后的 chrome-linux64 目录
  let newChromeDir = path.join(extractDir, 'chrome-linux64');
  if (!fs.existsSync(path.join(newChromeDir, 'chrome'))) {
    const found = findDir(extractDir, 'chrome-linux64');
    if (found) newChromeDir = found;
    else throw new Error('浏览器包中未找到 chrome 可执行文件');
  }

  // 备份当前浏览器
  rmrf(backupChromeDir);
  if (fs.existsSync(chromeDir)) {
    fs.cpSync(chromeDir, backupChromeDir, { recursive: true });
    log('已备份当前浏览器');
  }

  // 替换
  rmrf(chromeDir);
  fs.cpSync(newChromeDir, chromeDir, { recursive: true });
  log('已替换浏览器');

  // 验证
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

  // 清理
  rmrf(backupChromeDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`浏览器更新完成，当前版本: ${getChromeVersion()}`);
  return { type: 'browser', version };
}

// ========== 源码更新 ==========

async function updateSource(log) {
  log('开始源码更新...');
  const release = await getLatestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = findAsset(release, 'source');
  if (!asset) throw new Error('最新 Release 中未找到源码包资产');

  const zipPath = path.join(TMP_DIR, 'source.zip');
  const extractDir = path.join(TMP_DIR, 'source-extract');
  const backupSourceDir = path.join(BACKUP_DIR, 'source');

  // 下载
  log(`下载源码包 ${asset.name} (${formatSize(asset.size)})...`);
  await downloadFile(asset.browser_download_url, zipPath);
  log('下载完成，开始解压...');

  // 解压
  rmrf(extractDir);
  extractZip(zipPath, extractDir);

  // 定位源码根目录（兼容解压后多一层目录的情况）
  let srcRoot = extractDir;
  const entries = fs.readdirSync(extractDir);
  if (
    entries.length === 1 &&
    fs.statSync(path.join(extractDir, entries[0])).isDirectory()
  ) {
    srcRoot = path.join(extractDir, entries[0]);
  }

  // 备份当前源码文件
  rmrf(backupSourceDir);
  fs.mkdirSync(backupSourceDir, { recursive: true });
  for (const file of SOURCE_FILES) {
    const src = path.join(ROOT_DIR, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(backupSourceDir, file), { recursive: true });
    }
  }
  log('已备份当前源码');

  // 替换源码文件
  for (const file of SOURCE_FILES) {
    const src = path.join(srcRoot, file);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(ROOT_DIR, file), { recursive: true });
    }
  }
  log('已替换源码文件');

  // 验证新 node.js 语法
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

  // 清理备份
  rmrf(backupSourceDir);
  rmrf(extractDir);
  rmrf(zipPath);

  log(`源码更新完成，新版本: ${version}`);
  return { type: 'source', version };
}

// ========== 重启服务 ==========

function restartServer(log) {
  log('正在重启服务...');
  const child = spawn(process.execPath, [__filename], {
    detached: true,
    stdio: 'inherit'
  });
  child.unref();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

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
  formatSize
};
