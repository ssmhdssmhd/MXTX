/**
 * 超级嗅探 - Node.js 视频解析服务 v2.4.7
 *
 * 版本：v2.4.7
 *
 * 功能概述：
 *   1. 核心解析接口 /node.js：使用 Puppeteer 无头浏览器打开目标视频页面，
 *      通过「网络请求拦截 + 响应体扫描 + 页面内容扫描 + iframe 扫描」四种方式，
 *      提取页面中的 .m3u8 / .mp4 等视频播放地址并返回。
 *   2. 万能嗅探接口 /sniff：内置 18 个第三方解析 PROVIDER，
 *      对同一视频链接并发调用多个解析接口，自动嗅探可用播放地址，
 *      支持 5 种策略（直接正则、JSON 字段、JSONP 回调、嵌套 JSON、流式读取）。
 *   3. 后台管理面板 /admin：在线查看运行状态、解析测试、万能嗅探测试、在线更新等。
 *   4. 后台万能嗅探测试页 /admin/sniff：实时 SSE 进度推送、回退重试、
 *      在线试播、Provider 卡片展示、进度条可视化。
 *   5. 在线更新：支持源码更新 + Chrome 浏览器更新，SSE 流式日志输出。
 *
 * v2.2 关键增强（浏览器池 + 稳定性 + 智能化）：
 *   - MX_BROWSER_ENABLE 开关：默认 true，可按环境关闭 Puppeteer
 *   - 浏览器池并行启动：Promise.allSettled + 自动根据内存降档(D1)
 *   - 浏览器池健康检查：15s 巡检 + 原位复活 + RSS 超阈值主动回收(A3)
 *   - PagePool：每浏览器 5 个 page 预热复用，建页 0ms，单页使用上限+空闲过期(A2)
 *   - 共享拦截器/响应捕获：只注册一次，避免反复配置(A5)
 *   - Provider 动态评分：命中率/成功率/平均延迟持久化 + 熔断机制 + Top10 先跑(C1/C2)
 *   - LRU 缓存持久化：解析/万能嗅探/Provider 评分写入 .mx_cache/，重启热恢复(B2)
 *   - /healthz/{live,ready,startup}：K8s/PM2 三路探针(D3)
 *
 * 性能优化：
 *   - LRU 缓存：解析结果（TTL 1800s/500条）+ 万能嗅探结果（TTL 3600s/200条）
 *   - 浏览器池：BrowserWrapper 类管理多浏览器实例，避免每次启动/关闭
 *   - PagePool：多 Page 复用，消除 150~400ms 建页开销 per 请求
 *   - 信号量并发控制：parseSem（解析并发）+ universalSem（万能嗅探并发）
 *   - 万能嗅探 runWithLimit：限制 Provider 同时请求数量，避免资源耗尽
 *   - 流式读取响应：sniffOne 仅读取前 2MB 文本，避免大响应阻塞
 *   - AbortController：超时/命中后主动 abort 剩余请求
 *   - earlyHits 提前返回：万能嗅探命中 N 个高质量结果后提前结束
 *
 * 万能嗅探说明：
 *   - 内置 18 个常用 PROVIDER 解析接口，自动去重、质量排序
 *   - 支持 JSON/JSONP/正则/嵌套 JSON 等多种响应格式解析
 *   - onProgress 回调实时推送每个 Provider 的进度（pending/ok/fail/skip）
 *   - quality 评分策略：m3u8 > mp4 > 其他，带 4k/1080/720 关键字加分
 *   - dedup 去重：按 URL 去掉重复和子串重复的结果
 *   - detailed 参数：返回详细 Provider 状态而非仅第一个结果
 *   - provider 评分/熔断：失败 3 次自动熔断 30s，Top10 优先调度
 */

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');

const updater = require('./update');

// --- 轻量 .env 自动加载（v2.4.6）---
// .env 不在更新覆盖列表（不在 SOURCE_FILES、被 .gitignore 忽略），
// 因此 MX_PORT / MX_ADMIN_USER / MX_ADMIN_PASS / MX_PLAYER_HOST 等
// 只需在 .env 维护一次，更新源码后无需再手动改默认值。
// 已存在的环境变量优先（不覆盖）。
(function loadEnvFile() {
  try {
    const envFile = path.join(__dirname, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx <= 0) continue;
      const key = t.slice(0, idx).trim();
      let val = t.slice(idx + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) { /* .env 解析失败不阻塞启动 */ }
})();

// ============================================================
// 3. 环境变量辅助函数 + 所有 MX_ 配置变量（含 v2.2 新增 14 项）
// ============================================================
function envStr(key, def) {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? def : String(v);
}
function envBool(key, def) {
  const v = process.env[key];
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).toLowerCase().trim();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return def;
}
function envInt(key, def) {
  const v = process.env[key];
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? def : n;
}

// --- 服务配置 ---
const MX_PORT = envInt('MX_PORT', envInt('PORT', 1314));
const MX_HOST = envStr('MX_HOST', '0.0.0.0');

// --- 运行时端口落盘（v2.4.6）---
// 把实际监听端口写入 .mx_runtime.json，供同机部署的 api.php 自动跟随，
// 无需在 api.php 里手动改端口。
try {
  fs.writeFileSync(path.join(__dirname, '.mx_runtime.json'),
    JSON.stringify({ port: MX_PORT, host: MX_HOST, updatedAt: new Date().toISOString() }, null, 2));
} catch (e) { /* 写失败不阻塞启动 */ }

// --- 后台配置 ---
const MX_ADMIN_USER = envStr('MX_ADMIN_USER', 'admin');
const MX_ADMIN_PASS = envStr('MX_ADMIN_PASS', '');
const MX_ADMIN_AUTH = envBool('MX_ADMIN_AUTH', !!MX_ADMIN_PASS);

// --- 浏览器 & 浏览器池（v2.2 扩展）---
const MX_CHROME_PATH = envStr('MX_CHROME_PATH', envStr('CHROME_PATH',
  path.join(__dirname, 'chrome-linux64', 'chrome')));
const MX_BROWSER_ENABLE = envBool('MX_BROWSER_ENABLE', true);
let MX_BROWSER_POOL_SIZE = envInt('MX_BROWSER_POOL_SIZE', 3);
const MX_BROWSER_ARGS = envStr('MX_BROWSER_ARGS', '').split(',').filter(Boolean);
const MX_BROWSER_WARMUP = envBool('MX_BROWSER_WARMUP', true);
const MX_BROWSER_MAX_MEM_MB = envInt('MX_BROWSER_MAX_MEM_MB', 1200); // D1：单浏览器 RSS 上限（MB）
const MX_BROWSER_HEALTH_INTERVAL = envInt('MX_BROWSER_HEALTH_INTERVAL', 15); // 秒

// --- PagePool（v2.2 新增 A2）---
let MX_PAGE_POOL_SIZE = envInt('MX_PAGE_POOL_SIZE', 5);     // 每浏览器预建 Page 数量
const MX_PAGE_MAX_USE = envInt('MX_PAGE_MAX_USE', 50);      // 单页使用上限后换新
const MX_PAGE_IDLE_TIMEOUT = envInt('MX_PAGE_IDLE_TIMEOUT', 600); // 秒，空闲过期

// --- 嗅探 ---
const MX_PARSE_TIMEOUT = envInt('MX_PARSE_TIMEOUT', envInt('PARSE_TIMEOUT', 30000));
const MX_EXTRA_WAIT = envInt('MX_EXTRA_WAIT', envInt('EXTRA_WAIT', 3000));
const MX_USER_AGENT = envStr('MX_USER_AGENT',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

// --- 缓存（B2 v2.2 扩展持久化）---
const MX_CACHE_MAX = envInt('MX_CACHE_MAX', 500);
const MX_CACHE_TTL = envInt('MX_CACHE_TTL', 1800);
const MX_CACHE_PERSIST = envBool('MX_CACHE_PERSIST', true);
const MX_CACHE_DIR = envStr('MX_CACHE_DIR', path.join(__dirname, '.mx_cache'));
const MX_CACHE_FLUSH_INTERVAL = envInt('MX_CACHE_FLUSH_INTERVAL', 60); // 秒，落盘频率

// --- 并发 ---
const MX_PARSE_CONCURRENCY = envInt('MX_PARSE_CONCURRENCY', 5);
const MX_UNIVERSAL_CONCURRENCY = envInt('MX_UNIVERSAL_CONCURRENCY', 6);
const MX_SNIFF_ONE_TIMEOUT = envInt('MX_SNIFF_ONE_TIMEOUT', 15000);
// 提前命中数：达到 N 家 Provider 命中后停止调度剩余 Provider（提速）。
// v2.4.8 起默认 0 = 不使用提前命中，全部 Provider 都会执行（避免部分接口从未被使用）。
// 需要加速时可设置 MX_UNIVERSAL_EARLY_HITS=3 恢复「命中 N 家即提前返回」。
const MX_UNIVERSAL_EARLY_HITS = envInt('MX_UNIVERSAL_EARLY_HITS', 0);

// --- 出站代理（v2.2 新增）---
// 沙箱/部分服务器出站必须走 HTTP 代理才能访问外网第三方解析接口。
// 默认用 undici 的 EnvHttpProxyAgent：自动读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY，
// 无代理时自动直连，真实部署无需额外配置；也可用 MX_PROXY 显式指定。
const MX_PROXY = envStr('MX_PROXY', '');
const universalDispatcher = MX_PROXY
  ? new EnvHttpProxyAgent({ httpProxy: MX_PROXY, httpsProxy: MX_PROXY })
  : new EnvHttpProxyAgent();

// --- 更新 ---
const MX_AUTO_UPDATE = envBool('MX_AUTO_UPDATE', false);

// --- 万能嗅探（v2.2 新增强化）---
const MX_UNIVERSAL_ENABLE = envBool('MX_UNIVERSAL_ENABLE', true);
const MX_UNIVERSAL_CACHE_MAX = envInt('MX_UNIVERSAL_CACHE_MAX', 200);
const MX_UNIVERSAL_CACHE_TTL = envInt('MX_UNIVERSAL_CACHE_TTL', 3600);
const MX_UNIVERSAL_EMPTY_TTL = envInt('MX_UNIVERSAL_EMPTY_TTL', 60); // v2.4.5：嗅探失败（空结果）的短缓存 TTL（秒）。成功结果仍用 MX_UNIVERSAL_CACHE_TTL；失败结果短缓存，避免 Provider 临时故障被缓存成 1 小时「永久失败」
const MX_UNIVERSAL_DETAILED = envBool('MX_UNIVERSAL_DETAILED', false);
const MX_UNIVERSAL_CIRCUIT_BREAK = envInt('MX_UNIVERSAL_CIRCUIT_BREAK', 3);  // C2：连续失败次数熔断
const MX_UNIVERSAL_CB_COOLDOWN = envInt('MX_UNIVERSAL_CB_COOLDOWN', 30);     // C2：熔断冷却秒数
const MX_UNIVERSAL_PER_PROVIDER_CONC = envInt('MX_UNIVERSAL_PER_PROVIDER_CONC', 2); // 单 provider 并发
const MX_UNIVERSAL_TOPK_FIRST = envInt('MX_UNIVERSAL_TOPK_FIRST', 10);  // C1：TopK 优先调度
const MX_UNIVERSAL_BROWSER_MAX = envInt('MX_UNIVERSAL_BROWSER_MAX', 99); // HTTP 提取不到时，最多用浏览器渲染的 Provider 数（默认远大于 Provider 数=全部可用；真正限流靠 MX_UNIVERSAL_CONCURRENCY 并发与页面池，配额只是兜底安全阀）
const MX_UNIVERSAL_BROWSER_CONC = envInt('MX_UNIVERSAL_BROWSER_CONC', 2); // v2.4.5：万能嗅探「浏览器渲染并发」上限。HTTP 阶段不受限；批量时 18 Provider 全走渲染是内存大头，限制同时渲染数防 OOM 杀进程（单独调用低并发不受影响）
const MX_DEBUG = envBool('MX_DEBUG', false); // 万能嗅探调试日志（HTTP/浏览器每 Provider 输出详细结果）

// ============================================================
// 3.1 低内存自动降级（D1 v2.2 新增，v2.4.5 支持 cgroup 容器内存预算）
// ============================================================
// 容器 / K8s 中 os.totalmem() 返回宿主机内存，不反映本容器可用预算；
// 必须读取 cgroup 内存上限，否则降级失效，批量浏览器渲染时易 OOM 杀进程。
function getCgroupMemLimitMB() {
  try {
    const candidates = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        const n = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (n > 0 && n < Number.MAX_SAFE_INTEGER) return Math.floor(n / 1024 / 1024);
      }
    }
  } catch (e) { }
  return 0;
}
function getCgroupMemUsedMB() {
  try {
    const f = '/sys/fs/cgroup/memory.current';
    if (fs.existsSync(f)) return Math.floor(parseInt(fs.readFileSync(f, 'utf8').trim(), 10) / 1024 / 1024);
  } catch (e) { }
  return 0;
}
// 当前容器内存是否已超预算阈值（默认 85%）：超过则跳过浏览器渲染兜底，防止整进程 OOM
function memoryOverThreshold(ratio) {
  const limitMB = getCgroupMemLimitMB();
  if (limitMB <= 0) return false; // 非容器环境，由系统回收
  const usedMB = getCgroupMemUsedMB();
  if (usedMB <= 0) return false;
  return usedMB > Math.max(64, Math.floor(limitMB * (ratio || 0.85)));
}

(function downgradeByMemory() {
  if (!MX_BROWSER_ENABLE) return;
  const cgroupMB = getCgroupMemLimitMB();
  const hostMB = Math.floor((os.totalmem() || 0) / 1024 / 1024);
  // 可用内存预算取两者较小值（容器场景 cgroup 才是真实约束）
  const totalMB = cgroupMB > 0 ? Math.min(hostMB, cgroupMB) : hostMB;
  if (totalMB <= 0) return;
  const before = { pool: MX_BROWSER_POOL_SIZE, page: MX_PAGE_POOL_SIZE };
  if (totalMB < 1024) {
    MX_BROWSER_POOL_SIZE = Math.min(MX_BROWSER_POOL_SIZE, 1);
    MX_PAGE_POOL_SIZE = Math.min(MX_PAGE_POOL_SIZE, 2);
  } else if (totalMB < 2048) {
    MX_BROWSER_POOL_SIZE = Math.min(MX_BROWSER_POOL_SIZE, 2);
    MX_PAGE_POOL_SIZE = Math.min(MX_PAGE_POOL_SIZE, 3);
  } else if (totalMB < 5 * 1024) {
    // v2.4.5：4GB/4.5GB 级容器（常见 1C/2C 小规格）。3 浏览器×5 页在批量并发渲染下极易 OOM，收紧到 2×3
    MX_BROWSER_POOL_SIZE = Math.min(MX_BROWSER_POOL_SIZE, 2);
    MX_PAGE_POOL_SIZE = Math.min(MX_PAGE_POOL_SIZE, 3);
  }
  const changed = (before.pool !== MX_BROWSER_POOL_SIZE) || (before.page !== MX_PAGE_POOL_SIZE);
  if (changed) {
    console.log(`[超级嗅探] 检测到内存预算 ${totalMB}MB${cgroupMB > 0 ? '（cgroup 限制）' : ''}，自动降级：浏览器池 ${before.pool}→${MX_BROWSER_POOL_SIZE}，PagePool ${before.page}→${MX_PAGE_POOL_SIZE}`);
  }
})();

// --- 缓存持久化目录初始化（B2）---
if (MX_CACHE_PERSIST) {
  try { if (!fs.existsSync(MX_CACHE_DIR)) fs.mkdirSync(MX_CACHE_DIR, { recursive: true }); }
  catch (e) { console.log(`[超级嗅探] 缓存目录创建失败（${MX_CACHE_DIR}）: ${e.message}`); }
}

// 内置 18 个 PROVIDER
const PROVIDERS = [
  'https://jx.xmflv.cc/?url=',
  'https://jx.xmflv.com/?url=',
  'https://im1907.top/?jx=',
  'https://yparse.ik9.cc/index.php?url=',
  'https://www.ckplayer.vip/jiexi/?url=',
  'https://jiexi.789jiexi.icu:4433/?url=',
  'https://www.8090g.cn/?url=',
  'https://www.pangujiexi.com/jiexi/?url=',
  'https://jx.m3u8.tv/jiexi/?url=',
  'https://www.playm3u8.cn/jiexi.php?url=',
  'https://json.ovvo.pro/jx.php?url=',
  'https://api.qianqi.net/vip/?url=',
  'https://jx.yparse.com/index.php?url=',
  'https://www.yemu.xyz/?url=',
  'https://jx.yangtu.top/?url=',
  'https://jx.4kdv.com/?url=',
  'https://www.mtosz.com/m3u8.php?url=',
  'https://jx.playerjy.com/?url='
];

// ============================================================
// 4. 通用工具函数
// ============================================================
const M3U8_REGEX = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;
const MP4_REGEX = /https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g;
const VIDEO_EXT_REGEX = /\.(m3u8|mp4|flv|mkv|avi|mov|wmv|webm|ts)(?![a-z0-9])/i;

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol);
  } catch (e) {
    return false;
  }
}

// 广告/追踪域名黑名单：这些站点只是跳转广告，不是真正的视频源
const AD_HOST_RE = /(\.top|\.bid|vsdrwee|8ovqpaw|f3531|go\.google|doubleclick|adservice|\.cn\.ad|[0-9]+\.top)$/i;

// 接口/静态资源特征：命中这些特征的 URL 不是媒体播放地址（除非路径本身含视频扩展名）
// 例：腾讯视频页面误抓的 https://vip.video.qq.com/rpc/trpc.*.GetNewMsgCount（未读消息接口）
const RPC_URL_RE = /\/rpc\/|\/trpc\/|trpc\.|getnewmsgcount|(\.js|\.json|\.css|\.woff2?|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg)([?#]|$)/i;

// 严格视频 URL 判定：视频扩展名必须出现在 URL 路径（pathname）中，
// 或 query 中内嵌了完整视频地址；避免误抓广告跳转 URL（如 ref 参数里带 m3u8.tv）
function isVideoUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (AD_HOST_RE.test(host)) return false;
    const path = (u.pathname || '').toLowerCase();
    // 路径包含视频扩展名 / m3u8 路径片段（扩展名后必须不是字母数字，避免把 .webm 误匹配成 .webmessageservice 等服务名）
    if (/(\.m3u8|\.mp4|\.flv|\.mkv|\.avi|\.mov|\.wmv|\.webm|\.ts)(?![a-z0-9])|\/m3u8[/?#]|m3u8_[a-z0-9]+/.test(path)) return true;
    // 路径无视频扩展名时，命中接口/静态资源特征直接排除（防止把 RPC 接口当播放地址）
    if (RPC_URL_RE.test(path)) return false;
    // query 中内嵌完整视频地址（如 /api/play?url=https://xxx/index.m3u8）
    const q = decodeURIComponent(u.search || '');
    if (/(https?:\/\/[^&"'<> ]+?\.(m3u8|mp4|flv)(\?|&|$))/i.test(q)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

// 服务自身查询参数名：这些参数是给解析服务用的，不属于目标视频 URL 的查询参数。
// /node.js 与 /sniff 实际消费的参数：url / detailed / refresh / providers。
const SERVICE_QUERY_KEYS = new Set(['url', 'detailed', 'refresh', 'providers']);

/**
 * 解析目标视频 URL（v2.4.6 新增参数合并容错）
 *
 * 背景：客户端若未对 url 参数做 URL 编码（如
 *   /node.js?url=https://m.v.qq.com/x/m/play?cid=xxx&vid=yyy
 * 未编码时 `&vid=yyy` 会被 Express 拆成独立顶层参数，解析器拿到的 URL 丢失 vid 导致 404）。
 *
 * 这里把散落的、不属于服务自身参数的 query 参数合并回 url 的查询串，
 * 恢复完整的视频地址（腾讯 cid&vid、搜狐、爱奇艺等带 & 的平台链接同样受益）。
 */
function resolveVideoUrl(req) {
  let url = (req.query.url || '').trim();
  if (!url || !url.includes('?')) return url;
  const merge = [];
  for (const [k, v] of Object.entries(req.query)) {
    if (SERVICE_QUERY_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    // 值本身是完整 URL（再次内嵌 url=xxx 之类）跳过，避免污染
    if (/^https?:\/\//i.test(String(v))) continue;
    merge.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  }
  if (!merge.length) return url;
  // 已存在于 url 查询串的参数不再重复合并
  const existing = new Set((url.split('?')[1] || '').split('&').map((p) => p.split('=')[0]));
  const add = merge.filter((pair) => !existing.has(pair.split('=')[0]));
  return add.length ? url + '&' + add.join('&') : url;
}

function extractFromText(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  const regex = new RegExp(M3U8_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const u = match[0].replace(/\\\//g, '/');
    if (isVideoUrl(u)) found.add(u);
  }
  const mp4Regex = new RegExp(MP4_REGEX.source, 'g');
  while ((match = mp4Regex.exec(text)) !== null) {
    const u = match[0].replace(/\\\//g, '/');
    if (isVideoUrl(u)) found.add(u);
  }
  return [...found];
}

function isTextResponse(headers) {
  const ct = ((headers && (headers['content-type'] || headers['Content-Type'])) || '').toLowerCase();
  return (
    ct.includes('text/') ||
    ct.includes('json') ||
    ct.includes('mpegurl') ||
    ct.includes('vnd.apple') ||
    ct.includes('x-mpegurl') ||
    ct.includes('javascript') ||
    ct.includes('html') ||
    ct === ''
  );
}

function checkChrome() {
  if (fs.existsSync(MX_CHROME_PATH)) {
    return MX_CHROME_PATH;
  }
  // v2.4.5：配置路径不存在时，回退到 puppeteer 缓存目录里的 Chrome
  // （很多环境通过 puppeteer 安装 Chrome，并未放到项目 chrome-linux64/ 下）
  try {
    if (puppeteer && typeof puppeteer.executablePath === 'function') {
      const p = puppeteer.executablePath();
      if (p && fs.existsSync(p)) return p;
    }
  } catch (e) { }
  return undefined;
}

// ============================================================
// 5. LRUCache 类 + resultCache（v2.2 增强：持久化 + 定时 flush）
// ============================================================
class LRUCache {
  constructor(arg1, arg2) {
    let opts = {};
    if (typeof arg1 === 'object' && arg1 !== null) {
      opts = arg1;
    } else {
      opts.max = arg1;
      opts.ttlMs = arg2;
    }
    this.name = opts.name || '';
    this.persistDir = opts.persistDir || '';
    this.maxSize = opts.max || 500;
    this.ttlMs = opts.ttlMs || 1800000;
    this.map = new Map();
  }
  _isExpired(entry) {
    const ttlMs = (entry && entry.ttlMs) || this.ttlMs;
    return Date.now() - entry.createdAt > ttlMs;
  }
  _evictIfNeeded() {
    while (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }
  set(key, value, ttlMs) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    const entry = { value, createdAt: Date.now() };
    if (ttlMs && ttlMs > 0) entry.ttlMs = ttlMs; // v2.4.5：支持单条目 TTL 覆盖（空结果用短 TTL，避免临时失败被缓存成长期失败）
    this.map.set(key, entry);
    this._evictIfNeeded();
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
  loadFromDisk(filename) {
    try {
      if (!this.persistDir) return;
      const fullPath = path.join(this.persistDir, filename);
      if (!fs.existsSync(fullPath)) return;
      const raw = fs.readFileSync(fullPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (!obj || typeof obj.k === 'undefined') continue;
          const age = Date.now() - (obj.t || 0);
          if (age < 0 || age > this.ttlMs) continue;
          this.map.set(obj.k, { value: obj.v, createdAt: obj.t || Date.now() });
        } catch (e) { }
      }
      this._evictIfNeeded();
    } catch (e) { }
  }
  flushToDisk(filename) {
    try {
      if (!MX_CACHE_PERSIST || !this.persistDir) return;
      const fullPath = path.join(this.persistDir, filename);
      const lines = [];
      for (const [k, entry] of this.map.entries()) {
        lines.push(JSON.stringify({ k, v: entry.value, t: entry.createdAt }));
      }
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf8');
    } catch (e) { }
  }
  static startAutoFlush(caches, intervalSec) {
    if (LRUCache._autoFlushTimer) return LRUCache._autoFlushTimer;
    const intervalMs = Math.max(1, intervalSec || 60) * 1000;
    const timer = setInterval(() => {
      for (const cache of caches) {
        if (!cache || !cache.name) continue;
        cache.flushToDisk(cache.name + '.jsonl');
      }
    }, intervalMs);
    LRUCache._autoFlushTimer = timer;
    return timer;
  }
}

const resultCache = new LRUCache({ name: 'parse', persistDir: MX_CACHE_DIR, max: MX_CACHE_MAX, ttlMs: MX_CACHE_TTL * 1000 });
try { resultCache.loadFromDisk('parse.jsonl'); } catch (e) { }

// ============================================================
// 6. Semaphore 类 + 万能嗅探引擎
// ============================================================
class Semaphore {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  release() {
    this.running--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.running++;
      next();
    }
  }
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const parseSem = new Semaphore(MX_PARSE_CONCURRENCY);

// 4.5 万能嗅探的 LRU 与 Semaphore（v2.2 增强持久化）
const universalCache = new LRUCache({ name: 'universal', persistDir: MX_CACHE_DIR, max: MX_UNIVERSAL_CACHE_MAX, ttlMs: MX_UNIVERSAL_CACHE_TTL * 1000 });
try { universalCache.loadFromDisk('universal.jsonl'); } catch (e) { }
const universalSem = new Semaphore(MX_UNIVERSAL_CONCURRENCY);
// v2.4.5：万能嗅探「浏览器渲染」独立并发信号量。HTTP 阶段（廉价）不受限；
// 只有浏览器渲染兜底（内存大头）被限制并发，批量嗅探时防 OOM 杀进程导致全体失败。
const universalBrowserSem = new Semaphore(Math.max(1, MX_UNIVERSAL_BROWSER_CONC));

// 4.5.1 缓存定时持久化（B2 v2.2）
if (MX_CACHE_PERSIST) {
  const _flushTimer = LRUCache.startAutoFlush([resultCache, universalCache], MX_CACHE_FLUSH_INTERVAL);
  if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

// 4.6 万能嗅探引擎
// 视频扩展名后必须不是字母数字（(?![a-z0-9])），防止 .webm 误匹配 .webmessageservice 等服务名而把 RPC 接口当播放地址
const VIDEO_URL_REGEX = /https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv|mkv|avi|mov|wmv|webm|ts)(?![a-z0-9])[^\s"'<>\\]*/ig;

function extractVideoUrls(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  const regex = new RegExp(VIDEO_URL_REGEX.source, 'ig');
  let match;
  while ((match = regex.exec(text)) !== null) {
    let url = match[0].replace(/\\\//g, '/');
    url = url.replace(/[,.，。、；;]+$/g, '');
    if (isValidUrl(url) && isVideoUrl(url)) {
      found.add(url);
    }
  }
  return [...found];
}

function walkJsonForVideoUrls(obj, out) {
  if (!out) out = new Set();
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string') {
    if (isValidUrl(obj) && isVideoUrl(obj)) {
      out.add(obj);
    }
    extractVideoUrls(obj).forEach((u) => out.add(u));
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item) => walkJsonForVideoUrls(item, out));
    return out;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = String(k).toLowerCase();
      if (typeof v === 'string' && (key.includes('url') || key.includes('src') || key.includes('play') || key.includes('video') || key.includes('m3u8') || key.includes('mp4'))) {
        if (isValidUrl(v) && isVideoUrl(v)) {
          out.add(v);
        }
        extractVideoUrls(v).forEach((u) => out.add(u));
      }
      walkJsonForVideoUrls(v, out);
    }
  }
  return out;
}

// 硬超时包装：即使底层 Promise 永不 resolve/reject（如 undici abort 失效），也能按时返回兜底值
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), Math.max(1, ms));
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); }
    );
  });
}

// 浏览器渲染兜底配额：HTTP 提取不到时，最多对前 N 个 Provider 用浏览器渲染（防止并发过载）
let universalBrowserBudget = Math.max(0, MX_UNIVERSAL_BROWSER_MAX);

async function sniffOne(provider, targetUrl, options) {
  const timeout = (options && options.timeout) || MX_SNIFF_ONE_TIMEOUT;
  const fullUrl = provider + encodeURIComponent(targetUrl);
  // 外层硬超时，防止某个 Provider 请求卡死拖垮整个嗅探。
  // 关键：硬超时必须给“浏览器渲染兜底”留足余量——
  // HTTP 阶段若吃满 timeout（15s 后 abort），浏览器阶段还需 page.goto + 网络捕获（约 20~25s），
  // 若硬超时只 +3000ms，浏览器兜底会在 page.goto 尚未完成时被掐断，导致 im1907.top 等 Provider 永远进不了渲染兜底。
  const browserExtra = (MX_BROWSER_ENABLE && browserPool.length > 0) ? 25000 : 3000;
  const urls = await withTimeout(doSniffOne(fullUrl, targetUrl, timeout), timeout + browserExtra, []);
  // 失败原因标记：doSniffOne 内部已带 _reason（http-error/no-match/render-no-match 等），
  // 若为 null 且无结果 → 说明整体超时
  if (!urls._reason) urls._reason = urls.length > 0 ? 'ok' : 'timeout';
  return urls;
}

async function doSniffOne(fullUrl, targetUrl, timeout) {
  // 1) HTTP 快速阶段：直接抓取接口页面，提取静态可见的视频地址
  const httpUrls = await httpSniff(fullUrl, targetUrl, timeout);
  if (httpUrls.length > 0) { httpUrls._reason = 'http'; return httpUrls; }
  // 记录 HTTP 阶段失败原因（http-error / not-text / no-match）
  const httpReason = httpUrls._reason || 'no-match';

  // 2) 浏览器渲染兜底：JS / iframe 型接口（如 playm3u8.cn 嵌套播放器）需真实渲染并捕获 m3u8 网络响应
  if (MX_DEBUG) console.log(`[嗅探][决策] ${fullUrl} HTTP 无命中 -> 浏览器兜底? 浏览器=${MX_BROWSER_ENABLE && browserPool.length > 0} 剩余配额=${universalBrowserBudget}`);
  // v2.4.5：容器内存预算超 85% 时跳过浏览器渲染，宁缺毋滥——避免整进程 OOM 被杀导致批量全部失败
  if (MX_BROWSER_ENABLE && browserPool.length > 0 && universalBrowserBudget > 0 && !memoryOverThreshold(0.85)) {
    universalBrowserBudget--;
    // v2.4.5：浏览器渲染并发限流（仅万能嗅探路径，主解析路径不受影响）：
    // 最多 MX_UNIVERSAL_BROWSER_CONC 个同时渲染；等待额度最多 timeout 上限内，拿不到就快速放弃
    const urls = await withTimeout(
      universalBrowserSem.run(() => browserSniff(fullUrl, targetUrl, timeout)),
      Math.max(1000, Math.min(timeout, 8000)),
      []
    );
    if (urls.length > 0) { urls._reason = 'render'; return urls; }
    const no = [];
    no._reason = urls._reason || 'render-no-match';
    return no;
  }
  const noBrowser = [];
  noBrowser._reason = httpReason;
  return noBrowser;
}

// HTTP 阶段：带代理抓取 + 手动重定向 + 文本/JSON 提取
async function httpSniff(fullUrl, targetUrl, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const MAX_BYTES = 2 * 1024 * 1024;

  // 从响应文本中提取候选视频地址（正则 + JSON / JSONP / JSON 数组）
  function parseUrlsFromText(raw) {
    const urls = new Set();
    if (!raw || typeof raw !== 'string') return [...urls];
    extractVideoUrls(raw).forEach((u) => urls.add(u));
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const json = JSON.parse(jsonMatch[0]);
        walkJsonForVideoUrls(json, urls);
      }
    } catch (e) { }
    try {
      const jsonpMatch = raw.match(/[\w$]+\s*\(\s*(\{[\s\S]*?\})\s*\)/);
      if (jsonpMatch) {
        const json = JSON.parse(jsonpMatch[1]);
        walkJsonForVideoUrls(json, urls);
      }
    } catch (e) { }
    try {
      const jsonArrMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonArrMatch) {
        const arr = JSON.parse(jsonArrMatch[0]);
        walkJsonForVideoUrls(arr, urls);
      }
    } catch (e) { }
    return [...urls];
  }

  // 带代理的 fetch，手动跟随重定向（最多 5 跳），视频直链立即返回
  const doFetch = async (url, depth) => {
    const res = await undiciFetch(url, {
      dispatcher: universalDispatcher,
      signal: controller.signal,
      headers: {
        'User-Agent': MX_USER_AGENT,
        'Accept': '*/*',
        'Referer': targetUrl
      },
      redirect: 'manual'
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const loc = res.headers.get('location');
      const abs = new URL(loc, url).href;
      if (res.body && res.body.cancel) { try { await res.body.cancel(); } catch (e) { } }
      if (VIDEO_EXT_REGEX.test(loc)) {
        return { urls: [abs] };
      }
      if (depth < 5) {
        return doFetch(abs, depth + 1);
      }
      return { urls: [] };
    }
    if (!isTextResponse({ 'content-type': res.headers.get('content-type') || '' })) {
      if (res.body && res.body.cancel) { try { await res.body.cancel(); } catch (e) { } }
      return { urls: [], notText: true };
    }
    // 流式读取响应体并限制大小
    const reader = res.body ? res.body.getReader() : null;
    let raw = '';
    let bytes = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BYTES) { await reader.cancel(); break; }
        raw += Buffer.from(value).toString('utf8');
      }
    } else {
      raw = await res.text();
    }
    return { urls: parseUrlsFromText(raw), rawLen: raw.length };
  };

  try {
    const result = await doFetch(fullUrl, 0);
    if (MX_DEBUG) console.log(`[嗅探][HTTP] ${fullUrl} -> ${result.urls.length} 个URL（body ${result.rawLen || 0}B）`);
    const urls = result.urls;
    if (urls.length === 0 && result.notText) urls._reason = 'not-text';
    return urls;
  } catch (err) {
    if (MX_DEBUG) console.log(`[嗅探][HTTP] ${fullUrl} 失败: ${err.message}`);
    const empty = [];
    empty._reason = 'http-error';
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

// 浏览器渲染阶段：真实渲染接口页，捕获 .m3u8 网络响应 + 页面/iframe 文本提取
async function browserSniff(fullUrl, targetUrl, timeout) {
  let bw = null;
  let holder = null;
  try {
    if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} 开始：获取页面…`);
    const acquired = await acquirePageWrapper();
    bw = acquired.bw;
    holder = acquired.holder;
    const page = holder.page;
    if (holder._hits) holder._hits.clear();
    if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} 已获取页面`);

    await page.setUserAgent(MX_USER_AGENT);
    await page.setViewport({ width: 1280, height: 720 });

    try {
      if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} 开始 page.goto…`);
      await page.goto(fullUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, MX_PARSE_TIMEOUT)
      });
      if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} page.goto 完成`);
    } catch (e) { if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} page.goto 失败: ${e.message}`); }

    // 给 JS 播放器时间发起 m3u8 请求：轮询网络捕获，命中即提前返回；最多等 waitCap
    const waitCap = Math.min(Math.max(MX_EXTRA_WAIT, 4000), timeout, 10000);
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitCap) {
      if (holder._hits && holder._hits.size > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const urls = new Set();
    try {
      const content = await page.content();
      extractFromText(content).forEach((u) => urls.add(u));
      extractVideoUrls(content).forEach((u) => urls.add(u));
      if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} page.content ${content.length}B -> 文本提取 ${extractFromText(content).length + extractVideoUrls(content).length} 个URL`);
    } catch (e) { }
    for (const frame of page.frames()) {
      try {
        const frameContent = await frame.content();
        extractFromText(frameContent).forEach((u) => urls.add(u));
        extractVideoUrls(frameContent).forEach((u) => urls.add(u));
        if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} iframe ${frame.url()} -> ${extractFromText(frameContent).length + extractVideoUrls(frameContent).length} 个URL`);
      } catch (e) { }
    }
    if (holder._hits) for (const u of holder._hits) urls.add(u);
    if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} 网络捕获 m3u8 ${holder._hits ? holder._hits.size : 0} 个，共 ${urls.size} 个URL`);

    return [...urls];
  } catch (e) {
    if (MX_DEBUG) console.log(`[嗅探][浏览器] ${fullUrl} 早期异常: ${e.message}`);
    const empty = [];
    empty._reason = 'render-error';
    return empty;
  } finally {
    if (bw && holder) {
      try { await bw.releasePage(holder); } catch (e) { }
    }
  }
}

async function runWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  const workers = [];
  const worker = async () => {
    while (true) {
      const cur = idx++;
      if (cur >= tasks.length) return;
      try {
        results[cur] = await tasks[cur]();
      } catch (e) {
        results[cur] = null;
      }
    }
  };
  for (let i = 0; i < Math.min(limit, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function qualityScore(url) {
  let score = 0;
  const u = String(url || '').toLowerCase();
  if (u.includes('.m3u8')) score += 10;
  else if (u.includes('.mp4')) score += 8;
  else if (u.includes('.flv')) score += 5;
  else if (u.includes('.ts')) score += 4;
  else score += 1;
  if (u.includes('4k') || u.includes('2160')) score += 5;
  if (u.includes('1080') || u.includes('hd')) score += 3;
  if (u.includes('720')) score += 2;
  if (u.includes('360') || u.includes('480')) score -= 1;
  if (u.includes('ad') || u.includes('advert')) score -= 3;
  return score;
}

function dedupResults(urls) {
  const unique = [];
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) continue;
    let dup = false;
    for (const u of unique) {
      if (u.includes(url) || url.includes(u)) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      seen.add(url);
      unique.push(url);
    }
  }
  return unique;
}

async function runUniversalSniff(targetUrl, options) {
  const opts = options || {};
  // 每次请求重置浏览器渲染兜底配额：HTTP 提取不到时，本请求内最多 N 个 Provider 走浏览器渲染（防过载）
  universalBrowserBudget = Math.max(0, MX_UNIVERSAL_BROWSER_MAX);
  const onProgress = opts.onProgress || (() => {});
  const earlyHits = opts.earlyHits != null ? opts.earlyHits : MX_UNIVERSAL_EARLY_HITS;
  // 平台感知记忆：提取目标平台 key，排序优先该平台历史成功的 Provider
  const domain = getDomainKey(targetUrl);
  let providers;
  if (opts.providers) {
    providers = opts.providers;
  } else {
    const { top, tail } = splitProvidersTopKFor(domain);
    providers = [...top, ...tail];
  }

  const allUrls = new Set();
  const providerResults = [];
  let doneCount = 0;
  let finishedCount = 0;
  const total = providers.length;
  let hitCount = 0;
  let aborted = false;

  const tasks = providers.map((provider, i) => async () => {
    if (aborted) {
      providerResults[i] = { provider, status: 'skip', urls: [] };
      onProgress({
        index: i,
        provider,
        status: 'skip',
        count: 0,
        done: ++doneCount,
        total,
        hits: hitCount
      });
      return;
    }
    if (isProviderCircuitBroken(provider)) {
      providerResults[i] = { provider, status: 'skip', urls: [] };
      onProgress({
        index: i,
        provider,
        status: 'skip',
        count: 0,
        done: ++doneCount,
        total,
        hits: hitCount
      });
      return;
    }
    onProgress({
      index: i,
      provider,
      status: 'pending',
      count: 0,
      done: doneCount,
      total,
      hits: hitCount
    });
    const startTs = Date.now();
    try {
      const urls = await sniffOne(provider, targetUrl, opts);
      const validUrls = urls.filter(isValidUrl);
      validUrls.forEach((u) => allUrls.add(u));
      if (validUrls.length > 0) hitCount++;
      const diff = Date.now() - startTs;
      recordProviderResult(provider, {
        ok: validUrls.length > 0,
        hitCount: validUrls.length,
        latencyMs: diff,
        domain,
        reason: urls._reason || (validUrls.length > 0 ? 'ok' : 'empty')
      });
      finishedCount++;
      if (finishedCount % 10 === 0) {
        (async () => { try { saveProviderStats(); } catch (e) { } })();
      }
      providerResults[i] = { provider, status: validUrls.length > 0 ? 'ok' : 'fail', urls: validUrls };
      onProgress({
        index: i,
        provider,
        status: validUrls.length > 0 ? 'ok' : 'fail',
        count: validUrls.length,
        urls: validUrls,
        done: ++doneCount,
        total,
        hits: hitCount
      });
      if (earlyHits > 0 && hitCount >= earlyHits) {
        aborted = true;
      }
    } catch (e) {
      const diff = Date.now() - startTs;
      recordProviderResult(provider, { ok: false, hitCount: 0, latencyMs: diff, domain, reason: 'exception' });
      finishedCount++;
      if (finishedCount % 10 === 0) {
        (async () => { try { saveProviderStats(); } catch (e) { } })();
      }
      providerResults[i] = { provider, status: 'fail', urls: [], error: e.message };
      onProgress({
        index: i,
        provider,
        status: 'fail',
        count: 0,
        urls: [],
        done: ++doneCount,
        total,
        hits: hitCount,
        error: e.message
      });
    }
  });

  try {
    await runWithLimit(tasks, MX_UNIVERSAL_CONCURRENCY);
  } finally {
    (async () => { try { saveProviderStats(); } catch (e) { } })();
  }

  const sortedUrls = [...allUrls].sort((a, b) => qualityScore(b) - qualityScore(a));
  const finalUrls = dedupResults(sortedUrls);

  return {
    urls: finalUrls,
    providers: providerResults,
    totalProviders: total,
    hitProviders: hitCount,
    totalUrls: finalUrls.length
  };
}

// ============================================================
// 6.5 Provider 动态评分 & 熔断（C1/C2 v2.2 新增）
// ============================================================
const providerStats = new Map();

function loadProviderStats() {
  try {
    if (!MX_CACHE_PERSIST) return;
    const fullPath = path.join(MX_CACHE_DIR, 'provider-score.json');
    if (!fs.existsSync(fullPath)) return;
    const raw = fs.readFileSync(fullPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item || !item.provider) continue;
      providerStats.set(item.provider, {
        ok: item.ok || 0,
        fail: item.fail || 0,
        hits: item.hits || 0,
        totalLat: item.totalLat || 0,
        lastFailStreak: item.lastFailStreak || 0,
        circuitUntil: item.circuitUntil || 0,
        lastTs: item.lastTs || 0,
        byDomain: item.byDomain || {},
        failReasons: item.failReasons || {},
        lastFailReason: item.lastFailReason || ''
      });
    }
  } catch (e) { }
}

function saveProviderStats() {
  try {
    if (!MX_CACHE_PERSIST) return;
    const fullPath = path.join(MX_CACHE_DIR, 'provider-score.json');
    const arr = [];
    for (const [provider, s] of providerStats.entries()) {
      arr.push({ provider, ...s });
    }
    fs.writeFileSync(fullPath, JSON.stringify(arr), 'utf8');
  } catch (e) { }
}

function recordProviderResult(provider, opts) {
  const latencyMs = (opts && opts.latencyMs) || 0;
  const hitCount = (opts && opts.hitCount) || 0;
  const ok = !!(opts && opts.ok);
  const domain = (opts && opts.domain) || 'generic';
  const reason = (opts && opts.reason) || (ok ? 'ok' : 'empty');

  let s = providerStats.get(provider);
  if (!s) {
    s = { ok: 0, fail: 0, hits: 0, totalLat: 0, lastFailStreak: 0, circuitUntil: 0, lastTs: 0, byDomain: {}, failReasons: {} };
    providerStats.set(provider, s);
  }
  s.lastTs = Date.now();
  s.totalLat += Math.max(0, latencyMs);
  if (ok) {
    s.ok++;
    s.hits += Math.max(0, hitCount);
    s.lastFailStreak = 0;
  } else {
    s.fail++;
    s.lastFailStreak++;
    // 失败原因记忆（用于分析：超时 / 网络错误 / 未命中 / 渲染失败 等）
    s.lastFailReason = reason;
    s.failReasons = s.failReasons || {};
    s.failReasons[reason] = (s.failReasons[reason] || 0) + 1;
    if (MX_UNIVERSAL_CIRCUIT_BREAK > 0 && s.lastFailStreak >= MX_UNIVERSAL_CIRCUIT_BREAK) {
      s.circuitUntil = Date.now() + Math.max(1, MX_UNIVERSAL_CB_COOLDOWN) * 1000;
    }
  }
  // 平台记忆：按目标平台域名分桶，供「平台记忆排序」使用
  if (!s.byDomain) s.byDomain = {};
  let d = s.byDomain[domain];
  if (!d) { d = { ok: 0, fail: 0, hits: 0, totalLat: 0, lastFailStreak: 0 }; s.byDomain[domain] = d; }
  d.lastTs = Date.now();
  d.totalLat += Math.max(0, latencyMs);
  if (ok) { d.ok++; d.hits += Math.max(0, hitCount); d.lastFailStreak = 0; }
  else { d.fail++; d.lastFailStreak++; }
  try { saveProviderStats(); } catch (e) { }
}

function isProviderCircuitBroken(provider) {
  const s = providerStats.get(provider);
  if (!s) return false;
  if (!s.circuitUntil) return false;
  if (Date.now() >= s.circuitUntil) {
    s.circuitUntil = 0;
    s.lastFailStreak = 0;
    return false;
  }
  return true;
}

function providerScore(provider) {
  const s = providerStats.get(provider) || { ok: 0, fail: 0, hits: 0, totalLat: 0 };
  const total = s.ok + s.fail;
  const successRate = total > 0 ? s.ok / total : 0.5;
  const hitRate = s.ok > 0 ? s.hits / s.ok : 0;
  const avgLat = total > 0 ? s.totalLat / total : 1000;
  return successRate * 1000 + hitRate * 500 - avgLat / 30;
}

function rankedProviders() {
  const normal = [];
  const broken = [];
  for (const p of PROVIDERS) {
    const score = providerScore(p);
    const b = isProviderCircuitBroken(p);
    if (b) broken.push({ p, score });
    else normal.push({ p, score });
  }
  normal.sort((a, b) => b.score - a.score);
  broken.sort((a, b) => b.score - a.score);
  // 返回纯字符串（v2.4.9 修复：new String() 会导致 Map 键身份不一致，记忆/熔断数据无法复用）
  return [...normal, ...broken].map((e) => e.p);
}

function splitProvidersTopK() {
  const k = Math.max(1, MX_UNIVERSAL_TOPK_FIRST || 10);
  const ranked = rankedProviders();
  const top = [];
  const tail = [];
  for (const p of ranked) {
    if (top.length < k && !isProviderCircuitBroken(p)) top.push(p);
    else tail.push(p);
  }
  return { top, tail };
}

// ============================================================
// 6.6 平台感知记忆（v2.4.9 新增）
//    按目标平台域名记忆 Provider 成功率，排序时优先该平台历史成功 Provider，
//    分析各 Provider 失败原因并生成规则表 → 提高命中率、保证成功。
// ============================================================
const PLATFORM_NAMES = {
  qq: '腾讯', bili: 'B站', sohu: '搜狐', youku: '优酷', iqiyi: '爱奇艺',
  mgtv: '芒果TV', douyin: '抖音', m3u8: 'm3u8直链', generic: '其他平台'
};
const PLATFORM_KEYS = Object.keys(PLATFORM_NAMES);

// 从目标视频 URL 提取平台 key（识别失败统一归为 generic，不影响排序）
function getDomainKey(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)v\.qq\.com$/.test(host) || /(^|\.)qq\.com$/.test(host)) return 'qq';
    if (/(^|\.)bilibili\.com$/.test(host) || /(^|\.)b23\.tv$/.test(host)) return 'bili';
    if (/(^|\.)sohu\.com$/.test(host)) return 'sohu';
    if (/(^|\.)youku\.com$/.test(host)) return 'youku';
    if (/(^|\.)iqiyi\.com$/.test(host)) return 'iqiyi';
    if (/(^|\.)mgtv\.com$/.test(host)) return 'mgtv';
    if (/(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host)) return 'douyin';
    if (/(^|\.)m3u8\.(tv|cc)$/.test(host)) return 'm3u8';
    return 'generic';
  } catch (e) { return 'generic'; }
}

function getDomainStats(s, domain) {
  if (!s) return null;
  return (s.byDomain && s.byDomain[domain]) || null;
}

// 平台感知评分：该平台样本 >=2 时以平台记忆为准（成功率高权重），否则回退全局评分
function providerScoreFor(provider, domain) {
  const s = providerStats.get(provider);
  const globalScore = providerScore(provider);
  const d = s ? getDomainStats(s, domain) : null;
  if (d && d.ok + d.fail >= 2) {
    const total = d.ok + d.fail;
    const successRate = d.ok / total;
    const avgLat = total > 0 ? d.totalLat / total : 1000;
    return successRate * 2000 + d.hits * 50 - avgLat / 30 + globalScore / 1000;
  }
  return globalScore;
}

// 弱项规则：该平台从未成功且失败 >= 阈值 → 排到最后（仍执行，但不再抢占前序）
function isDomainWeak(provider, domain, threshold) {
  const d = getDomainStats(providerStats.get(provider), domain);
  if (!d) return false;
  return d.ok === 0 && d.fail >= (threshold || 3);
}

// 按平台记忆排序：成功记忆优先，弱项次之，熔断最后
function rankedProvidersFor(domain) {
  const normal = [];
  const weak = [];
  const broken = [];
  for (const p of PROVIDERS) {
    const score = providerScoreFor(p, domain);
    const b = isProviderCircuitBroken(p);
    const w = isDomainWeak(p, domain, 3);
    if (b) broken.push({ p, score });
    else if (w) weak.push({ p, score });
    else normal.push({ p, score });
  }
  const byScore = (a, b) => b.score - a.score;
  normal.sort(byScore);
  weak.sort(byScore);
  broken.sort(byScore);
  // 返回纯字符串（v2.4.9 修复：new String() 会导致 Map 键身份不一致，记忆数据无法复用）
  return [...normal, ...weak, ...broken].map((e) => e.p);
}

// 平台感知 TopK：TopK 先跑（该平台历史最可能成功的 Provider），其余补跑
function splitProvidersTopKFor(domain) {
  const k = Math.max(1, MX_UNIVERSAL_TOPK_FIRST || 10);
  const ranked = rankedProvidersFor(domain);
  const top = [];
  const tail = [];
  for (const entry of ranked) {
    if (top.length < k) top.push(entry);
    else tail.push(entry);
  }
  return { top, tail };
}

// 生成规则表（分析接口用）：每个平台 Provider 的记忆排序 + 推荐/备用/弱项/熔断 + 失败原因
function buildPlatformRules() {
  const rules = {};
  for (const domain of PLATFORM_KEYS) {
    const list = rankedProvidersFor(domain).map((p) => {
      const s = providerStats.get(p) || {};
      const d = getDomainStats(s, domain);
      let level = 'backup';
      if (d && d.ok > 0) level = 'recommended';
      if (isProviderCircuitBroken(p)) level = 'broken';
      else if (d && d.ok === 0 && d.fail >= 3) level = 'weak';
      return {
        provider: String(p),
        level,
        platformOk: d ? d.ok : 0,
        platformFail: d ? d.fail : 0,
        globalOk: s.ok || 0,
        globalFail: s.fail || 0,
        score: Math.round(providerScoreFor(p, domain)),
        lastFailReason: s.lastFailReason || '',
        failReasons: s.failReasons || {}
      };
    });
    rules[domain] = {
      name: PLATFORM_NAMES[domain],
      recommended: list.filter((x) => x.level === 'recommended').length,
      list
    };
  }
  return rules;
}

try { loadProviderStats(); } catch (e) { }

// ============================================================
// 7. BrowserWrapper 类 + 浏览器池 + PagePool（v2.2 升级）
//    A1：MX_BROWSER_ENABLE 开关 + 并行启动
//    A3：15s 健康检查 + RSS 超阈值回收 + 原位复活
//    A2：每浏览器 PagePool + acquirePage/releasePage
//    A5：共享拦截器 + response m3u8 捕获
// ============================================================
// 全局共享黑名单（图片/字体/广告），复用避免重复注册（A5）
// 全局请求拦截：只拦截图片/字体/媒体等纯静态资源以提速。
// 注意：不能拦 .css —— 很多接口页（如 im1907.top）在 css 加载失败时会触发 onerror=alert()，
// 弹出模态对话框阻塞页面加载，导致 domcontentloaded 永远不触发、page.goto 超时。
const GLOBAL_BLOCK_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|mp3|wav|flac|aac)(\?|$)/i;
const GLOBAL_BLOCK_HOST_RE = /(google-analytics|googletagmanager|doubleclick|adservice|scorecardresearch|facebook|disqus)\./i;

function getProcessRssMB(pid) {
  try {
    if (!pid) return 0;
    // Linux: /proc/<pid>/status VmRSS 最准
    const f = `/proc/${pid}/status`;
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const m = raw.match(/VmRSS:\s*(\d+)\s*kB/i);
      if (m) return Math.floor(parseInt(m[1], 10) / 1024);
    }
    // 兜底：process.memoryUsage() 只能拿到 Node 自己，对 Chromium 子进程不准，所以返回 0
    return 0;
  } catch (e) { return 0; }
}

class PageHolder {
  constructor(page, browserWrapper) {
    this.page = page;
    this.bw = browserWrapper;
    this.useCount = 0;
    this.lastUsed = Date.now();
    this.status = 'idle'; // idle / busy
    this.dead = false;
    this._attached = false;
    this._hits = new Set(); // 本页面捕获到的视频地址（按页隔离，避免同浏览器多页并发时互相清空）
  }
  async ensureAttachSharedHandlers() {  // A5
    if (this._attached) return;
    const p = this.page;
    try {
      await p.setRequestInterception(true);
    } catch (e) {}
    p.on('request', (req) => {
      const url = req.url();
      if (!/^https?:/i.test(url)) { try { req.abort(); } catch(e){} return; }
      if (GLOBAL_BLOCK_RE.test(url) || GLOBAL_BLOCK_HOST_RE.test(url)) { try { req.abort(); } catch(e){} return; }
      try { req.continue(); } catch(e){}
    });
    // 自动关闭 JS 对话框：很多接口页会在资源加载失败时弹 alert()/confirm()，
    // 不处理会阻塞页面 JS 主线程，导致 domcontentloaded 迟迟不触发。
    p.on('dialog', (d) => { try { d.dismiss(); } catch(e){} });
    p.on('response', async (resp) => {
      try {
        const ct = (resp.headers() && (resp.headers()['content-type'] || '')) || '';
        const url = resp.url();
        if (/\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(ct)) {
          if (!this._hits) this._hits = new Set();
          this._hits.add(url);
          return;
        }
        // API / JSON 接口响应：读取 body 提取其中内嵌的视频地址（如 xmflv 的 /Api 返回 JSON）
        if (/json|javascript|text\//i.test(ct) && /(api|json|play|video|url|jx|hls)/i.test(url)) {
          try {
            const body = await resp.text();
            const found = extractVideoUrls(body);
            for (const u of found) {
              if (!this._hits) this._hits = new Set();
              this._hits.add(u);
            }
          } catch (e) {}
        }
      } catch (e) {}
    });
    this._attached = true;
  }
  async touch() {
    this.useCount++;
    this.lastUsed = Date.now();
    if (this.useCount === 1) await this.ensureAttachSharedHandlers();
  }
  expiredNow() {
    if (this.dead) return true;
    if (MX_PAGE_MAX_USE > 0 && this.useCount >= MX_PAGE_MAX_USE) return true;
    if (MX_PAGE_IDLE_TIMEOUT > 0 && this.status === 'idle' && (Date.now() - this.lastUsed) > MX_PAGE_IDLE_TIMEOUT * 1000) return true;
    return false;
  }
  async safeClose() {
    if (this.dead) return;
    this.dead = true;
    try { await this.page.close(); } catch(e){}
  }
}

class BrowserWrapper {
  constructor(executablePath) {
    this.executablePath = executablePath;
    this.browser = null;
    this.lastUsed = 0;
    this.ready = false;
    this.pagePool = []; // PageHolder[]
    this._pid = 0;
    this._hits = new Set();
    this._warmupDone = false;
    this._userDataDir = '';
  }
  async launch() {
    const idStr = Math.random().toString(36).slice(2, 8);
    this._userDataDir = path.join(os.tmpdir(), `mx-chrome-${process.pid}-${idStr}`);
    try { fs.mkdirSync(this._userDataDir, { recursive: true }); } catch(e){}
    const defaultArgs = [
      `--user-data-dir=${this._userDataDir}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-accelerated-2d-canvas',
      '--max-old-space-size=1024',
      '--disable-extensions',
      '--window-size=1280,720'
    ];
    // 若存在出站代理，让浏览器流量也走代理（MX_PROXY 优先，其次系统 HTTPS_PROXY/HTTP_PROXY）
    const proxyAddr = MX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    if (proxyAddr) defaultArgs.push(`--proxy-server=${proxyAddr}`);
    const args = [...defaultArgs, ...MX_BROWSER_ARGS];
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args
    });
    const proc = this.browser.process();
    this._pid = proc ? proc.pid : 0;
    this.browser.on('disconnected', () => {
      this.ready = false;
    });
    this.ready = true;
  }
  async initPagePool() {
    if (!this.ready) return;
    const need = Math.max(0, MX_PAGE_POOL_SIZE - this.pagePool.length);
    for (let i = 0; i < need; i++) {
      try {
        const p = await this.browser.newPage();
        const holder = new PageHolder(p, this);
        this.pagePool.push(holder);
      } catch (e) {
        console.log(`[超级嗅探] PagePool 预启动失败: ${e.message}`);
      }
    }
    if (MX_BROWSER_WARMUP) {
      for (const h of this.pagePool) {
        try { await h.ensureAttachSharedHandlers(); await h.page.goto('about:blank', { timeout: 5000, waitUntil: 'domcontentloaded' }); }
        catch (e) {}
      }
      this._warmupDone = true;
    }
  }
  _reclaimExpiredPages() {
    const kept = [];
    for (const h of this.pagePool) {
      if (h.status === 'busy') { kept.push(h); continue; }
      if (h.expiredNow()) { h.safeClose().catch(()=>{}); continue; }
      kept.push(h);
    }
    this.pagePool = kept;
  }
  async acquirePage() {
    if (!this.ready) await this.launch();
    this._reclaimExpiredPages();
    // 优先 idle
    for (const h of this.pagePool) {
      if (h.status === 'idle' && !h.dead) {
        h.status = 'busy';
        await h.touch();
        return h;
      }
    }
    // 不足，按需新建一个 page
    try {
      const p = await this.browser.newPage();
      const holder = new PageHolder(p, this);
      holder.status = 'busy';
      this.pagePool.push(holder);
      await holder.touch();
      return holder;
    } catch (e) {
      // 浏览器可能挂了
      this.ready = false;
      throw e;
    }
  }
  async releasePage(holder) {
    if (!holder) return;
    holder.status = 'idle';
    holder.lastUsed = Date.now();
    // 清理副作用：about:blank 清理内存 + 清 cookies
    if (!holder.dead) {
      try {
        const client = holder.page.isClosed && holder.page.isClosed();
        if (client) { holder.dead = true; return; }
        await holder.page.goto('about:blank', { timeout: 3000, waitUntil: 'domcontentloaded' }).catch(()=>{});
        const c = await holder.page.cookies().catch(()=>[]);
        if (c && c.length) try { await holder.page.deleteCookie(...c); } catch(e){}
      } catch (e) {}
    }
    this.lastUsed = Date.now();
  }
  async newPage() {
    // 兼容老 API（绕过 PagePool）
    if (!this.browser || !this.ready) await this.launch();
    this.lastUsed = Date.now();
    return await this.browser.newPage();
  }
  async close() {
    for (const h of (this.pagePool || [])) await h.safeClose();
    this.pagePool = [];
    if (this.browser) {
      try { await this.browser.close(); } catch (e) { }
      this.browser = null;
      this.ready = false;
    }
    if (this._userDataDir) {
      try { if (fs.existsSync(this._userDataDir)) fs.rmSync(this._userDataDir, { recursive: true, force: true }); }
      catch(e){}
    }
  }
  isAlive() {
    if (!this.ready || !this.browser) return false;
    const proc = this.browser.process();
    if (proc == null) return false;
    try {
      process.kill(proc.pid, 0);
    } catch (e) { return false; }
    return true;
  }
  memoryMB() { return getProcessRssMB(this._pid); }
}

let browserPool = [];
let browserPoolIndex = 0;
let browserHealthTimer = null;

function browserPoolStats() {
  let pagesTotal = 0, pagesBusy = 0;
  for (const bw of browserPool) {
    for (const h of (bw.pagePool || [])) {
      pagesTotal++;
      if (h.status === 'busy') pagesBusy++;
    }
  }
  return { browsers: browserPool.length, pagesTotal, pagesBusy };
}

async function initBrowserPool() {
  if (!MX_BROWSER_ENABLE) {
    console.log('[超级嗅探] MX_BROWSER_ENABLE=false，跳过浏览器池启动（万能嗅探正常工作）');
    return;
  }
  const executablePath = checkChrome();
  if (!executablePath) {
    console.log('[超级嗅探] 未找到 Chrome 可执行文件，浏览器池启动跳过（万能嗅探 HTTP 模式可用）。可设置 MX_CHROME_PATH 指向 chrome 可执行文件');
    return;
  }
  const size = MX_BROWSER_POOL_SIZE;
  browserPool = [];
  const t0 = Date.now();
  const tasks = [];
  for (let i = 0; i < size; i++) tasks.push((async (idx) => {
    const bw = new BrowserWrapper(executablePath);
    try {
      await bw.launch();
      await bw.initPagePool();
      return { ok: true, bw, idx };
    } catch (e) {
      console.log(`[超级嗅探] 浏览器池实例 ${idx + 1} 启动失败: ${e.message}`);
      return { ok: false, bw: null, idx, err: e };
    }
  })(i));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.ok) browserPool.push(r.value.bw);
  }
  if (browserPool.length === 0) {
    console.log('[超级嗅探] 警告：浏览器池未启动成功，将使用按需启动模式');
  } else {
    const s = browserPoolStats();
    console.log(`[超级嗅探] 浏览器池已启动: ${browserPool.length}/${size} 个实例，共 ${s.pagesTotal} 个 Page，耗时 ${(Date.now() - t0)}ms`);
  }
  // --- 健康检查定时器（A3）---
  if (browserHealthTimer) clearInterval(browserHealthTimer);
  browserHealthTimer = setInterval(browserPoolHealthCheck, Math.max(1, MX_BROWSER_HEALTH_INTERVAL) * 1000);
  browserHealthTimer.unref && browserHealthTimer.unref();
}

async function browserPoolHealthCheck() {
  if (!MX_BROWSER_ENABLE || MX_BROWSER_POOL_SIZE <= 0) return;
  const executablePath = checkChrome();
  if (!executablePath) return;
  const size = MX_BROWSER_POOL_SIZE;
  // 巡检 & 补位
  for (let i = 0; i < browserPool.length; i++) {
    const bw = browserPool[i];
    let needReplace = false;
    let reason = '';
    if (!bw.isAlive()) { needReplace = true; reason = 'process dead'; }
    else {
      const mem = bw.memoryMB();
      if (MX_BROWSER_MAX_MEM_MB > 0 && mem > MX_BROWSER_MAX_MEM_MB) { needReplace = true; reason = `RSS ${mem}MB 超阈值 ${MX_BROWSER_MAX_MEM_MB}MB`; }
    }
    if (needReplace) {
      console.log(`[超级嗅探] 浏览器池 #${i + 1} 复活（${reason}）`);
      try { await bw.close(); } catch(e){}
      const newBw = new BrowserWrapper(executablePath);
      try {
        await newBw.launch();
        await newBw.initPagePool();
        browserPool[i] = newBw;
      } catch (e) {
        console.log(`[超级嗅探] 复活失败: ${e.message}`);
      }
    } else {
      // 清理过期 Page，按需要补齐数量
      bw._reclaimExpiredPages();
      if ((bw.pagePool || []).length < MX_PAGE_POOL_SIZE) try { await bw.initPagePool(); } catch(e){}
    }
  }
  // 数量不足（可能降级后或配置改大后，尝试新增补齐到 size 上限）
  while (browserPool.length < size) {
    const nb = new BrowserWrapper(executablePath);
    try { await nb.launch(); await nb.initPagePool(); browserPool.push(nb); }
    catch (e) { console.log(`[超级嗅探] 补齐浏览器池实例失败: ${e.message}`); break; }
  }
}

async function nextBrowser() {
  if (!MX_BROWSER_ENABLE) {
    throw new Error('MX_BROWSER_ENABLE=false，Puppeteer 解析已禁用；如需启用请设置 MX_BROWSER_ENABLE=true 并提供 Chrome');
  }
  if (browserPool.length === 0) {
    const executablePath = checkChrome();
    const bw = new BrowserWrapper(executablePath);
    await bw.launch();
    try { await bw.initPagePool(); } catch(e){}
    browserPool.push(bw);
    return bw;
  }
  let attempts = 0;
  while (attempts < browserPool.length) {
    const idx = browserPoolIndex % browserPool.length;
    browserPoolIndex++;
    const bw = browserPool[idx];
    if (bw.isAlive()) return bw;
    attempts++;
  }
  const executablePath = checkChrome();
  const bw = new BrowserWrapper(executablePath);
  await bw.launch();
  try { await bw.initPagePool(); } catch(e){}
  return bw;
}

// acquirePageWrapper：跨浏览器找一个有空闲 Page 的 BrowserWrapper，并 acquire
async function acquirePageWrapper() {
  if (!MX_BROWSER_ENABLE) throw new Error('MX_BROWSER_ENABLE=false');
  // 先找空闲 Page 的浏览器
  for (let i = 0; i < browserPool.length; i++) {
    const idx = (browserPoolIndex + i) % browserPool.length;
    const bw = browserPool[idx];
    if (!bw.isAlive()) continue;
    for (const h of bw.pagePool) if (h.status === 'idle' && !h.dead) {
      browserPoolIndex = (idx + 1) % Math.max(1, browserPool.length);
      const holder = await bw.acquirePage();
      return { bw, holder };
    }
  }
  // 找不到就轮询下一个浏览器，按需建
  const bw = await nextBrowser();
  const holder = await bw.acquirePage();
  return { bw, holder };
}

// ============================================================
// 7.5 官方视频平台专用解析器（直连官方接口获取直链播放地址）
// 防盗链严格的大厂视频（腾讯/B站/搜狐等），页面或第三方解析站通常
// 拿不到直接可播地址。这里按平台从 URL 提取标识（vid / bvid），
// 调用官方接口获取直链，命中即优先返回；任一解析器失败一律返回 null，
// 由上层自动回退到浏览器嗅探 / 万能嗅探。
// ============================================================
const QQ_HOST_RE = /(^|\.)qq\.com$/i;
const BILI_HOST_RE = /(^|\.)bilibili\.com$/i;
const SOHU_HOST_RE = /(^|\.)sohu\.com$/i;
// 搜狐直链通常无扩展名（http://data.vod.itc.cn/?k=...），用视频 CDN 域名白名单校验
const SOHU_CDN_RE = /(^|\.)(itc\.cn|sohucs\.com|sohu\.com)$/i;

// ---------- 腾讯视频（vv.video.qq.com/getinfo） ----------
// 接口返回 QZOutputJson={...} 形式，播放地址 = ui.url + fn + '?vkey=' + fvkey
async function qqVideoResolve(videoUrl) {
  try {
    const host = String(videoUrl || '').match(/^https?:\/\/([^/]+)/i);
    if (!host || !QQ_HOST_RE.test(host[1])) return null;
    const m = String(videoUrl).match(/[?&]vid=([0-9a-zA-Z]+)/i);
    let vid = m ? m[1] : '';
    // v2.4.6：URL 只有 cid 没有 vid（如 m.v.qq.com/x/m/play?cid=xxx）时，
    // 抓取页面从 HTML 里提取 vid，保证这类链接也能命中官方解析
    if (!vid) {
      vid = await qqExtractVidFromPage(videoUrl);
    }
    if (!vid) return null;

    const api =
      'https://vv.video.qq.com/getinfo?vid=' + encodeURIComponent(vid) +
      '&platform=11001&charge=0&otype=json';
    const res = await undiciFetch(api, {
      dispatcher: universalDispatcher,
      headers: { 'User-Agent': MX_USER_AGENT, Referer: 'https://m.v.qq.com/' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(String(text).replace(/^QZOutputJson\s*=\s*/, '').replace(/;\s*$/, ''));
    } catch (e) { return null; }

    if (!json || json.em !== 0 || !json.vl || !json.vl.vi || !json.vl.vi.length) return null;
    const vi = json.vl.vi[0];
    if (!vi || !vi.fn || !vi.fvkey || !vi.ul || !vi.ul.ui) return null;

    const fmt = (json.fl && json.fl.fi && json.fl.fi[0] && json.fl.fi[0].formatdefn) || 'hd';
    const out = [];
    for (const u of vi.ul.ui) {
      if (!u || !u.url) continue;
      const full = u.url + vi.fn + '?vkey=' + vi.fvkey + '&platform=11001&fmt=' + fmt;
      if (isValidUrl(full) && isVideoUrl(full)) out.push(full);
    }
    return out.length ? [...new Set(out)] : null;
  } catch (e) {
    if (MX_DEBUG) console.log(`[腾讯解析] ${videoUrl} 失败: ${e.message}`);
    return null;
  }
}

/**
 * 从腾讯视频页面 HTML 提取 vid（v2.4.6 新增）
 * 用于 URL 只有 cid 没有 vid 的场景，避免官方解析因缺 vid 直接放弃。
 */
async function qqExtractVidFromPage(pageUrl) {
  try {
    const res = await undiciFetch(pageUrl, {
      dispatcher: universalDispatcher,
      headers: { 'User-Agent': MX_USER_AGENT, Referer: 'https://m.v.qq.com/' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return '';
    const text = await res.text();
    // 常见内嵌形式：vid:"xxx" / vid='xxx' / vid=xxx / "video_id":"xxx"
    let m = text.match(/["']?vid["']?\s*[:=]\s*["']([0-9a-zA-Z]+)["']/i);
    if (m) return m[1];
    m = text.match(/[?&]vid=([0-9a-zA-Z]+)/);
    if (m) return m[1];
    return '';
  } catch (e) {
    return '';
  }
}

// ---------- B站（api.bilibili.com/x/web-interface/view + /x/player/playurl） ----------
const BVID_RE = /\/(BV[0-9A-Za-z]+)/i;

async function biliVideoResolve(videoUrl) {
  try {
    const host = String(videoUrl || '').match(/^https?:\/\/([^/]+)/i);
    if (!host || !BILI_HOST_RE.test(host[1])) return null;
    const bvid = (String(videoUrl).match(BVID_RE) || [])[1];
    if (!bvid) return null;

    const headers = { 'User-Agent': MX_USER_AGENT, Referer: 'https://www.bilibili.com/' };
    // 1) 视频详情 -> cid
    const viewRes = await undiciFetch(
      'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid),
      { dispatcher: universalDispatcher, headers, signal: AbortSignal.timeout(15000) }
    );
    if (!viewRes.ok) return null;
    const viewJson = await viewRes.json();
    const cid = viewJson && viewJson.data && viewJson.data.cid;
    if (!cid) return null;

    // 2) 播放地址（fnval=0 -> 单文件 mp4/flv；qn=80 高清，无登录自动降级）
    const playRes = await undiciFetch(
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&qn=80&fnval=0&fourk=1',
      { dispatcher: universalDispatcher, headers, signal: AbortSignal.timeout(15000) }
    );
    if (!playRes.ok) return null;
    const playJson = await playRes.json();
    if (!playJson || playJson.code !== 0 || !playJson.data) return null;

    const out = [];
    const durl = playJson.data.durl;
    if (durl && durl.length) {
      for (const item of durl) {
        if (item && item.url && isValidUrl(item.url) && isVideoUrl(item.url)) out.push(item.url);
        if (item && Array.isArray(item.backup_url)) {
          for (const u of item.backup_url) {
            if (u && isValidUrl(u) && isVideoUrl(u)) out.push(u);
          }
        }
      }
    }
    return out.length ? [...new Set(out)] : null;
  } catch (e) {
    if (MX_DEBUG) console.log(`[B站解析] ${videoUrl} 失败: ${e.message}`);
    return null;
  }
}

// ---------- 搜狐视频（api.tv.sohu.com/v4/video/info/{vid}.json） ----------
function extractSohuVid(url) {
  const s = String(url);
  // 标准格式：https://tv.sohu.com/v/dXMwODY3MzcyMi8xMzkwMDAyLzE4Mzk4ODA3LnNodG1s.html
  // 最后一段 base64 解码为 "us08673722/1390002/18398807"，第二段即 vid
  const m = s.match(/\/v\/([A-Za-z0-9+/=]+?)(?:\.s?html?)/i);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const parts = decoded.split('/');
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) return parts[1];
    } catch (e) {}
  }
  // 兜底：xxx/1390002.shtml 直接以数字结尾的路径
  const n = s.match(/(?:^|[\/_-])(\d{5,})\.shtml/i);
  return n ? n[1] : null;
}

async function sohuVideoResolve(videoUrl) {
  try {
    const host = String(videoUrl || '').match(/^https?:\/\/([^/]+)/i);
    if (!host || !SOHU_HOST_RE.test(host[1])) return null;
    const vid = extractSohuVid(videoUrl);
    if (!vid) return null;

    const res = await undiciFetch(
      'https://api.tv.sohu.com/v4/video/info/' + encodeURIComponent(vid) + '.json?plat=6&pt=5',
      {
        dispatcher: universalDispatcher,
        headers: { 'User-Agent': MX_USER_AGENT, Referer: 'https://tv.sohu.com/' },
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.status !== 200 || !json.data) return null;
    const url = json.data.download_url;
    // 搜狐直链通常无扩展名（http://data.vod.itc.cn/?k=...），改用视频 CDN 域名白名单校验
    if (!url || !isValidUrl(url)) return null;
    try {
      const u = new URL(url);
      if (!SOHU_CDN_RE.test(u.hostname)) return null;
    } catch (e) { return null; }
    return [url];
  } catch (e) {
    if (MX_DEBUG) console.log(`[搜狐解析] ${videoUrl} 失败: ${e.message}`);
    return null;
  }
}

// ---------- 官方解析统一入口：依次尝试各平台，命中即返回 {urls, source} ----------
async function officialVideoResolve(videoUrl) {
  const parsers = [
    ['qq', qqVideoResolve],
    ['bilibili', biliVideoResolve],
    ['sohu', sohuVideoResolve]
  ];
  for (const [name, fn] of parsers) {
    try {
      const urls = await fn(videoUrl);
      if (urls && urls.length) {
        return { urls, source: name + '-official' };
      }
    } catch (e) {}
  }
  return null;
}

// ============================================================
// 8. 核心 sniffVideoUrl 函数
// ============================================================
async function sniffVideoUrl(videoUrl) {
  if (/\.m3u8|\.mp4/i.test(videoUrl)) {
    return { code: 200, url: videoUrl };
  }
  let bw = null;
  let holder = null;
  let page = null;
  try {
    const acquired = await acquirePageWrapper();
    bw = acquired.bw;
    holder = acquired.holder;
    page = holder.page;
    if (holder._hits) holder._hits.clear();

    await page.setUserAgent(MX_USER_AGENT);
    await page.setViewport({ width: 1280, height: 720 });

    const allUrls = new Set();

    try {
      await page.goto(videoUrl, {
        waitUntil: 'networkidle2',
        timeout: MX_PARSE_TIMEOUT
      });
    } catch (e) {
      console.log('[超级嗅探] 页面导航失败，尝试从已捕获的请求中提取: ' + e.message);
    }

    await new Promise((r) => setTimeout(r, MX_EXTRA_WAIT));

    try {
      const content = await page.content();
      extractFromText(content).forEach((u) => allUrls.add(u));
      extractVideoUrls(content).forEach((u) => allUrls.add(u));
    } catch (e) { }

    for (const frame of page.frames()) {
      try {
        const frameContent = await frame.content();
        extractFromText(frameContent).forEach((u) => allUrls.add(u));
        extractVideoUrls(frameContent).forEach((u) => allUrls.add(u));
      } catch (e) { }
    }

    try {
      const c = await page.cookies().catch(() => []);
      if (c && c.length) try { await page.deleteCookie(...c); } catch (e) { }
    } catch (e) { }
    try { await page.goto('about:blank', { timeout: 3000, waitUntil: 'domcontentloaded' }).catch(() => { }); } catch (e) { }

    if (holder._hits) for (const u of holder._hits) allUrls.add(u);

    if (allUrls.size > 0) {
      const sorted = [...allUrls].sort((a, b) => qualityScore(b) - qualityScore(a));
      return { code: 200, url: sorted[0], allUrls: sorted };
    }

    return { code: 404, msg: '未找到播放链接' };
  } catch (err) {
    return { code: 500, msg: '解析失败: ' + err.message };
  } finally {
    if (bw && holder) {
      try {
        await bw.releasePage(holder);
      } catch (e) { }
    }
  }
}

// ============================================================
// 9. Express app + 日志中间件
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${ip}`);
  res.on('finish', () => {
    const dt = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode} (${dt}ms)`);
  });
  next();
});

// ============================================================
// 10. /node.js 解析主接口（/api.php 为兼容别名）
// ============================================================
// 说明：项目附带的 api.php 是 PHP 文件，需在 PHP 环境（宝塔/Nginx+PHP）中部署，
// 不能由 Node 直接执行。为兼容 `http://IP:端口/api.php?url=` 的调用习惯，
// 这里将 /api.php 与 /node.js 共用同一解析逻辑（等价接口）。
const nodeJsParseHandler = async (req, res) => {
  const videoUrl = resolveVideoUrl(req);

  if (!videoUrl) {
    return res.json({ code: 400, msg: '请提供需要解析的链接' });
  }
  if (!isValidUrl(videoUrl)) {
    return res.json({ code: 400, msg: '链接格式不正确' });
  }
  if (/\.m3u8|\.mp4/i.test(videoUrl)) {
    return res.json({ code: 200, url: videoUrl });
  }

  const cacheKey = 'parse:' + videoUrl;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // 官方视频平台专用解析（腾讯/B站/搜狐直连官方接口），命中则直接返回
    const official = await officialVideoResolve(videoUrl);
    if (official && official.urls.length > 0) {
      const r = { code: 200, url: official.urls[0], allUrls: official.urls };
      resultCache.set(cacheKey, r);
      return res.json(r);
    }
    const result = await parseSem.run(() => sniffVideoUrl(videoUrl));
    if (result.code === 200) {
      resultCache.set(cacheKey, result);
    }
    return res.json(result);
  } catch (err) {
    return res.json({ code: 500, msg: '解析失败: ' + err.message });
  }
};

app.get('/node.js', nodeJsParseHandler);
app.get('/api.php', nodeJsParseHandler);

// ============================================================
// 11. /sniff 万能嗅探对外接口
// ============================================================
app.get('/sniff', async (req, res) => {
  const videoUrl = resolveVideoUrl(req);
  const detailed = req.query.detailed != null ? (req.query.detailed === '1' || req.query.detailed === 'true') : MX_UNIVERSAL_DETAILED;
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true'; // 跳过缓存强制重新嗅探

  if (!videoUrl) {
    return res.json({ code: 400, msg: '请提供需要解析的链接' });
  }
  if (!isValidUrl(videoUrl)) {
    return res.json({ code: 400, msg: '链接格式不正确' });
  }

  const cacheKey = 'universal:' + videoUrl + (req.query.official === '0' || req.query.official === 'false' ? '&official=0' : '');
  const cached = !refresh ? universalCache.get(cacheKey) : null;
  if (cached) {
    if (detailed) {
      return res.json({ code: 200, ...cached, cached: true });
    }
    if (cached.urls && cached.urls.length > 0) {
      return res.json({ code: 200, url: cached.urls[0], cached: true });
    }
    return res.json({ code: 404, msg: '未找到播放链接', cached: true });
  }

  try {
    // 官方视频平台专用解析（腾讯/B站/搜狐直连官方接口），命中则直接返回（不占用 Provider 并发）
    // official=0 时跳过官方直连，强制跑全部 Provider（用于失败原因分析 / 调试第三方接口）
    const skipOfficial = req.query.official === '0' || req.query.official === 'false';
    const official = skipOfficial ? null : await officialVideoResolve(videoUrl);
    if (official && official.urls.length > 0) {
      const oSniff = { urls: official.urls, hitProviders: 1, totalProviders: 1, durationMs: 0, source: official.source };
      universalCache.set(cacheKey, oSniff);
      if (detailed) {
        return res.json({ code: 200, ...oSniff });
      }
      return res.json({ code: 200, url: official.urls[0], provider: official.source });
    }
    // 支持 providers= 过滤，便于调试单家接口（逗号分隔的完整接口前缀）
    let onlyProviders;
    if (req.query.providers) {
      onlyProviders = req.query.providers.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const result = await universalSem.run(() => runUniversalSniff(videoUrl, onlyProviders ? { providers: onlyProviders } : {}));
    // v2.4.5：成功结果按完整 TTL 缓存；失败（空结果）仅短缓存，临时故障可快速恢复
    universalCache.set(cacheKey, result, result && result.urls && result.urls.length > 0 ? undefined : MX_UNIVERSAL_EMPTY_TTL * 1000);
    if (detailed) {
      return res.json({ code: 200, ...result });
    }
    if (result.urls && result.urls.length > 0) {
      return res.json({ code: 200, url: result.urls[0] });
    }
    return res.json({ code: 404, msg: '未找到播放链接', providers: result.hitProviders + '/' + result.totalProviders });
  } catch (err) {
    return res.json({ code: 500, msg: '嗅探失败: ' + err.message });
  }
});

// ============================================================
// 12. / 健康检查
// ============================================================
app.get('/', (req, res) => {
  const poolStats = browserPoolStats();
  res.json({
    code: 200,
    msg: '超级嗅探解析服务运行中',
    port: MX_PORT,
    version: 'v' + updater.getCurrentVersion(),
    providers: PROVIDERS.length,
    browserPool: poolStats.browsers,
    pagePoolTotal: poolStats.pagesTotal,
    pagePoolBusy: poolStats.pagesBusy,
    memory: { totalMB: Math.floor(os.totalmem() / 1024 / 1024), freeMB: Math.floor(os.freemem() / 1024 / 1024) },
    providerStats: { rankedTop5: rankedProviders().slice(0, 5).map(p => ({ p, score: providerScore(p), broken: isProviderCircuitBroken(p) })) },
    cache: {
      parse: resultCache.size,
      universal: universalCache.size
    },
    universal: {
      enabled: true,
      providers: PROVIDERS.length,
      concurrency: MX_UNIVERSAL_CONCURRENCY,
      earlyHits: MX_UNIVERSAL_EARLY_HITS,
      circuitBroken: PROVIDERS.filter(isProviderCircuitBroken).length
    }
  });
});

// ============================================================
// 13. adminAuth 中间件 + /admin 首页 + /admin/sniff 万能嗅探测试页
// ============================================================
function adminAuth(req, res, next) {
  if (!MX_ADMIN_AUTH) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [user, pass] = decoded.split(':');
      if (user === MX_ADMIN_USER && pass === MX_ADMIN_PASS) {
        return next();
      }
    } catch (e) { }
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('需要登录');
}

app.get('/admin', adminAuth, (req, res) => {
  // v2.4.1：优先返回独立 admin.html（含「更新源切换 + 在线更新」），
  // 文件缺失（如更新过程中被替换）时回退到内置 v2.2 页面，保证后台始终可用
  try {
    const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    if (adminHtml && /<html/i.test(adminHtml)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(adminHtml);
    }
  } catch (e) { /* 文件缺失，回退内置页面 */ }
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>超级嗅探管理后台 v2.2</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; color: #333; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px 32px; }
.header h1 { font-size: 24px; margin-bottom: 8px; }
.header p { opacity: 0.9; font-size: 14px; }
.container { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 24px; }
.card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.card h2 { font-size: 16px; color: #666; margin-bottom: 12px; }
.card .value { font-size: 32px; font-weight: 700; color: #333; }
.card .value.ok { color: #52c41a; }
.card .value.warn { color: #faad14; }
.nav { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: white; border: 1px solid #e8e8e8; border-radius: 8px; color: #333; text-decoration: none; font-size: 14px; transition: all .2s; cursor: pointer; }
.btn:hover { border-color: #667eea; color: #667eea; transform: translateY(-1px); }
.btn.primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; }
.btn.primary:hover { color: white; opacity: 0.9; }
.panel { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.panel h3 { margin-bottom: 16px; font-size: 18px; }
.form-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
input[type=text] { flex: 1; min-width: 300px; padding: 12px 16px; border: 1px solid #e8e8e8; border-radius: 8px; font-size: 14px; outline: none; transition: border-color .2s; }
input[type=text]:focus { border-color: #667eea; }
.result-box { padding: 16px; background: #fafafa; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 13px; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
.tag { display: inline-block; padding: 2px 8px; background: #e6f7ff; color: #1890ff; border-radius: 4px; font-size: 12px; margin-right: 8px; }
.tag.ok { background: #f6ffed; color: #52c41a; }
.tag.warn { background: #fffbe6; color: #faad14; }
.tag.err { background: #fff1f0; color: #f5222d; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px; text-align: left; border-bottom: 1px solid #f0f0f0; }
th { font-weight: 600; color: #666; font-size: 13px; background: #fafafa; }
tr:hover td { background: #fafafa; }
a.link { color: #667eea; text-decoration: none; }
a.link:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="header">
  <h1>🎬 超级嗅探管理后台 v2.2</h1>
  <p>Node.js 视频解析服务 · 万能嗅探 · 在线更新</p>
</div>
<div class="container">
  <div class="nav">
    <a href="/admin" class="btn primary">🏠 首页</a>
    <a href="/admin/sniff" class="btn">🔍 万能嗅探</a>
  </div>
  <div class="grid">
    <div class="card"><h2>服务状态</h2><div class="value ok" id="statusService">加载中...</div></div>
    <div class="card"><h2>监听端口</h2><div class="value" id="statusPort">-</div></div>
    <div class="card"><h2>当前版本</h2><div class="value" id="statusVer">-</div></div>
    <div class="card"><h2>Chrome 浏览器</h2><div class="value" id="statusChrome">-</div></div>
    <div class="card"><h2>浏览器池</h2><div class="value" id="statusPool">-</div></div>
    <div class="card"><h2>万能嗅探 Provider</h2><div class="value" id="statusProv">-</div></div>
  </div>
  <div class="panel">
    <h3>🔗 快速解析测试（Puppeteer 方式）</h3>
    <div class="form-row">
      <input type="text" id="parseUrl" placeholder="输入视频页面地址，例如：https://v.qq.com/x/cover/...">
      <button class="btn primary" onclick="doParse()">开始解析</button>
    </div>
    <div class="result-box" id="parseResult">等待解析...</div>
  </div>
  <div style="height:24px"></div>
  <div class="panel">
    <h3>🔍 Provider 列表（共 <span id="provCount">${PROVIDERS.length}</span> 个）</h3>
    <table>
      <thead><tr><th style="width:60px">#</th><th>解析接口</th></tr></thead>
      <tbody id="provList"></tbody>
    </table>
  </div>
</div>
<script>
function abs(path) { return location.origin + path; }
async function loadStatus() {
  try {
    const r = await fetch(abs('/admin/api/status')).then(r => r.json());
    document.getElementById('statusService').textContent = r.service;
    document.getElementById('statusService').className = 'value ' + (r.service === '运行中' ? 'ok' : 'err');
    document.getElementById('statusPort').textContent = r.port;
    document.getElementById('statusVer').textContent = 'v' + r.version;
    document.getElementById('statusChrome').textContent = r.chromeVersion;
    document.getElementById('statusChrome').className = 'value ' + (r.chromeInstalled ? 'ok' : 'warn');
    document.getElementById('statusPool').textContent = (r.browserPool || 0) + ' 个实例';
    document.getElementById('statusProv').textContent = (r.universal && r.universal.providers) + ' 个';
  } catch (e) {
    document.getElementById('statusService').textContent = '异常';
    document.getElementById('statusService').className = 'value err';
  }
}
async function loadProviders() {
  try {
    const r = await fetch(abs('/admin/api/providers')).then(r => r.json());
    const list = r.providers || [];
    document.getElementById('provCount').textContent = list.length;
    document.getElementById('provList').innerHTML = list.map((p, i) => '<tr><td>' + (i+1) + '</td><td><code>' + p + '</code></td></tr>').join('');
  } catch (e) {}
}
async function doParse() {
  const url = document.getElementById('parseUrl').value.trim();
  if (!url) { alert('请输入视频地址'); return; }
  const box = document.getElementById('parseResult');
  box.textContent = '正在解析，请稍候...';
  try {
    const start = Date.now();
    const r = await fetch(abs('/node.js?url=' + encodeURIComponent(url))).then(r => r.json());
    const dt = Date.now() - start;
    let html = '';
    html += '状态码: ' + r.code + '  耗时: ' + dt + 'ms\\n\\n';
    if (r.code === 200) {
      html += '✅ 解析成功！\\n\\n';
      html += '播放地址: ' + r.url + '\\n';
      if (r.allUrls && r.allUrls.length > 1) {
        html += '\\n所有捕获地址 (' + r.allUrls.length + ' 条):\\n';
        r.allUrls.forEach((u, i) => { html += '  ' + (i+1) + '. ' + u + '\\n'; });
      }
    } else {
      html += '❌ ' + (r.msg || '解析失败');
    }
    box.textContent = html;
  } catch (e) {
    box.textContent = '请求失败: ' + e.message;
  }
}
loadStatus();
loadProviders();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/admin/sniff', adminAuth, (req, res) => {
  const providerCards = PROVIDERS.map((p, i) => {
    const host = (() => { try { return new URL(p).hostname; } catch (e) { return p; } })();
    return `
<div class="prov-card" id="prov-${i}" data-provider="${escapeHtml(p)}">
  <div class="prov-header">
    <span class="prov-idx">${i + 1}</span>
    <span class="prov-host" title="${escapeHtml(p)}">${escapeHtml(host)}</span>
    <span class="prov-status" id="status-${i}">等待</span>
  </div>
  <div class="prov-body">
    <div class="prov-url" id="url-${i}"></div>
  </div>
</div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>万能嗅探测试 v2.2</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; color: #333; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px 32px; }
.header h1 { font-size: 24px; margin-bottom: 8px; }
.header p { opacity: 0.9; font-size: 14px; }
.container { max-width: 1400px; margin: 24px auto; padding: 0 24px; }
.nav { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: white; border: 1px solid #e8e8e8; border-radius: 8px; color: #333; text-decoration: none; font-size: 14px; transition: all .2s; cursor: pointer; }
.btn:hover { border-color: #667eea; color: #667eea; transform: translateY(-1px); }
.btn.primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; }
.btn.primary:hover { color: white; opacity: 0.9; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.panel { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); margin-bottom: 24px; }
.panel h3 { margin-bottom: 16px; font-size: 18px; }
.form-row { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
input[type=text] { flex: 1; min-width: 300px; padding: 12px 16px; border: 1px solid #e8e8e8; border-radius: 8px; font-size: 14px; outline: none; transition: border-color .2s; }
input[type=text]:focus { border-color: #667eea; }
.progress-bar { width: 100%; height: 24px; background: #f0f0f0; border-radius: 12px; overflow: hidden; margin-bottom: 12px; }
.progress-inner { height: 100%; background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); transition: width .3s; display: flex; align-items: center; justify-content: center; color: white; font-size: 12px; font-weight: 600; min-width: 40px; }
.stats { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
.stat-item { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.stat-item .num { font-size: 20px; font-weight: 700; }
.num.ok { color: #52c41a; }
.num.fail { color: #f5222d; }
.num.pending { color: #faad14; }
.num.total { color: #667eea; }
.num.urls { color: #764ba2; }
.prov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.prov-card { border: 2px solid #f0f0f0; border-radius: 10px; overflow: hidden; transition: all .2s; background: #fafafa; }
.prov-card.pending { border-color: #faad14; background: #fffbe6; }
.prov-card.ok { border-color: #52c41a; background: #f6ffed; }
.prov-card.fail { border-color: #d9d9d9; background: white; opacity: 0.75; }
.prov-card.skip { border-color: #d9d9d9; background: #fafafa; opacity: 0.5; }
.prov-header { padding: 10px 14px; display: flex; align-items: center; gap: 10px; font-size: 13px; border-bottom: 1px solid rgba(0,0,0,0.04); }
.prov-idx { width: 26px; height: 26px; border-radius: 50%; background: #667eea; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0; }
.prov-host { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 12px; color: #333; }
.prov-status { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; flex-shrink: 0; background: #e8e8e8; color: #666; }
.pending .prov-status { background: #fff7e6; color: #d48806; }
.ok .prov-status { background: #b7eb8f; color: #389e0d; }
.fail .prov-status { background: #fff1f0; color: #cf1322; }
.skip .prov-status { background: #f5f5f5; color: #8c8c8c; }
.prov-body { padding: 10px 14px; font-size: 12px; }
.prov-url { word-break: break-all; font-family: 'Courier New', monospace; color: #52c41a; }
.prov-url:empty::before { content: '—'; color: #bbb; }
.prov-url a { color: #52c41a; text-decoration: none; }
.prov-url a:hover { text-decoration: underline; }
.urls-panel { margin-bottom: 24px; }
.url-item { padding: 12px 16px; background: #fafafa; border-radius: 8px; margin-bottom: 8px; display: flex; align-items: center; gap: 12px; }
.url-item .rank { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.url-item .url-text { flex: 1; font-family: 'Courier New', monospace; font-size: 13px; word-break: break-all; }
.url-item .url-text a { color: #667eea; text-decoration: none; }
.url-item .url-text a:hover { text-decoration: underline; }
.player-panel { background: #000; border-radius: 12px; overflow: hidden; }
video { width: 100%; max-height: 500px; background: #000; display: block; }
.log-box { padding: 16px; background: #1e1e1e; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 12px; color: #d4d4d4; max-height: 300px; overflow-y: auto; }
.log-box .log-ok { color: #4ec9b0; }
.log-box .log-err { color: #f48771; }
.log-box .log-warn { color: #dcdcaa; }
.log-box .log-info { color: #9cdcfe; }
.tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.tag-m3u8 { background: #e6f7ff; color: #1890ff; }
.tag-mp4 { background: #f6ffed; color: #52c41a; }
.tag-other { background: #fff0f6; color: #eb2f96; }
</style>
</head>
<body>
<div class="header">
  <h1>🔍 万能嗅探测试 v2.2</h1>
  <p>并发 ${MX_UNIVERSAL_CONCURRENCY} · 提前命中 ${MX_UNIVERSAL_EARLY_HITS > 0 ? MX_UNIVERSAL_EARLY_HITS : '全部'} · ${PROVIDERS.length} 个 Provider</p>
</div>
<div class="container">
  <div class="nav">
    <a href="/admin" class="btn">🏠 首页</a>
    <a href="/admin/sniff" class="btn primary">🔍 万能嗅探</a>
  </div>
  <div class="panel">
    <h3>🛰️ 输入视频地址开始万能嗅探</h3>
    <div class="form-row">
      <input type="text" id="sniffUrl" placeholder="输入视频页面地址，例如：https://v.qq.com/x/cover/...">
      <button class="btn primary" id="startBtn" onclick="startSniff()">🚀 开始嗅探</button>
      <button class="btn" id="stopBtn" onclick="stopSniff()" disabled>⏹ 停止</button>
    </div>
    <div class="progress-bar"><div class="progress-inner" id="progressBar" style="width:0%">0%</div></div>
    <div class="stats">
      <div class="stat-item">总计: <span class="num total" id="statTotal">0</span></div>
      <div class="stat-item">成功: <span class="num ok" id="statOk">0</span></div>
      <div class="stat-item">失败: <span class="num fail" id="statFail">0</span></div>
      <div class="stat-item">跳过: <span class="num pending" id="statSkip">0</span></div>
      <div class="stat-item">URL数: <span class="num urls" id="statUrls">0</span></div>
    </div>
  </div>

  <div class="panel urls-panel" id="urlsPanel" style="display:none">
    <h3>✅ 嗅探结果（按质量排序）</h3>
    <div id="urlsList"></div>
  </div>

  <div class="panel" id="playerPanel" style="display:none">
    <h3>🎬 在线试播（点击上方 URL 的 ▶️ 按钮）</h3>
    <div class="player-panel">
      <video id="videoPlayer" controls></video>
    </div>
  </div>

  <div class="panel">
    <h3>📋 Provider 状态卡片</h3>
    <div class="prov-grid" id="provGrid">${providerCards}</div>
  </div>

  <div style="height:24px"></div>
  <div class="panel">
    <h3>📜 运行日志</h3>
    <div class="log-box" id="logBox"><span class="log-info">等待嗅探开始...</span></div>
  </div>
</div>
<script>
function abs(path) { return location.origin + path; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
}
let eventSource = null;
let stopped = false;
const allUrls = [];

function log(msg, level) {
  const box = document.getElementById('logBox');
  const cls = level ? 'log-' + level : '';
  const line = document.createElement('div');
  line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = '[' + t + '] ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function resetUI() {
  allUrls.length = 0;
  document.getElementById('statTotal').textContent = '0';
  document.getElementById('statOk').textContent = '0';
  document.getElementById('statFail').textContent = '0';
  document.getElementById('statSkip').textContent = '0';
  document.getElementById('statUrls').textContent = '0';
  const pbar = document.getElementById('progressBar');
  pbar.style.width = '0%';
  pbar.textContent = '0%';
  document.getElementById('urlsPanel').style.display = 'none';
  document.getElementById('playerPanel').style.display = 'none';
  document.getElementById('urlsList').innerHTML = '';
  document.getElementById('logBox').innerHTML = '<span class="log-info">等待嗅探开始...</span>';
  for (let i = 0; i < ${PROVIDERS.length}; i++) {
    const card = document.getElementById('prov-' + i);
    if (card) {
      card.className = 'prov-card';
      const st = document.getElementById('status-' + i);
      if (st) st.textContent = '等待';
      const url = document.getElementById('url-' + i);
      if (url) url.innerHTML = '';
    }
  }
}

function setProvStatus(idx, status, urls) {
  const card = document.getElementById('prov-' + idx);
  if (!card) return;
  card.className = 'prov-card ' + status;
  const stEl = document.getElementById('status-' + idx);
  if (stEl) {
    const map = { pending: '嗅探中', ok: '成功(' + (urls || 0) + ')', fail: '失败', skip: '跳过' };
    stEl.textContent = map[status] || status;
  }
  const urlEl = document.getElementById('url-' + idx);
  if (urlEl) {
    if (urls && urls.length > 0) {
      urlEl.innerHTML = urls.slice(0, 3).map(u => {
        const ext = (u.match(/\\.(m3u8|mp4|flv|ts|mkv)(\\?|$)/i) || [,'other'])[1].toLowerCase();
        const tagCls = ext === 'm3u8' ? 'tag-m3u8' : (ext === 'mp4' ? 'tag-mp4' : 'tag-other');
        return '<div><span class="tag ' + tagCls + '">' + ext.toUpperCase() + '</span> <a href="' + escapeHtml(u) + '" target="_blank">' + escapeHtml(u.slice(0, 80)) + (u.length > 80 ? '...' : '') + '</a></div>';
      }).join('');
    } else {
      urlEl.innerHTML = '';
    }
  }
}

function updateStats(done, total, ok, fail, skip, urls) {
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statOk').textContent = ok;
  document.getElementById('statFail').textContent = fail;
  document.getElementById('statSkip').textContent = skip;
  document.getElementById('statUrls').textContent = urls;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const pbar = document.getElementById('progressBar');
  pbar.style.width = pct + '%';
  pbar.textContent = pct + '%  (' + done + '/' + total + ')';
}

function renderUrls(urls) {
  const panel = document.getElementById('urlsPanel');
  const list = document.getElementById('urlsList');
  panel.style.display = 'block';
  list.innerHTML = urls.map((u, i) => {
    const ext = (u.match(/\\.(m3u8|mp4|flv|ts|mkv)(\\?|$)/i) || [,'other'])[1].toLowerCase();
    const tagCls = ext === 'm3u8' ? 'tag-m3u8' : (ext === 'mp4' ? 'tag-mp4' : 'tag-other');
    return '<div class="url-item">' +
      '<div class="rank">' + (i + 1) + '</div>' +
      '<div class="url-text">' +
        '<span class="tag ' + tagCls + '">' + ext.toUpperCase() + '</span> ' +
        '<a href="' + escapeHtml(u) + '" target="_blank">' + escapeHtml(u) + '</a>' +
      '</div>' +
      '<button class="btn" onclick="playUrl(\\'' + escapeHtml(u.replace(/'/g, "\\\\'")) + '\\')">▶️ 试播</button>' +
      '<button class="btn" onclick="copyUrl(\\'' + escapeHtml(u.replace(/'/g, "\\\\'")) + '\\')">📋 复制</button>' +
    '</div>';
  }).join('');
}

function playUrl(url) {
  const panel = document.getElementById('playerPanel');
  const v = document.getElementById('videoPlayer');
  panel.style.display = 'block';
  v.src = url;
  v.play().catch(e => log('试播失败: ' + e.message, 'warn'));
  panel.scrollIntoView({ behavior: 'smooth' });
}

function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => log('已复制到剪贴板: ' + url.slice(0, 60) + '...', 'ok')).catch(() => log('复制失败', 'warn'));
}

function startSniff() {
  const url = document.getElementById('sniffUrl').value.trim();
  if (!url) { alert('请输入视频地址'); return; }
  stopped = false;
  resetUI();
  document.getElementById('startBtn').disabled = true;
  document.getElementById('stopBtn').disabled = false;
  log('开始嗅探: ' + url, 'info');
  log('Provider 数量: ${PROVIDERS.length} · 并发: ${MX_UNIVERSAL_CONCURRENCY} · 提前命中: ${MX_UNIVERSAL_EARLY_HITS > 0 ? MX_UNIVERSAL_EARLY_HITS : '全部'}', 'info');
  log('平台记忆: 已启用（按目标平台历史成功 Provider 优先排序，失败原因自动记忆）', 'info');

  const urlParams = new URLSearchParams();
  urlParams.set('url', url);
  const endpoint = abs('/admin/api/sniff-stream?' + urlParams.toString());

  eventSource = new EventSource(endpoint);

  eventSource.addEventListener('message', (e) => {
    if (stopped) return;
    try {
      const data = JSON.parse(e.data);
      handleEvent(data);
    } catch (err) {
      log('消息解析失败: ' + err.message, 'err');
    }
  });

  eventSource.addEventListener('progress', (e) => {
    if (stopped) return;
    try {
      const data = JSON.parse(e.data);
      handleEvent({ type: 'progress', ...data });
    } catch (err) {}
  });

  eventSource.addEventListener('done', (e) => {
    try {
      const data = JSON.parse(e.data);
      handleEvent({ type: 'done', ...data });
    } catch (err) {
      finishCleanup();
    }
  });

  eventSource.onerror = (e) => {
    log('连接已关闭', stopped ? 'info' : 'warn');
    finishCleanup();
  };
}

function handleEvent(data) {
  if (!data || !data.type) return;
  const t = data.type;
  let okCount = 0, failCount = 0, skipCount = 0, pendingCount = 0;
  const total = ${PROVIDERS.length};

  if (t === 'progress' && typeof data.index === 'number') {
    const i = data.index;
    const status = data.status;
    const provider = data.provider;
    const urls = data.urls || [];
    const hitCount = data.count != null ? data.count : urls.length;
    setProvStatus(i, status, urls);
    if (status === 'ok') {
      log('[#' + (i+1) + '] ✅ 命中 ' + hitCount + ' 个 URL - ' + (provider || '').slice(0, 50), 'ok');
    } else if (status === 'fail') {
      log('[#' + (i+1) + '] ❌ 未命中 - ' + (provider || '').slice(0, 50), 'fail');
    } else if (status === 'skip') {
      log('[#' + (i+1) + '] ⏭ 跳过（提前命中） - ' + (provider || '').slice(0, 50), 'warn');
    } else if (status === 'pending') {
      log('[#' + (i+1) + '] 🔄 开始嗅探...', 'info');
    }
  }

  for (let i = 0; i < total; i++) {
    const card = document.getElementById('prov-' + i);
    if (card) {
      if (card.classList.contains('ok')) okCount++;
      else if (card.classList.contains('fail')) failCount++;
      else if (card.classList.contains('skip')) skipCount++;
      else pendingCount++;
    }
  }
  const done = okCount + failCount + skipCount;

  if (t === 'done' && data.urls) {
    data.urls.forEach(u => { if (!allUrls.includes(u)) allUrls.push(u); });
    renderUrls(allUrls);
    log('========== 嗅探完成 ==========', 'info');
    log('命中 Provider: ' + data.hitProviders + ' / ' + data.totalProviders, 'ok');
    log('唯一 URL 数量: ' + allUrls.length, 'ok');
    if (allUrls.length > 0) {
      log('第一名: ' + allUrls[0], 'ok');
    } else {
      log('未找到任何可用 URL，建议使用回退解析', 'warn');
    }
    finishCleanup();
  } else if (t === 'error') {
    log('嗅探错误: ' + (data.msg || '未知错误'), 'err');
    finishCleanup();
  }
  updateStats(done, total, okCount, failCount, skipCount, allUrls.length);
}

function stopSniff() {
  stopped = true;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  log('用户停止嗅探', 'warn');
  finishCleanup();
}

function finishCleanup() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
}
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ============================================================
// 14. /admin/api/status
// ============================================================
app.get('/admin/api/status', adminAuth, (req, res) => {
  const chromeVersion = updater.getChromeVersion();
  const version = updater.getCurrentVersion();
  const sourceInfo = updater.getSourceInfo();
  const poolStats = browserPoolStats();
  res.json({
    code: 200,
    service: '运行中',
    port: MX_PORT,
    version,
    chromeVersion,
    chromeInstalled: chromeVersion !== '未安装' && chromeVersion !== '不可用',
    updateSource: `${updater.GITHUB_OWNER}/${updater.GITHUB_REPO}`,
    source: sourceInfo.source,
    branch: sourceInfo.branch,
    sourceLabel: sourceInfo.label,
    browserPool: poolStats.browsers,
    pagePoolTotal: poolStats.pagesTotal,
    pagePoolBusy: poolStats.pagesBusy,
    providers: PROVIDERS.length,
    memory: { totalMB: Math.floor(os.totalmem() / 1024 / 1024), freeMB: Math.floor(os.freemem() / 1024 / 1024) },
    providerStats: { rankedTop5: rankedProviders().slice(0, 5).map(p => ({ p, score: providerScore(p), broken: isProviderCircuitBroken(p) })) },
    universal: {
      enabled: true,
      providers: PROVIDERS.length,
      concurrency: MX_UNIVERSAL_CONCURRENCY,
      earlyHits: MX_UNIVERSAL_EARLY_HITS,
      cacheSize: universalCache.size,
      circuitBroken: PROVIDERS.filter(isProviderCircuitBroken).length
    },
    cache: {
      parse: resultCache.size,
      universal: universalCache.size
    }
  });
});

// ============================================================
// 15. /admin/api/providers
// ============================================================
app.get('/admin/api/providers', adminAuth, (req, res) => {
  res.json({
    code: 200,
    providers: PROVIDERS,
    total: PROVIDERS.length,
    concurrency: MX_UNIVERSAL_CONCURRENCY,
    earlyHits: MX_UNIVERSAL_EARLY_HITS
  });
});

// ============================================================
// 15.5 /admin/api/rules —— 平台记忆规则与失败原因分析（v2.4.9）
//      查看每个平台 Provider 的记忆排序、推荐/备用/弱项/熔断状态、失败原因分布
// ============================================================
app.get('/admin/api/rules', adminAuth, (req, res) => {
  res.json({
    code: 200,
    platforms: PLATFORM_NAMES,
    rules: buildPlatformRules(),
    globalTop5: rankedProviders().slice(0, 5).map((p) => ({ provider: String(p), score: Math.round(providerScore(p)) }))
  });
});

// ============================================================
// 16. /admin/api/sniff-stream SSE
// ============================================================
app.get('/admin/api/sniff-stream', adminAuth, async (req, res) => {
  const videoUrl = resolveVideoUrl(req);
  if (!videoUrl) {
    return res.status(400).json({ type: 'error', msg: '请提供视频地址' });
  }
  if (!isValidUrl(videoUrl)) {
    return res.status(400).json({ type: 'error', msg: '链接格式不正确' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, obj) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) { }
  };
  const sendMsg = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) { }
  };

  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  sendMsg({ type: 'start', url: videoUrl, totalProviders: PROVIDERS.length });

  try {
    // 官方视频平台专用解析（腾讯/B站/搜狐直连官方接口），命中则直接返回，不再依赖第三方接口
    // （v2.4.9：修复测试页对腾讯等官方平台链接大量「未命中」的问题）
    // official=0 时跳过官方直连，强制跑全部 Provider（用于失败原因分析 / 调试第三方接口）
    const skipOfficial = req.query.official === '0' || req.query.official === 'false';
    const official = skipOfficial ? null : await officialVideoResolve(videoUrl);
    if (official && official.urls.length > 0) {
      if (!clientClosed) {
        sendEvent('progress', {
          index: 0,
          provider: official.source,
          status: 'ok',
          count: official.urls.length,
          urls: official.urls,
          done: 1,
          total: 1,
          hits: 1
        });
        sendEvent('done', {
          type: 'done',
          urls: official.urls,
          totalProviders: 1,
          hitProviders: 1,
          totalUrls: official.urls.length,
          providers: [{ provider: official.source, status: 'ok', urls: official.urls }]
        });
      }
      return;
    }
    const result = await universalSem.run(() => runUniversalSniff(videoUrl, {
      onProgress: (p) => {
        if (clientClosed) return;
        sendEvent('progress', p);
      },
      earlyHits: MX_UNIVERSAL_EARLY_HITS
    }));

    if (!clientClosed) {
      sendEvent('done', {
        type: 'done',
        urls: result.urls,
        totalProviders: result.totalProviders,
        hitProviders: result.hitProviders,
        totalUrls: result.totalUrls,
        providers: result.providers
      });
    }
  } catch (err) {
    if (!clientClosed) {
      sendEvent('done', { type: 'error', msg: err.message });
    }
  } finally {
    try {
      setTimeout(() => {
        if (!clientClosed) {
          try { res.end(); } catch (e) { }
        }
      }, 200);
    } catch (e) { }
  }
});

// ============================================================
// 17. 原有更新接口
// ============================================================
app.get('/admin/api/update-source', adminAuth, (req, res) => {
  const info = updater.getSourceInfo();
  res.json({ code: 200, ...info });
});

app.post('/admin/api/update-source', adminAuth, (req, res) => {
  const source = (req.body && req.body.source) || '';
  try {
    updater.setUpdateSource(source);
    const info = updater.getSourceInfo();
    res.json({ code: 200, msg: `已切换到${info.label}（${info.branch} 分支）`, ...info });
  } catch (err) {
    res.json({ code: 400, msg: err.message });
  }
});

app.get('/admin/api/check-update', adminAuth, async (req, res) => {
  try {
    const release = await updater.getLatestRelease();
    const latestVersion = String(release.tag_name || '').replace(/^v/, '');
    const currentVersion = updater.getCurrentVersion();
    const sourceInfo = updater.getSourceInfo();

    const sourceAsset = updater.findAsset(release, 'source');
    const browserAssetReal = updater.findAsset(release, 'browser');

    res.json({
      code: 200,
      currentVersion,
      latestVersion,
      latestVersionBase: updater.normalizeVersion(latestVersion),
      source: sourceInfo.source,
      branch: sourceInfo.branch,
      sourceLabel: sourceInfo.label,
      sourceNeedUpdate: updater.compareVersions(latestVersion, currentVersion) > 0,
      sourceAsset: sourceAsset
        ? { name: sourceAsset.name, size: sourceAsset.size }
        : null,
      browserNeedUpdate: !!browserAssetReal,
      browserAsset: browserAssetReal
        ? { name: browserAssetReal.name, size: browserAssetReal.size }
        : null,
      releaseName: release.name,
      releaseBody: release.body || ''
    });
  } catch (err) {
    res.json({ code: 500, msg: '检查更新失败: ' + err.message });
  }
});

app.post('/admin/api/update', adminAuth, async (req, res) => {
  const type = (req.body && req.body.type) || 'all';
  if (!['browser', 'source', 'all'].includes(type)) {
    return res.status(400).json({ code: 400, msg: '无效的更新类型' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 关闭 nginx 缓冲，保证进度实时推送
  res.flushHeaders();

  const send = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (e) { }
  };
  const log = (msg, level = 'info') => send({ type: 'log', msg, level });
  // 下载进度事件：前端进度条据此实时渲染
  const onProgress = (p) => send({ type: 'progress', ...p });

  try {
    if (type === 'browser') {
      await updater.updateBrowser(log, onProgress);
      send({ type: 'done', ok: true, msg: '浏览器更新完成' });
    } else if (type === 'source') {
      const ret = await updater.updateSource(log, onProgress);
      // 已是最新版本（skipped）时不重启服务，避免无意义重启 / 页面误刷新
      if (ret && ret.skipped) {
        send({ type: 'done', ok: true, msg: `已是最新版本（v${updater.getCurrentVersion()}），无需更新` });
      } else {
        send({ type: 'done', ok: true, msg: '源码更新完成，即将重启服务', restart: true });
        setTimeout(() => updater.restartServer(log), 800);
      }
    } else {
      await updater.updateBrowser(log, onProgress);
      const ret = await updater.updateSource(log, onProgress);
      if (ret && ret.skipped) {
        send({ type: 'done', ok: true, msg: '浏览器更新完成（源码已是最新版本，无需更新）' });
      } else {
        send({ type: 'done', ok: true, msg: '一键升级完成，即将重启服务', restart: true });
        setTimeout(() => updater.restartServer(log), 800);
      }
    }
  } catch (err) {
    send({ type: 'log', msg: '更新失败: ' + err.message, level: 'err' });
    send({ type: 'done', ok: false, msg: '更新失败: ' + err.message });
  } finally {
    setTimeout(() => {
      try {
        res.end();
      } catch (e) { }
    }, 300);
  }
});

app.get('/healthz/live', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/healthz/startup', (req, res) => res.status(200).json({ status: 'ok', ready: true }));
app.get('/healthz/ready', (req, res) => {
  const ok = MX_BROWSER_ENABLE === false || browserPool.length > 0 || MX_UNIVERSAL_ENABLE === true;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'wait', browserPool: browserPool.length, universalEnabled: MX_UNIVERSAL_ENABLE });
});

// ============================================================
// 18. listenWithRetry 启动函数
// ============================================================
function listenWithRetry(port, retries) {
  const server = app.listen(port, MX_HOST);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`[超级嗅探] 端口 ${port} 被占用，500ms 后重试 (剩余 ${retries} 次)...`);
      server.close();
      setTimeout(() => listenWithRetry(port, retries - 1), 500);
    } else {
      console.error('[超级嗅探] 启动失败: ' + err.message);
      process.exit(1);
    }
  });
  server.on('listening', async () => {
    try {
      await initBrowserPool();
    } catch (e) {
      console.log('[超级嗅探] 浏览器池初始化失败: ' + e.message);
    }
    const ver = updater.getCurrentVersion();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║           超级嗅探视频解析服务 v${ver} 启动成功                  ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  解析接口:     http://localhost:${port}/node.js?url=          ║`);
    console.log(`║  健康检查:     http://localhost:${port}/                       ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  后台首页:     http://localhost:${port}/admin                  ║`);
    console.log(`║  万能嗅探页:   http://localhost:${port}/admin/sniff            ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  【万能嗅探模块】                                             ║');
    console.log(`║  对外接口:     http://localhost:${port}/sniff?url=             ║`);
    console.log(`║  Provider 数: ${String(PROVIDERS.length).padEnd(36)}║`);
    console.log(`║  并发数:       ${String(MX_UNIVERSAL_CONCURRENCY).padEnd(36)}║`);
    console.log(`║  提前命中:     ${String(MX_UNIVERSAL_EARLY_HITS > 0 ? MX_UNIVERSAL_EARLY_HITS : '全部(不使用提前命中)').padEnd(36)}║`);
    console.log(`║  结果缓存:     ${String(MX_UNIVERSAL_CACHE_MAX + '条/' + MX_UNIVERSAL_CACHE_TTL + 's').padEnd(36)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    const _ps = browserPoolStats();
    console.log('║  【浏览器池 v2.2】                                             ║');
    console.log(`║  Browser 数量: ${String(_ps.browsers + '/' + MX_BROWSER_POOL_SIZE).padEnd(36)}║`);
    console.log(`║  Page 总数:    ${String(_ps.pagesTotal).padEnd(36)}║`);
    console.log(`║  Page 使用中:  ${String(_ps.pagesBusy).padEnd(36)}║`);
    console.log(`║  单页上限:    MX_PAGE_MAX_USE / 空闲 ${MX_PAGE_IDLE_TIMEOUT}s             ║`);
    console.log(`║  RSS 阈值:    ${String(MX_BROWSER_MAX_MEM_MB + 'MB / 巡检 ' + MX_BROWSER_HEALTH_INTERVAL + 's').padEnd(36)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  【缓存 & Provider】                                           ║');
    console.log(`║  缓存目录:    ${String(MX_CACHE_PERSIST ? path.relative(process.cwd(), MX_CACHE_DIR) : '关闭').padEnd(36)}║`);
    console.log(`║  Flush 周期:  ${String(MX_CACHE_FLUSH_INTERVAL + 's').padEnd(36)}║`);
    console.log(`║  熔断 Provider: ${String(PROVIDERS.filter(isProviderCircuitBroken).length + '/' + PROVIDERS.length).padEnd(36)}║`);
    console.log(`║  TopK 优先:    ${String(MX_UNIVERSAL_TOPK_FIRST + ' / 渲染并发 ' + MX_UNIVERSAL_BROWSER_CONC).padEnd(36)}║`);
    console.log(`║  平台记忆:    ${String('已启用（按平台成功率排序）').padEnd(36)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Chrome 路径: ${String(checkChrome() || '使用系统默认').padEnd(36)}║`);
    console.log(`║  当前版本:     v${String(ver).padEnd(36)}║`);
    if (MX_ADMIN_AUTH) {
    console.log('║  后台登录:     Basic 认证已启用                               ║');
    }
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });

  // 19. 优雅退出
  const shutdown = async (signal) => {
    console.log(`\n[超级嗅探] 收到 ${signal} 信号，开始优雅退出...`);
    try {
      server.close(() => console.log('[超级嗅探] HTTP 服务已关闭'));
    } catch (e) { }
    if (browserPool.length > 0) {
      console.log(`[超级嗅探] 正在关闭 ${browserPool.length} 个浏览器实例...`);
      await Promise.all(browserPool.map((bw) => bw.close().catch(() => {})));
      console.log('[超级嗅探] 浏览器池已关闭');
    }
    console.log('[超级嗅探] 退出完成，再见！');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

listenWithRetry(MX_PORT, 20);
