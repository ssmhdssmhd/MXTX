/**
 * 超级嗅探 - Node.js 视频解析服务
 *
 * 功能：
 *   使用 Puppeteer 无头浏览器打开目标视频页面，
 *   通过「网络请求拦截 + 页面内容扫描 + iframe 扫描」三种方式，
 *   提取页面中的 .m3u8 播放地址并返回。
 *
 * 性能优化（v2.0.0+）：
 *   [1] 浏览器单例池：服务启动时初始化浏览器，不再每次都 launch/close
 *   [2] 找到即返回：一旦捕获到 m3u8 立即结束等待，不再傻等超时
 *   [3] LRU 结果缓存：相同 URL 在 TTL 内直接返回缓存结果
 *   [4] 并发控制：信号量限制最大同时解析数，防止 OOM
 *   [5] 页面池：复用 Page 实例，减少 newPage() 开销
 *
 * 环境变量（全部以 MX_ 开头，详见 README「环境变量」章节）：
 *   服务类：MX_PORT, MX_HOST
 *   后台类：MX_ADMIN_USER, MX_ADMIN_PASS
 *   浏览器类：MX_CHROME_PATH, MX_CHROME_HEADLESS, MX_BROWSER_POOL_SIZE, MX_PAGE_POOL_SIZE
 *   嗅探类：MX_PARSE_TIMEOUT, MX_EXTRA_WAIT, MX_EARLY_RETURN, MX_USER_AGENT, MX_SNIFF_RESPONSE_BODY, MX_SNIFF_IFRAME
 *   缓存类：MX_CACHE_ENABLE, MX_CACHE_TTL, MX_CACHE_MAX
 *   并发类：MX_MAX_CONCURRENT, MX_REQUEST_QUEUE_TIMEOUT
 *   更新类：MX_GITHUB_OWNER, MX_GITHUB_REPO, MX_GITHUB_TOKEN
 *
 * 启动：
 *   node node.js
 *   或自定义配置：MX_PORT=8080 MX_ADMIN_USER=admin MX_ADMIN_PASS=123456 node node.js
 *
 * 接口：
 *   GET /node.js?url=<视频页面地址>
 *
 * 返回：
 *   {"code":200,"url":"https://.../index.m3u8"}        解析成功
 *   {"code":400,"msg":"请提供需要解析的链接"}             缺少参数
 *   {"code":404,"msg":"未找到播放链接"}                  未找到 m3u8
 *   {"code":500,"msg":"解析失败: ..."}                  服务异常
 */

'use strict';

// ============================================================
// 0. 依赖加载
// ============================================================
const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const updater = require('./update');

// ============================================================
// 1. 环境变量加载（统一 MX_ 前缀，兼容旧变量名 fallback）
// ============================================================

/**
 * 读取环境变量辅助函数：优先 MX_ 前缀，找不到就 fallback 旧变量名，最后用默认值
 * @param {string} mxKey    MX_ 前缀的新变量名
 * @param {string} legacyKey 旧变量名（可选，兼容历史部署）
 * @param {*}      defVal   默认值
 * @returns {string}
 */
function envStr(mxKey, legacyKey, defVal) {
  const v = process.env[mxKey];
  if (v !== undefined && v !== '') return v;
  if (legacyKey) {
    const lv = process.env[legacyKey];
    if (lv !== undefined && lv !== '') return lv;
  }
  return defVal;
}

/** 读取布尔型环境变量 */
function envBool(mxKey, legacyKey, defVal) {
  const v = envStr(mxKey, legacyKey, defVal ? 'true' : 'false').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 读取整型环境变量 */
function envInt(mxKey, legacyKey, defVal) {
  const v = parseInt(envStr(mxKey, legacyKey, String(defVal)), 10);
  return isNaN(v) || v <= 0 ? defVal : v;
}

// ---------- 1.1 服务配置 ----------
/** 服务监听端口 */
const MX_PORT = envInt('MX_PORT', 'PORT', 1314);
/** 服务监听主机（0.0.0.0=所有网卡，127.0.0.1=仅本地） */
const MX_HOST = envStr('MX_HOST', null, '0.0.0.0');

// ---------- 1.2 后台管理账号密码 ----------
/** 后台 Basic Auth 用户名（留空则不开启认证，生产环境务必设置） */
const MX_ADMIN_USER = envStr('MX_ADMIN_USER', null, '');
/** 后台 Basic Auth 密码 */
const MX_ADMIN_PASS = envStr('MX_ADMIN_PASS', null, '');
/** 是否启用后台认证（只要账号密码都有就开启） */
const ADMIN_AUTH_ENABLED = !!(MX_ADMIN_USER && MX_ADMIN_PASS);

// ---------- 1.3 浏览器 / Puppeteer 配置 ----------
/** Chrome 可执行文件路径（优先项目内打包的 chrome-linux64/chrome） */
const MX_CHROME_PATH = envStr(
  'MX_CHROME_PATH',
  'CHROME_PATH',
  path.join(__dirname, 'chrome-linux64', 'chrome')
);
/** 是否以无头模式启动（调试时可设为 false 看界面） */
const MX_CHROME_HEADLESS = envBool('MX_CHROME_HEADLESS', null, true);
/** 浏览器实例池大小（建议 1~3，单实例足够支撑日常流量） */
const MX_BROWSER_POOL_SIZE = envInt('MX_BROWSER_POOL_SIZE', null, 1);
/** 单浏览器最大 Page 复用数（防止单浏览器 Page 太多卡死） */
const MX_PAGE_POOL_SIZE = envInt('MX_PAGE_POOL_SIZE', null, 8);

// ---------- 1.4 嗅探 / 解析参数 ----------
/** 单次解析总超时（毫秒），含页面加载 + 等待时间 */
const MX_PARSE_TIMEOUT = envInt('MX_PARSE_TIMEOUT', 'PARSE_TIMEOUT', 30000);
/** 页面加载完成后额外等待时间（毫秒），用于动态加载；MX_EARLY_RETURN=true 时找到即跳过 */
const MX_EXTRA_WAIT = envInt('MX_EXTRA_WAIT', 'EXTRA_WAIT', 2000);
/** 找到即返回开关：一旦捕获到 m3u8，立即结束等待（性能优化核心，默认开启） */
const MX_EARLY_RETURN = envBool('MX_EARLY_RETURN', null, true);
/** 自定义 User-Agent */
const MX_USER_AGENT = envStr(
  'MX_USER_AGENT',
  null,
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
);
/** 视口宽度 */
const MX_VIEWPORT_W = envInt('MX_VIEWPORT_WIDTH', null, 1280);
/** 视口高度 */
const MX_VIEWPORT_H = envInt('MX_VIEWPORT_HEIGHT', null, 720);
/** 是否从文本类响应体中扫描 m3u8（部分站把地址藏在 JS/JSON 里） */
const MX_SNIFF_RESPONSE_BODY = envBool('MX_SNIFF_RESPONSE_BODY', null, true);
/** 是否扫描 iframe 内容（部分站播放器嵌在 iframe） */
const MX_SNIFF_IFRAME = envBool('MX_SNIFF_IFRAME', null, true);

// ---------- 1.5 缓存配置（LRU + TTL） ----------
/** 是否启用解析结果缓存 */
const MX_CACHE_ENABLE = envBool('MX_CACHE_ENABLE', null, true);
/** 缓存 TTL 秒数（相同 URL 在此时长内直接返回缓存） */
const MX_CACHE_TTL = envInt('MX_CACHE_TTL', null, 1800);
/** 最大缓存条目数（防止内存无限增长，超出时淘汰最久未使用） */
const MX_CACHE_MAX = envInt('MX_CACHE_MAX', null, 500);

// ---------- 1.6 并发控制 ----------
/** 最大同时解析数量（防止并发太高把 Chrome/内存打爆） */
const MX_MAX_CONCURRENT = envInt('MX_MAX_CONCURRENT', null, 5);
/** 请求排队超时（毫秒）：并发满时，请求在队列里最多等多久 */
const MX_REQUEST_QUEUE_TIMEOUT = envInt('MX_REQUEST_QUEUE_TIMEOUT', null, 90000);

// ---------- 1.7 更新源配置（注入到 updater 模块使用） ----------
process.env.MX_GITHUB_OWNER && (process.env.GITHUB_OWNER = process.env.MX_GITHUB_OWNER);
process.env.MX_GITHUB_REPO && (process.env.GITHUB_REPO = process.env.MX_GITHUB_REPO);
process.env.MX_GITHUB_TOKEN && (process.env.GITHUB_TOKEN = process.env.MX_GITHUB_TOKEN);

// ---------- 1.8 万能嗅探配置（第三方解析接口并发嗅探） ----------
/** 是否启用万能嗅探模块（对外 /sniff 接口与后台测试页） */
const MX_UNIVERSAL_ENABLE = envBool('MX_UNIVERSAL_ENABLE', null, true);
/** 万能嗅探单接口超时（毫秒），第三方接口响应慢可适当调大 */
const MX_UNIVERSAL_TIMEOUT = envInt('MX_UNIVERSAL_TIMEOUT', null, 12000);
/** 万能嗅探最大并发（同时请求多少个第三方接口；不建议 > 10，防止对方限流） */
const MX_UNIVERSAL_CONCURRENCY = envInt('MX_UNIVERSAL_CONCURRENCY', null, 6);
/** 万能嗅探结果 LRU TTL（秒），相同 VIP 视频页地址在 TTL 内复用 */
const MX_UNIVERSAL_TTL = envInt('MX_UNIVERSAL_TTL', null, 1800);
/** 万能嗅探最大缓存条目（防内存无限长） */
const MX_UNIVERSAL_CACHE_MAX = envInt('MX_UNIVERSAL_CACHE_MAX', null, 200);
/** 万能嗅探最多返回多少条「去重后的」播放地址（避免返回太多） */
const MX_UNIVERSAL_MAX_RESULTS = envInt('MX_UNIVERSAL_MAX_RESULTS', null, 12);
/** 万能嗅探命中多少条就提前返回（不等其它慢接口，0=等所有完成） */
const MX_UNIVERSAL_EARLY_HITS = envInt('MX_UNIVERSAL_EARLY_HITS', null, 0);
/**
 * 自定义第三方解析接口列表（JSON 字符串数组，可选）
 *   例：MX_UNIVERSAL_PROVIDERS_JSON='["https://jx.xmflv.cc/?url=","https://jx.xmflv.com/?url="]'
 *   留空则使用下方内置 18 个默认接口
 */
const MX_UNIVERSAL_PROVIDERS_JSON = envStr('MX_UNIVERSAL_PROVIDERS_JSON', null, '');
/** 第三方嗅探请求走代理（默认与更新源共用 MX_PROXY） */
const MX_UNIVERSAL_PROXY = envStr('MX_UNIVERSAL_PROXY', null, process.env.MX_PROXY || '');

/**
 * 内置的第三方「万能解析」接口（18 个，均采用 base + ?url= 追加模式）
 * 说明：这些是常见的公开 VIP 视频解析站，稳定性不保证，
 *       用户可随时通过 MX_UNIVERSAL_PROVIDERS_JSON 覆盖/替换。
 */
const BUILTIN_UNIVERSAL_PROVIDERS = [
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
/** 组装最终 provider 列表（JSON 覆盖优先，否则内置） */
const MX_UNIVERSAL_PROVIDERS = (() => {
  if (MX_UNIVERSAL_PROVIDERS_JSON) {
    try {
      const arr = JSON.parse(MX_UNIVERSAL_PROVIDERS_JSON);
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        return arr.filter((x) => x && x.trim()).map((x) => x.trim());
      }
    } catch (e) {
      console.warn('[超级嗅探] MX_UNIVERSAL_PROVIDERS_JSON 不是合法字符串数组，使用内置列表');
    }
  }
  return BUILTIN_UNIVERSAL_PROVIDERS.slice();
})();

// ============================================================
// 2. 通用工具函数
// ============================================================

/** m3u8 地址正则（支持带查询参数） */
const M3U8_REGEX = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;

/** 校验 URL 是否合法 */
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol);
  } catch (e) {
    return false;
  }
}

/** 从文本内容中提取所有 m3u8 地址（去重，修复转义斜杠） */
function extractFromText(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  const regex = new RegExp(M3U8_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    found.add(match[0].replace(/\\\//g, '/'));
  }
  return [...found];
}

/** 检查响应是否可能是文本类内容（避免读取二进制导致卡死/内存浪费） */
function isTextResponse(headers) {
  const ct = ((headers && headers['content-type']) || '').toLowerCase();
  return (
    ct.includes('text/') ||
    ct.includes('json') ||
    ct.includes('mpegurl') ||
    ct.includes('vnd.apple') ||
    ct === '' ||
    ct.includes('x-mpegurl') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript')
  );
}

/** 检查 Chrome 是否存在，返回可执行路径或 undefined（回退 puppeteer 自带） */
function checkChrome() {
  if (fs.existsSync(MX_CHROME_PATH)) return MX_CHROME_PATH;
  return undefined;
}

// ============================================================
// 3. LRU 缓存实现（解析结果缓存）
// ============================================================
class LRUCache {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttlMs = ttlMs;
    /** @type {Map<string,{value:any,ts:number,last:number}>} */
    this.map = new Map();
  }
  /** 计算缓存 key（URL 去空格后 hash，这里直接用 URL 做 key 够简单） */
  _key(url) {
    return String(url).trim();
  }
  get(url) {
    const k = this._key(url);
    const it = this.map.get(k);
    if (!it) return null;
    // 过期检查
    if (Date.now() - it.ts > this.ttlMs) {
      this.map.delete(k);
      return null;
    }
    // LRU：重新插入以更新顺序（Map 按插入顺序）
    this.map.delete(k);
    it.last = Date.now();
    this.map.set(k, it);
    return it.value;
  }
  set(url, value) {
    const k = this._key(url);
    // 超上限时淘汰最老的（Map 第一个）
    if (this.map.size >= this.max && !this.map.has(k)) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, { value, ts: Date.now(), last: Date.now() });
  }
  get size() {
    return this.map.size;
  }
  /** 清理过期项（定时或按需调用） */
  purgeExpired() {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.ts > this.ttlMs) this.map.delete(k);
    }
  }
}
const resultCache = MX_CACHE_ENABLE
  ? new LRUCache(MX_CACHE_MAX, MX_CACHE_TTL * 1000)
  : null;
// 定期清理过期缓存（每 5 分钟）
if (resultCache) {
  setInterval(() => resultCache.purgeExpired(), 5 * 60 * 1000).unref();
}

// ============================================================
// 4. 信号量（并发控制）：限制同时解析数量
// ============================================================
class Semaphore {
  constructor(max, queueTimeoutMs) {
    this.max = max;
    this.queueTimeoutMs = queueTimeoutMs;
    this.current = 0;
    /** @type {Array<{resolve:Function,reject:Function,timer:NodeJS.Timeout}>} */
    this.queue = [];
  }
  acquire() {
    return new Promise((resolve, reject) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        // 从队列中移除自身
        const idx = this.queue.findIndex((q) => q.resolve === resolve);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(`请求排队超时（队列积压，当前并发上限 ${this.max}）`));
      }, this.queueTimeoutMs);
      this.queue.push({ resolve, reject, timer });
    });
  }
  release() {
    this.current = Math.max(0, this.current - 1);
    if (this.queue.length > 0 && this.current < this.max) {
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        this.current++;
        next.resolve();
      }
    }
  }
}
const parseSem = new Semaphore(MX_MAX_CONCURRENT, MX_REQUEST_QUEUE_TIMEOUT);

// ============================================================
// 4.5 万能嗅探结果缓存 & 独立并发信号量
// ============================================================

/** 万能嗅探 LRU 缓存（key = 视频页 URL，value = 完整嗅探结果 JSON） */
const universalCache =
  MX_UNIVERSAL_ENABLE && MX_UNIVERSAL_TTL > 0
    ? new LRUCache(MX_UNIVERSAL_CACHE_MAX, MX_UNIVERSAL_TTL * 1000)
    : null;
if (universalCache) {
  setInterval(() => universalCache.purgeExpired(), 5 * 60 * 1000).unref();
}

/**
 * 万能嗅探对外并发控制（防止第三方接口请求把我方带宽/CPU 打爆）
 * 注意：和 Puppeteer 解析用的 parseSem 分开，互不影响。
 */
const universalSem = new Semaphore(
  Math.max(1, MX_UNIVERSAL_CONCURRENCY * 3), // 对外整体并发上限：内部并发 × 3
  MX_REQUEST_QUEUE_TIMEOUT
);

// ============================================================
// 4.6 万能嗅探核心引擎
//   思路：
//     1) 将视频页 URL 追加到每个第三方接口 base 后作为请求地址
//     2) 以「限流并发（MX_UNIVERSAL_CONCURRENCY）」同时请求所有接口
//     3) 每个接口：通过多策略组合提取播放地址（3xx 跳转 / JSON 字段 / HTML/JS 正则 / <video>/<iframe> src）
//     4) 全部结果去重 + 最多返回 MX_UNIVERSAL_MAX_RESULTS 条
//     5) 可选「命中 N 条提前返回」（MX_UNIVERSAL_EARLY_HITS > 0 时生效）
// ============================================================

/**
 * 扩展的视频 URL 正则：除了 m3u8 还匹配 mp4/flv/ts/webm/mkv
 *   注意：JSON/HTML/JS 里经常带 \/ 转义斜杠，后续统一 replace(/\\\//g, '/')
 */
const VIDEO_URL_REGEX =
  /https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv|ts|webm|mkv|m3u|mpd)(\?[^\s"'<>\\]*)?/g;

/**
 * 从任意文本（HTML/JSON/JS 字符串）中提取去重后的视频播放地址
 * @param {string} text
 * @returns {string[]}
 */
function extractVideoUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const s = text.replace(/\\\//g, '/');
  const set = new Set();
  const re = new RegExp(VIDEO_URL_REGEX.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) set.add(m[0]);
  // 兜底：有些接口把 m3u8 放在 "url": "xxx" 里但不加扩展名，尝试 key-value 方式
  try {
    // 匹配常见 JSON 结构："url"/"play"/"video"/"src"/"m3u8" : "http(s)://..."
    const kvRe = /"(?:url|play(?:url)?|video(?:Url)?|src|m3u8|link|playurl|vod(?:url)?)"\s*:\s*"(https?:\/\/[^"\\]+(?:\\\/[^"\\]*)*)"/gi;
    let km;
    while ((km = kvRe.exec(text)) !== null) {
      const cand = km[1].replace(/\\\//g, '/');
      // 必须看起来像视频：包含视频扩展名 或 域名里有 vod/cdn/video/m3u8 等关键词
      if (/\.(m3u8|mp4|flv|ts|webm|mkv|m3u|mpd)(\?|$)/i.test(cand) || /(vod|cdn|video|m3u8|hls|dash|playback|media)/i.test(cand)) {
        set.add(cand);
      }
    }
  } catch (e) { /* 忽略 */ }
  return [...set];
}

/**
 * 从任意 JSON 对象里递归查找视频 URL（深度优先，不递归循环引用）
 */
function walkJsonForVideoUrls(obj, out, seen) {
  seen = seen || new WeakSet();
  out = out || new Set();
  if (!obj) return out;
  if (typeof obj === 'string') {
    extractVideoUrls(obj).forEach((u) => out.add(u));
    return out;
  }
  if (typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const it of obj) walkJsonForVideoUrls(it, out, seen);
    return out;
  }
  if (seen.has(obj)) return out;
  try { seen.add(obj); } catch (e) { /* 非对象可忽略 */ }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') {
      // 键名暗示是视频 URL：直接加入，不强校验扩展名
      if (/(^|[^a-z])(url|play(?:url)?|video(?:Url)?|src|m3u8|link|playurl|vod(?:url)?|file)$/i.test(k) && /^https?:\/\//i.test(v)) {
        out.add(v.replace(/\\\//g, '/'));
      } else {
        extractVideoUrls(v).forEach((u) => out.add(u));
      }
    } else if (typeof v === 'object') {
      walkJsonForVideoUrls(v, out, seen);
    }
  }
  return out;
}

/**
 * 构造 undici ProxyAgent（若 MX_UNIVERSAL_PROXY 存在 & undici 可用）
 *   返回值可直接传给 fetch 的 dispatcher 参数；否则返回 undefined。
 */
function makeProxyDispatcher() {
  if (!MX_UNIVERSAL_PROXY) return undefined;
  try {
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(MX_UNIVERSAL_PROXY);
  } catch (e) {
    // 没有 undici：把代理写进 env 让 fetch 的底层可能用到
    process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || MX_UNIVERSAL_PROXY;
    process.env.HTTP_PROXY = process.env.HTTP_PROXY || MX_UNIVERSAL_PROXY;
    return undefined;
  }
}

/**
 * 单第三方接口的请求 + 解析
 * @param {string} providerBase 第三方接口 base（如 https://jx.xmflv.cc/?url=）
 * @param {string} videoUrl 视频页 URL
 * @returns {Promise<{provider:string,ok:boolean,urls:string[],cost:number,error?:string,http?:number}>}
 */
async function sniffOne(providerBase, videoUrl) {
  const dispatcher = makeProxyDispatcher();
  const started = Date.now();
  /** 跟随过程中得到的最终 URL（若 3xx 跳转，其本身可能就是视频） */
  let finalUrl = '';
  let httpStatus = 0;
  try {
    // 第三方接口请求格式：直接 ?url= 或 ?jx= 等拼接，providerBase 通常已经带 '?xxx='
    const sep = providerBase.includes('?') ? '' : '?';
    const urlKey = /[?&](jx|v|vid|id|parse|jiexi)=/.test(providerBase) ? '' : 'url=';
    const reqUrl = `${providerBase}${sep}${urlKey}${encodeURIComponent(videoUrl)}`;
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), MX_UNIVERSAL_TIMEOUT);

    // redirect: 'follow' 默认会跟随最多 20 次；同时我们自己记录最终 URL
    const res = await fetch(reqUrl, {
      headers: {
        'User-Agent': MX_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: new URL(reqUrl).origin + '/'
      },
      redirect: 'follow',
      signal: controller.signal,
      // @ts-ignore
      dispatcher
    }).finally(() => clearTimeout(tm));

    httpStatus = res.status;
    finalUrl = res.url || reqUrl;

    const found = new Set();

    // 策略 1：如果最终 URL 本身就是视频 → 直接算命中（3xx 跳转到 m3u8 的情况）
    if (/\.(m3u8|mp4|flv|ts|webm|mkv|m3u|mpd)(\?|$)/i.test(finalUrl)) {
      found.add(finalUrl);
    }

    // 策略 2：Content-Type 决定是否读 body
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('image/') || ct.includes('video/')) {
      // 纯图片/视频响应：URL 本身就是结果
      if (!found.size) found.add(finalUrl);
    } else {
      // 文本类响应：先截到 2MB 就够了（第三方解析页不会太大）
      const MAX_BODY = 2 * 1024 * 1024;
      let bodyText = '';
      // @ts-ignore
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        while (got < MAX_BODY) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          chunks.push(value);
          if (got >= MAX_BODY) {
            try { reader.cancel(); } catch (e) { /* 忽略 */ }
            break;
          }
        }
        const buf = Buffer.concat(chunks);
        bodyText = buf.toString('utf8');
      } else {
        bodyText = await res.text();
        if (bodyText.length > MAX_BODY) bodyText = bodyText.slice(0, MAX_BODY);
      }

      // 策略 3：尝试解析 JSON（接口可能直接返回 {url:"..."}）
      let jsonObj = null;
      const t1 = bodyText.trim();
      if ((t1.startsWith('{') && t1.endsWith('}')) || (t1.startsWith('[') && t1.endsWith(']'))) {
        try { jsonObj = JSON.parse(t1); } catch (e) { jsonObj = null; }
      } else if (/\(\s*\{[\s\S]*\}\s*\)\s*;?\s*$/.test(t1)) {
        // JSONP：callback({...})，剥掉外层再 parse
        try {
          const inner = t1.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '');
          jsonObj = JSON.parse(inner);
        } catch (e) { jsonObj = null; }
      }
      if (jsonObj !== null) {
        walkJsonForVideoUrls(jsonObj, found);
      }

      // 策略 4：对 body 做正则扫（HTML / JS / 纯文本 通用）
      extractVideoUrls(bodyText).forEach((u) => found.add(u));

      // 策略 5：HTML 专用 —— 抓 <video>/<source>/<iframe>/<embed>/<frame> 的 src/data 属性
      if (/<html|<video|<iframe|<source|<script/i.test(bodyText)) {
        const tagRe = /<(video|source|iframe|embed|frame|script)[^>]*?\s(?:src|data|poster)\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
        let tm2;
        while ((tm2 = tagRe.exec(bodyText)) !== null) {
          const u = (tm2[2] || '').replace(/\\\//g, '/');
          if (/^https?:\/\//i.test(u)) extractVideoUrls(u).forEach((x) => found.add(x));
        }
      }
    }

    const urls = [...found].slice(0, MX_UNIVERSAL_MAX_RESULTS + 5);
    return {
      provider: providerBase,
      ok: urls.length > 0,
      urls,
      cost: Date.now() - started,
      http: httpStatus
    };
  } catch (err) {
    const e = err && err.name === 'AbortError'
      ? '超时 (' + (Date.now() - started) + 'ms)'
      : (err && err.message ? err.message.split('\n')[0] : String(err));
    return {
      provider: providerBase,
      ok: false,
      urls: [],
      cost: Date.now() - started,
      error: e,
      http: httpStatus
    };
  }
}

/**
 * 并发执行多个异步任务（简单 p-limit 实现：最大 N 路并发）
 * @param {Array<()=>Promise<T>>} tasks 任务函数数组
 * @param {number} limit 并发上限
 * @returns {Promise<T[]>}
 * @template T
 */
async function runWithLimit(tasks, limit) {
  limit = Math.max(1, Math.min(limit || 1, tasks.length));
  const results = new Array(tasks.length);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); } catch (e) { results[i] = e; }
    }
  }
  const workers = [];
  for (let i = 0; i < limit; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 万能嗅探总入口：并发请求所有 providers，汇总去重后返回
 * @param {string} videoUrl
 * @param {Object} opts
 * @param {(e:any)=>void} [opts.onProgress] 可选进度回调（每完成一个接口调用一次）
 * @returns {Promise<Object>}
 */
async function runUniversalSniff(videoUrl, opts) {
  opts = opts || {};
  const providers = MX_UNIVERSAL_PROVIDERS;
  const total = providers.length;

  // 所有接口的单结果收集对象
  /** @type {Array<any>} */
  const perResult = new Array(total).fill(null);
  let finishedCount = 0;
  let hitCount = 0;
  /** 提前结束标志（达到 MX_UNIVERSAL_EARLY_HITS） */
  let stopped = false;

  const tasks = providers.map((base, i) => async () => {
    if (stopped) {
      perResult[i] = { provider: base, ok: false, urls: [], cost: 0, error: 'skipped(early return)' };
      finishedCount++;
      return;
    }
    const r = await sniffOne(base, videoUrl);
    perResult[i] = r;
    finishedCount++;
    if (r.ok) hitCount += r.urls.length;
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress({ index: i, total, finished: finishedCount, result: r }); } catch (e) { /* 忽略 */ }
    }
    // 命中阈值提前停止（未完成的任务会被标记为 skipped）
    if (!stopped && MX_UNIVERSAL_EARLY_HITS > 0 && hitCount >= MX_UNIVERSAL_EARLY_HITS) {
      stopped = true;
    }
  });

  const startedAll = Date.now();
  await runWithLimit(tasks, MX_UNIVERSAL_CONCURRENCY);
  const totalCost = Date.now() - startedAll;

  // 汇总 & 去重（保留第一个命中来源）
  const dedup = new Map(); // url -> {from:provider,cost}
  for (const r of perResult) {
    if (!r || !r.ok) continue;
    for (const u of r.urls) {
      if (!dedup.has(u)) {
        dedup.set(u, { from: r.provider, cost: r.cost });
      }
    }
    if (dedup.size >= MX_UNIVERSAL_MAX_RESULTS) break;
  }
  const dedupList = [];
  for (const [url, meta] of dedup) {
    if (dedupList.length >= MX_UNIVERSAL_MAX_RESULTS) break;
    // 按扩展名给 quality 打分（简单猜测，越高越好）
    let quality = 0;
    if (/\.m3u8/i.test(url)) quality += 30;
    if (/\.mp4/i.test(url)) quality += 25;
    if (/(4k|1080|2160|hdr|uhd)/i.test(url)) quality += 20;
    if (/(720|hd)/i.test(url)) quality += 10;
    dedupList.push({ url, from: meta.from, providerCostMs: meta.cost, quality });
  }
  // 按 quality 从高到低
  dedupList.sort((a, b) => b.quality - a.quality);

  // 统计
  const okCount = perResult.filter((r) => r && r.ok).length;
  const failCount = perResult.length - okCount;

  return {
    code: dedupList.length > 0 ? 200 : 404,
    videoUrl,
    totalCostMs: totalCost,
    totalProviders: total,
    finished: finishedCount,
    successProviders: okCount,
    failedProviders: failCount,
    earlyStopped: stopped,
    results: dedupList,           // 去重后的播放地址（推荐前端直接用此列表）
    perProvider: perResult        // 每个接口详细状态（后台调试页用）
  };
}

// ============================================================
// 5. 浏览器单例池 + 页面池（性能核心）
// ============================================================

/**
 * 封装一个带 Page 池的浏览器实例
 *  - 浏览器启动一次后常驻，不会每次请求都 launch/close
 *  - Page 用完放入空闲池，下次优先复用
 */
class BrowserWrapper {
  constructor(launchOpts) {
    this.launchOpts = launchOpts;
    this.browser = null;
    /** @type {import('puppeteer').Page[]} 空闲 Page 池 */
    this.idlePages = [];
    this.inited = false;
  }
  async init() {
    if (this.inited) return;
    this.browser = await puppeteer.launch(this.launchOpts);
    // 监听浏览器崩溃，自动重启
    this.browser.on('disconnected', async () => {
      console.warn('[超级嗅探] 浏览器 disconnected，正在重启...');
      this.inited = false;
      this.idlePages = [];
      try {
        await this.init();
      } catch (e) {
        console.error('[超级嗅探] 浏览器重启失败: ' + e.message);
      }
    });
    this.inited = true;
  }
  /** 获取一个 Page，优先复用空闲池 */
  async acquirePage() {
    if (!this.inited) await this.init();
    if (this.idlePages.length > 0) {
      const page = this.idlePages.pop();
      // 检查页面是否已关闭
      try {
        if (!page.isClosed()) return page;
      } catch (e) { /* closed */ }
    }
    // 池未满：新建
    if (this.idlePages.length + this._activePagesEstimate < MX_PAGE_POOL_SIZE) {
      const page = await this.browser.newPage();
      await this._setupPageDefaults(page);
      return page;
    }
    // 池满：等待最早归还（简化：直接新建也可以，这里保守新建）
    const page = await this.browser.newPage();
    await this._setupPageDefaults(page);
    return page;
  }
  /** 归还 Page 到空闲池 */
  async releasePage(page) {
    if (!page) return;
    try {
      if (page.isClosed()) return;
      // 清理：回到 about:blank，释放原页面内存
      try { await page.goto('about:blank', { timeout: 5000, waitUntil: 'domcontentloaded' }); } catch (e) {}
      if (this.idlePages.length < MX_PAGE_POOL_SIZE) {
        this.idlePages.push(page);
      } else {
        try { await page.close(); } catch (e) {}
      }
    } catch (e) {
      try { await page.close().catch(() => {}); } catch (_) {}
    }
  }
  /** 给新 Page 做默认配置 */
  async _setupPageDefaults(page) {
    await page.setUserAgent(MX_USER_AGENT);
    await page.setViewport({ width: MX_VIEWPORT_W, height: MX_VIEWPORT_H });
    // 屏蔽图片/字体/媒体，加速加载 & 省带宽（不影响 m3u8 捕获）
    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const rt = req.resourceType();
        if (rt === 'image' || rt === 'font' || rt === 'media') {
          req.abort().catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      });
    } catch (e) {
      // 某些 puppeteer 版本请求拦截设置失败不致命
    }
  }
  get _activePagesEstimate() {
    // 粗略估算，足够用
    try {
      return this.browser ? (this.browser.pages ? 0 : 0) : 0;
    } catch (e) { return 0; }
  }
  async close() {
    try {
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (_) {}
    this.inited = false;
    this.idlePages = [];
  }
}

/** 浏览器实例数组 */
const browserPool = [];

/** 初始化所有浏览器实例（服务启动时调用一次） */
async function initBrowserPool() {
  const executablePath = checkChrome();
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
    '--disable-infobars',
    '--window-position=0,0',
    '--ignore-certificate-errors',
    '--ignore-ssl-errors'
  ];
  // 用户自定义额外参数（以 JSON 数组字符串传入，高级用户用）
  if (process.env.MX_CHROME_ARGS) {
    try {
      const extra = JSON.parse(process.env.MX_CHROME_ARGS);
      if (Array.isArray(extra)) launchArgs.push(...extra.filter((x) => typeof x === 'string'));
    } catch (e) {
      console.warn('[超级嗅探] MX_CHROME_ARGS 不是合法 JSON 数组，已忽略');
    }
  }
  const size = Math.max(1, Math.min(5, MX_BROWSER_POOL_SIZE));
  for (let i = 0; i < size; i++) {
    const bw = new BrowserWrapper({
      executablePath,
      headless: MX_CHROME_HEADLESS ? 'new' : false,
      args: launchArgs,
      ignoreHTTPSErrors: true
    });
    await bw.init();
    browserPool.push(bw);
    console.log(`[超级嗅探] 浏览器实例 ${i + 1}/${size} 启动完成`);
  }
}
/** 轮询获取浏览器（简单负载均衡） */
let _browserRobin = 0;
function nextBrowser() {
  const b = browserPool[_browserRobin % browserPool.length];
  _browserRobin++;
  return b;
}

// ============================================================
// 6. 核心解析逻辑
// ============================================================

/**
 * 核心解析函数：给定视频 URL，返回第一个 m3u8 地址（或 null）
 * 性能关键：
 *  - 请求/响应拦截是「实时捕获」，有 EarlyReturnPromise 一旦捕获就提前结束
 *  - 扫描页面/iframe 为兜底
 */
async function sniffVideoUrl(videoUrl) {
  const bw = nextBrowser();
  let page = null;
  /** 保存所有捕获到的 m3u8 */
  const m3u8Urls = new Set();
  /** 找到即返回：外部提前 resolve */
  let earlyResolve = null;
  const earlyPromise = MX_EARLY_RETURN
    ? new Promise((resolve) => { earlyResolve = resolve; })
    : null;

  const checkAndResolve = () => {
    if (earlyResolve && m3u8Urls.size > 0) {
      earlyResolve();
    }
  };

  try {
    page = await bw.acquirePage();

    // 移除默认 request 拦截，重新加上带 m3u8 捕获的版本
    page.removeAllListeners('request');
    page.removeAllListeners('response');
    try { await page.setRequestInterception(true); } catch (e) {}

    // --- 方式一：请求拦截 ---
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        m3u8Urls.add(url);
        checkAndResolve();
      }
      // 资源屏蔽（除 image/font/media 已在 setupPageDefaults 处理，这里精确判断）
      const rt = request.resourceType();
      if (rt === 'image' || rt === 'font' || rt === 'media') {
        request.abort().catch(() => {});
        return;
      }
      request.continue().catch(() => {});
    });

    // --- 方式二：响应体扫描（可选） ---
    if (MX_SNIFF_RESPONSE_BODY) {
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('.m3u8')) {
          m3u8Urls.add(url);
          checkAndResolve();
        }
        if (isTextResponse(response.headers())) {
          try {
            const text = await response.text();
            extractFromText(text).forEach((u) => {
              m3u8Urls.add(u);
            });
            if (m3u8Urls.size > 0) checkAndResolve();
          } catch (e) { /* 忽略 */ }
        }
      });
    }

    // --- 打开页面（导航失败不致命，已捕获的请求可能已经有了） ---
    const gotoPromise = page.goto(videoUrl, {
      waitUntil: 'networkidle2',
      timeout: MX_PARSE_TIMEOUT
    }).catch((e) => {
      console.log('[超级嗅探] 页面导航异常（非致命）: ' + e.message.split('\n')[0]);
    });

    // --- 竞态：goto + 超时  vs  early return ---
    if (MX_EARLY_RETURN) {
      // 有 earlyPromise 时：goto 完成后等待 EXTRA_WAIT，但只要 earlyPromise resolve 就立刻跳出
      await gotoPromise;
      await Promise.race([
        earlyPromise,
        new Promise((r) => setTimeout(r, MX_EXTRA_WAIT))
      ]);
    } else {
      // 无 early return：老实等 goto + EXTRA_WAIT
      await gotoPromise;
      await new Promise((r) => setTimeout(r, MX_EXTRA_WAIT));
    }

    // --- 方式三：扫描最终页面 HTML ---
    try {
      const content = await page.content();
      extractFromText(content).forEach((u) => m3u8Urls.add(u));
    } catch (e) { /* 忽略 */ }

    // --- 方式四：扫描所有 iframe（可选） ---
    if (MX_SNIFF_IFRAME) {
      try {
        for (const frame of page.frames()) {
          try {
            const fc = await frame.content();
            extractFromText(fc).forEach((u) => m3u8Urls.add(u));
          } catch (e) { /* 单个 frame 失败不影响 */ }
        }
      } catch (e) { /* 忽略 */ }
    }

    return m3u8Urls.size > 0 ? [...m3u8Urls][0] : null;
  } finally {
    // 归还 page
    if (page) {
      page.removeAllListeners('request');
      page.removeAllListeners('response');
      // 不 await，避免阻塞响应
      setImmediate(() => bw.releasePage(page));
    }
  }
}

// ============================================================
// 7. Express App & 路由
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));

// 访问日志（简单打印，生产可用 winston 替换）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    const hit = res.getHeader('X-Cache') || '';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${dur}ms ${hit}`);
  });
  next();
});

// ---------- 7.1 解析主接口 ----------
app.get('/node.js', async (req, res) => {
  const videoUrl = (req.query.url || '').trim();

  if (!videoUrl) return res.json({ code: 400, msg: '请提供需要解析的链接' });
  if (!isValidUrl(videoUrl)) return res.json({ code: 400, msg: '链接格式不正确' });

  // 如果本身就是 m3u8，直接返回（最快路径，零开销）
  if (/\.m3u8/i.test(videoUrl)) {
    res.setHeader('X-Cache', 'DIRECT-M3U8');
    return res.json({ code: 200, url: videoUrl });
  }

  // --- 查缓存 ---
  if (resultCache) {
    const hit = resultCache.get(videoUrl);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(hit);
    }
  }

  // --- 进入并发控制 + 解析 ---
  let semAcquired = false;
  try {
    await parseSem.acquire();
    semAcquired = true;
    const url = await sniffVideoUrl(videoUrl);
    let resp;
    if (url) {
      resp = { code: 200, url };
    } else {
      resp = { code: 404, msg: '未找到播放链接' };
    }
    if (resultCache && resp.code === 200) resultCache.set(videoUrl, resp);
    if (resultCache) res.setHeader('X-Cache', 'MISS');
    return res.json(resp);
  } catch (err) {
    return res.json({ code: 500, msg: '解析失败: ' + err.message });
  } finally {
    if (semAcquired) parseSem.release();
  }
});

// ---------- 7.1B 万能嗅探对外接口（第三方接口并发解析，返回多条播放地址） ----------
app.get('/sniff', async (req, res) => {
  if (!MX_UNIVERSAL_ENABLE) {
    return res.json({ code: 503, msg: '万能嗅探模块未启用（MX_UNIVERSAL_ENABLE=false）' });
  }
  const videoUrl = (req.query.url || '').trim();
  if (!videoUrl) return res.json({ code: 400, msg: '请提供需要解析的链接' });
  if (!isValidUrl(videoUrl)) return res.json({ code: 400, msg: '链接格式不正确' });
  // m3u8 直通：没必要走第三方
  if (/\.(m3u8|mp4|flv|ts|webm|mkv)(\?|$)/i.test(videoUrl)) {
    res.setHeader('X-Cache', 'DIRECT-VIDEO');
    return res.json({
      code: 200,
      videoUrl,
      totalCostMs: 0,
      totalProviders: 0,
      finished: 0,
      successProviders: 0,
      failedProviders: 0,
      earlyStopped: false,
      results: [{ url: videoUrl, from: 'direct', providerCostMs: 0, quality: 50 }],
      perProvider: []
    });
  }
  // 查缓存（万能嗅探结果比单解析大，但 TTL 内可节省 18 次请求）
  if (universalCache) {
    const hit = universalCache.get(videoUrl);
    if (hit) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(hit);
    }
  }
  // 对外整体并发控制
  let semAcq = false;
  try {
    await universalSem.acquire();
    semAcq = true;
    const detailed = (req.query.detailed || '1') === '1';
    const out = await runUniversalSniff(videoUrl, {});
    // 默认不给前端返回 perProvider（数据量大），只在 detailed=1 时返回
    const perProvider = detailed ? out.perProvider : undefined;
    const resp = { ...out, perProvider };
    if (universalCache && out.code === 200) universalCache.set(videoUrl, resp);
    res.setHeader('X-Cache', 'MISS');
    return res.json(resp);
  } catch (err) {
    return res.json({ code: 500, msg: '万能嗅探失败: ' + err.message });
  } finally {
    if (semAcq) universalSem.release();
  }
});

// ---------- 7.2 健康检查 / 状态 ----------
app.get('/', (req, res) => {
  res.json({
    code: 200,
    msg: '超级嗅探解析服务运行中',
    port: MX_PORT,
    version: updater.getCurrentVersion(),
    cache: MX_CACHE_ENABLE ? { enabled: true, size: resultCache.size, ttl: MX_CACHE_TTL } : { enabled: false },
    concurrent: { max: MX_MAX_CONCURRENT, current: parseSem.current, queue: parseSem.queue.length },
    universal: MX_UNIVERSAL_ENABLE
      ? {
          enabled: true,
          providers: MX_UNIVERSAL_PROVIDERS.length,
          concurrency: MX_UNIVERSAL_CONCURRENCY,
          timeoutMs: MX_UNIVERSAL_TIMEOUT,
          cacheSize: universalCache ? universalCache.size : 0,
          ttl: MX_UNIVERSAL_TTL,
          maxResults: MX_UNIVERSAL_MAX_RESULTS
        }
      : { enabled: false }
  });
});

// ============================================================
// 8. 后台管理 & 在线更新（带 Basic Auth）
// ============================================================

/**
 * Basic Auth 中间件：保护所有 /admin 路由
 *  - 若 MX_ADMIN_USER / MX_ADMIN_PASS 未设置，直接放行（但启动时会提示警告）
 *  - 已设置则校验 Authorization 头
 */
function adminAuth(req, res, next) {
  if (!ADMIN_AUTH_ENABLED) return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Super Sniffer Admin"');
    return res.status(401).send('需要管理员账号密码登录');
  }
  try {
    const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (u === MX_ADMIN_USER && p === MX_ADMIN_PASS) return next();
  } catch (e) {}
  res.setHeader('WWW-Authenticate', 'Basic realm="Super Sniffer Admin"');
  return res.status(401).send('账号或密码错误');
}
// 后台全部路由先过 auth
app.use('/admin', adminAuth);

// 后台管理页面
app.get('/admin', (req, res) => {
  const adminFile = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminFile)) {
    res.sendFile(adminFile);
  } else {
    res.status(404).send('后台页面不存在，请重新更新源码');
  }
});

// 万能嗅探测试页（内联 HTML + 前端 JS，展示多接口并发进度、结果汇总、一键试播）
app.get('/admin/sniff', (req, res) => {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>超级嗅探 - 万能嗅探测试页</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#f5f7fb; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif; color:#222; }
  header { background: linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; padding: 20px 28px; }
  header h1 { margin:0; font-size: 20px; }
  header p  { margin:6px 0 0; opacity:.92; font-size: 13px; }
  .wrap { max-width: 1180px; margin: 22px auto; padding: 0 20px; }
  .card { background:#fff; border:1px solid #e6e8ef; border-radius: 10px; padding: 18px 20px; box-shadow: 0 2px 10px rgba(20,30,80,.04); margin-bottom: 18px; }
  .row { display:flex; gap:10px; flex-wrap: wrap; align-items: center; }
  input[type=text] { flex:1; min-width:320px; padding:11px 13px; border:1px solid #cfd3df; border-radius: 8px; font-size: 14px; outline:none; transition:.2s; }
  input[type=text]:focus { border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.15); }
  button { padding:11px 18px; border:0; border-radius: 8px; background:#6366f1; color:#fff; font-size: 14px; cursor:pointer; font-weight:600; transition:.2s; }
  button:hover:not(:disabled) { background:#4f46e5; }
  button:disabled { opacity:.55; cursor: not-allowed; background:#94a3b8; }
  button.secondary { background:#eef2ff; color:#4338ca; }
  button.secondary:hover:not(:disabled) { background:#e0e7ff; }
  .summary { display:grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 12px; margin-bottom: 4px; }
  .stat { background:#f8fafc; border:1px solid #eef0f6; border-radius: 8px; padding: 10px 12px; }
  .stat .k { font-size: 12px; color:#64748b; }
  .stat .v { font-size: 18px; font-weight: 700; color:#0f172a; margin-top:3px; }
  .ok { color:#16a34a !important; } .fail { color:#dc2626 !important; }
  h2 { font-size: 15px; margin: 0 0 10px; color:#0f172a; display:flex; align-items:center; gap:8px; }
  h2 .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background:#eef2ff; color:#4338ca; font-weight:500; }
  .providers { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px; }
  .p-item { display:flex; align-items:center; gap: 10px; padding: 8px 10px; border:1px solid #eef0f6; border-radius: 8px; background:#fafbff; font-size: 13px; }
  .p-item .idx { width: 28px; text-align:center; font-weight: 700; color:#6366f1; }
  .p-item .host { flex:1; min-width:0; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; color:#334155; }
  .p-item .st { min-width: 140px; text-align: right; font-size: 12px; }
  .st-wait { color:#94a3b8; } .st-run { color:#2563eb; } .st-ok { color:#16a34a; } .st-fail { color:#dc2626; }
  .progress { height:6px; background:#eef0f6; border-radius: 999px; overflow:hidden; margin-top: 10px; }
  .progress > span { display:block; height:100%; background: linear-gradient(90deg,#6366f1,#8b5cf6); width:0%; transition: width .25s; }
  .results { display:grid; grid-template-columns: 1fr; gap: 10px; }
  .res { border: 1px solid #e6e8ef; border-left: 4px solid #6366f1; border-radius: 8px; padding: 12px 14px; background:#fbfbff; }
  .res .q { display:inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background:#ede9fe; color:#6d28d9; margin-right: 6px; }
  .res .url { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color:#0f172a; }
  .res .meta { margin-top:6px; font-size: 12px; color:#64748b; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .res .btns { margin-left:auto; display:flex; gap:6px; }
  .res a.btn, .res button.btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; background:#eef2ff; color:#4338ca; text-decoration:none; border:0; cursor:pointer; }
  .res a.btn:hover, .res button.btn:hover { background:#e0e7ff; }
  .msg { padding: 10px 14px; border-radius:8px; font-size: 13px; }
  .msg-warn { background:#fff7ed; color:#9a3412; border:1px solid #fed7aa; }
  .msg-info { background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe; }
  video { max-width: 100%; background:#000; border-radius: 8px; border: 1px solid #e6e8ef; }
  a.back { display:inline-block; margin: 6px 0 16px; color:#6366f1; text-decoration: none; font-size: 13px; }
  a.back:hover { text-decoration: underline; }
  @media (max-width: 860px) {
    .summary { grid-template-columns: repeat(3,1fr); }
    .providers { grid-template-columns: 1fr; }
    input[type=text] { min-width: 0; width: 100%; }
  }
</style>
</head>
<body>
<header>
  <h1>🔎 万能嗅探测试页（多线程并发）</h1>
  <p>输入 VIP 视频页地址，同时并发请求多个第三方解析接口，自动汇总去重并按画质排序返回播放地址</p>
</header>
<div class="wrap">
  <a class="back" href="/admin">← 返回后台首页</a>

  <div class="card">
    <div class="row">
      <input id="url" type="text" placeholder="视频页面地址，例如 https://v.qq.com/x/cover/xxxxxx.html" />
      <button id="go"   type="button">🚀 开始嗅探</button>
      <button id="stop" class="secondary" type="button" disabled>⏹ 停止</button>
    </div>
    <div id="tip" class="msg msg-info" style="margin-top:12px;">
      提示：默认并发 <b id="conf-conc">6</b> 路，共 <b id="conf-cnt">18</b> 个第三方接口；如果本地访问不到某些接口，可通过环境变量 <code>MX_UNIVERSAL_PROXY</code> 设置代理，或 <code>MX_UNIVERSAL_PROVIDERS_JSON</code> 自定义列表。
    </div>
  </div>

  <div class="card">
    <h2>📊 进度 & 统计 <span class="badge" id="stat-stage">等待开始</span></h2>
    <div class="summary">
      <div class="stat"><div class="k">总耗时</div><div class="v" id="s-cost">0ms</div></div>
      <div class="stat"><div class="k">总接口数</div><div class="v" id="s-total">0</div></div>
      <div class="stat"><div class="k">已完成</div><div class="v" id="s-done">0</div></div>
      <div class="stat"><div class="k">成功接口</div><div class="v ok" id="s-ok">0</div></div>
      <div class="stat"><div class="k">失败接口</div><div class="v fail" id="s-fail">0</div></div>
      <div class="stat"><div class="k">唯一播放源</div><div class="v" id="s-src">0</div></div>
    </div>
    <div class="progress"><span id="bar"></span></div>
  </div>

  <div class="card">
    <h2>🧩 第三方接口状态</h2>
    <div class="providers" id="providers"></div>
  </div>

  <div class="card">
    <h2>🎬 嗅探结果（按画质排序，已去重）<span class="badge" id="res-badge">等待结果</span></h2>
    <div id="results" class="results"></div>
    <div id="player" style="margin-top: 14px; display:none;">
      <h2 style="margin-top: 14px;">▶️ 当前试播</h2>
      <video id="video" controls playsinline></video>
    </div>
  </div>
</div>

<script>
let providers = [];
let es = null;
let stopped = false;
let playerShown = false;

async function boot() {
  try {
    const p = await fetch('/admin/api/providers').then(r => r.json());
    providers = p.providers || [];
    document.getElementById('conf-cnt').textContent = providers.length;
    document.getElementById('conf-conc').textContent = p.concurrency;
  } catch (e) {}
  renderProviders();
}

function renderProviders() {
  const box = document.getElementById('providers');
  box.innerHTML = providers.map((u, i) => {
    const host = u.replace(/^https?:\/\//,'').split('?')[0];
    return \`<div class="p-item" data-idx="\${i}">
      <div class="idx">\${i+1}</div>
      <div class="host" title="\${u}">\${u}</div>
      <div class="st st-wait" data-s>\u23F3 等待中</div>
    </div>\`;
  }).join('');
}

function setStage(text) { document.getElementById('stat-stage').textContent = text; }
function stats(cost, done, ok, fail, src) {
  if (cost != null) document.getElementById('s-cost').textContent = cost + 'ms';
  if (done != null) document.getElementById('s-done').textContent = done;
  if (ok   != null) document.getElementById('s-ok').textContent   = ok;
  if (fail != null) document.getElementById('s-fail').textContent = fail;
  if (src  != null) document.getElementById('s-src').textContent  = src;
  const total = providers.length || 1;
  const pct = Math.min(100, Math.round((done || 0) / total * 100));
  document.getElementById('bar').style.width = pct + '%';
}

function updateOne(idx, r) {
  const row = document.querySelector('.p-item[data-idx="'+idx+'"]');
  if (!row) return;
  const st = row.querySelector('[data-s]');
  if (!r) { st.textContent = '⏳ 请求中'; st.className = 'st st-run'; return; }
  if (r.ok) { st.textContent = '✅ 成功 ' + r.urls.length + '个 (' + (r.cost||0) + 'ms)'; st.className = 'st st-ok'; }
  else      { st.textContent = '❌ ' + (r.error || ('HTTP ' + (r.http||'??'))) + ' (' + (r.cost||0) + 'ms)'; st.className = 'st st-fail'; }
}

function renderResults(results, totalCostMs) {
  const box = document.getElementById('results');
  if (!results || !results.length) {
    box.innerHTML = '<div class="msg msg-warn">没有嗅探到任何可用播放链接，建议稍后重试或更换视频 URL。</div>';
    document.getElementById('res-badge').textContent = '暂无结果';
    return;
  }
  document.getElementById('res-badge').textContent = '共 ' + results.length + ' 条，总耗时 ' + totalCostMs + 'ms';
  box.innerHTML = results.map((it, i) => \`<div class="res">
    <div>
      <span class="q">#\${i+1} 画质分 \${it.quality||0}</span>
      <span class="q" title="耗时">\${it.providerCostMs||0}ms</span>
      <div class="url">\${it.url}</div>
    </div>
    <div class="meta">
      <span>来源：\${(it.from||'').split('?')[0]}</span>
      <div class="btns">
        <button class="btn" data-play="\${encodeURIComponent(it.url)}">▶ 试播</button>
        <a class="btn" target="_blank" href="/node.js?url=\${encodeURIComponent(it.url)}">🔗 调用主解析</a>
        <a class="btn" target="_blank" href="\${it.url}">🌐 直接打开</a>
      </div>
    </div>
  </div>\`).join('');
  box.querySelectorAll('button[data-play]').forEach(b => {
    b.addEventListener('click', () => playVideo(decodeURIComponent(b.getAttribute('data-play'))));
  });
}

function playVideo(u) {
  const p = document.getElementById('player');
  const v = document.getElementById('video');
  p.style.display = 'block';
  v.src = u;
  v.play().catch(()=>{});
  if (!playerShown) { playerShown = true; p.scrollIntoView({behavior:'smooth', block:'center'}); }
}

function stop() {
  stopped = true;
  if (es) { try { es.close(); } catch(e){} es = null; }
  document.getElementById('stop').disabled = true;
  document.getElementById('go').disabled = false;
  setStage('已停止');
}

async function start() {
  const url = document.getElementById('url').value.trim();
  if (!url) { alert('请输入视频页面 URL'); return; }
  stopped = false;
  renderProviders();
  renderResults([]);
  stats(0, 0, 0, 0, 0);
  document.getElementById('go').disabled = true;
  document.getElementById('stop').disabled = false;
  setStage('嗅探中（流式进度）…');

  const startedAt = Date.now();
  let okN = 0, failN = 0, doneN = 0;
  const dedup = new Map();

  // ------- 用 SSE 接收每完成一个接口的实时进度 -------
  es = new EventSource('/admin/api/sniff-stream?url=' + encodeURIComponent(url));
  es.addEventListener('progress', (ev) => {
    if (stopped) return;
    const d = JSON.parse(ev.data);
    updateOne(d.index, d.result);
    doneN++;
    if (d.result && d.result.ok) {
      okN++;
      (d.result.urls || []).forEach(u => { if (!dedup.has(u)) dedup.set(u, { from: d.result.provider, providerCostMs: d.result.cost }); });
    } else {
      failN++;
    }
    stats(Date.now() - startedAt, doneN, okN, failN, dedup.size);
  });
  es.addEventListener('done', (ev) => {
    const fin = JSON.parse(ev.data);
    // 用后端去重 + 排序后的 results 渲染
    renderResults(fin.results || [], fin.totalCostMs || 0);
    stats(fin.totalCostMs, fin.finished, fin.successProviders, fin.failedProviders, (fin.results||[]).length);
    setStage(fin.results && fin.results.length ? '✅ 完成（' + fin.results.length + ' 个播放源）' : '⏹ 完成（未找到播放源）');
    document.getElementById('go').disabled = false;
    document.getElementById('stop').disabled = true;
    if (es) { try { es.close(); } catch(e){} es = null; }
  });
  es.addEventListener('error', (ev) => {
    // SSE 失败回退：直接调 /sniff 拿 JSON
    if (es) { try { es.close(); } catch(e){} es = null; }
    fallbackFetch(url, startedAt);
  });
}

async function fallbackFetch(url, startedAt) {
  try {
    setStage('SSE 不可用，回退普通 JSON…');
    const r = await fetch('/sniff?url=' + encodeURIComponent(url) + '&detailed=1').then(x => x.json());
    (r.perProvider || []).forEach((rr, i) => updateOne(i, rr));
    renderResults(r.results, r.totalCostMs || 0);
    stats(r.totalCostMs, r.finished, r.successProviders, r.failedProviders, (r.results||[]).length);
    setStage((r.results && r.results.length ? '✅ 完成（' + r.results.length + ' 个播放源）' : '⏹ 完成（未找到播放源）'));
  } catch (e) {
    alert('请求失败：' + e.message);
    setStage('❌ 请求失败');
  } finally {
    document.getElementById('go').disabled = false;
    document.getElementById('stop').disabled = true;
  }
}

document.getElementById('go').addEventListener('click', start);
document.getElementById('stop').addEventListener('click', stop);
document.getElementById('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

boot();
</script>
</body>
</html>`;
  res.type('html').send(html);
});

// 后台状态接口
app.get('/admin/api/status', (req, res) => {
  const chromeVersion = updater.getChromeVersion();
  const version = updater.getCurrentVersion();
  const sourceInfo = updater.getSourceInfo();
  res.json({
    code: 200,
    service: '运行中',
    port: MX_PORT,
    host: MX_HOST,
    version,
    chromeVersion,
    chromeInstalled: chromeVersion !== '未安装' && chromeVersion !== '不可用',
    updateSource: `${updater.GITHUB_OWNER}/${updater.GITHUB_REPO}`,
    source: sourceInfo.source,
    branch: sourceInfo.branch,
    sourceLabel: sourceInfo.label,
    adminAuth: ADMIN_AUTH_ENABLED,
    cache: MX_CACHE_ENABLE ? { enabled: true, size: resultCache.size, ttl: MX_CACHE_TTL, max: MX_CACHE_MAX } : { enabled: false },
    concurrent: { max: MX_MAX_CONCURRENT, current: parseSem.current, queue: parseSem.queue.length },
    browserPool: { size: browserPool.length, pagePoolSize: MX_PAGE_POOL_SIZE },
    universal: MX_UNIVERSAL_ENABLE
      ? {
          enabled: true,
          providers: MX_UNIVERSAL_PROVIDERS.length,
          concurrency: MX_UNIVERSAL_CONCURRENCY,
          timeoutMs: MX_UNIVERSAL_TIMEOUT,
          cacheSize: universalCache ? universalCache.size : 0,
          ttl: MX_UNIVERSAL_TTL,
          maxResults: MX_UNIVERSAL_MAX_RESULTS
        }
      : { enabled: false }
  });
});

// 返回万能嗅探的 provider 列表与并发配置（前端 UI 初始化用）
app.get('/admin/api/providers', (req, res) => {
  res.json({
    code: 200,
    enabled: MX_UNIVERSAL_ENABLE,
    concurrency: MX_UNIVERSAL_CONCURRENCY,
    timeoutMs: MX_UNIVERSAL_TIMEOUT,
    maxResults: MX_UNIVERSAL_MAX_RESULTS,
    earlyHits: MX_UNIVERSAL_EARLY_HITS,
    providers: MX_UNIVERSAL_PROVIDERS
  });
});

// SSE 流式万能嗅探：每完成一个 provider 推一条 progress，最终推 done（后台测试页使用）
app.get('/admin/api/sniff-stream', async (req, res) => {
  if (!MX_UNIVERSAL_ENABLE) {
    return res.status(503).type('text/plain').send('万能嗅探模块未启用');
  }
  const videoUrl = (req.query.url || '').trim();
  if (!videoUrl || !isValidUrl(videoUrl)) {
    return res.status(400).type('text/event-stream').send('event:error\ndata:"URL 无效"\n\n');
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (ev, obj) => {
    try {
      res.write('event: ' + ev + '\n');
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    } catch (e) { /* 客户端断开 */ }
  };
  let aborted = false;
  req.on('close', () => { aborted = true; });

  let semAcq = false;
  try {
    await universalSem.acquire();
    semAcq = true;
    const finalOut = await runUniversalSniff(videoUrl, {
      onProgress: (d) => {
        if (!aborted) send('progress', d);
      }
    });
    // 精简：去掉 perProvider（数据量大），只返回去重后的 results 汇总
    const donePayload = { ...finalOut };
    delete donePayload.perProvider;
    send('done', donePayload);
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    if (semAcq) universalSem.release();
    setTimeout(() => { try { res.end(); } catch (e) {} }, 200);
  }
});

// 获取当前更新源配置
app.get('/admin/api/update-source', (req, res) => {
  const info = updater.getSourceInfo();
  res.json({ code: 200, ...info });
});

// 切换更新源（stable 稳定版 / beta 先行版）
app.post('/admin/api/update-source', (req, res) => {
  const source = (req.body && req.body.source) || '';
  try {
    updater.setUpdateSource(source);
    const info = updater.getSourceInfo();
    res.json({ code: 200, msg: `已切换到${info.label}（${info.branch} 分支）`, ...info });
  } catch (err) {
    res.json({ code: 400, msg: err.message });
  }
});

// 检查更新接口
app.get('/admin/api/check-update', async (req, res) => {
  try {
    const release = await updater.getLatestRelease();
    const latestVersion = String(release.tag_name || '').replace(/^v/, '');
    const currentVersion = updater.getCurrentVersion();
    const sourceInfo = updater.getSourceInfo();

    const sourceAsset = (release.assets || []).find((a) =>
      a.name.startsWith('super-sniffer-source_')
    );
    const browserAssetReal = (release.assets || []).find((a) =>
      a.name.startsWith('super-sniffer-browser_')
    );

    res.json({
      code: 200,
      currentVersion,
      latestVersion,
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

// 执行更新接口（SSE 流式日志）
app.post('/admin/api/update', async (req, res) => {
  const type = (req.body && req.body.type) || 'all';
  if (!['browser', 'source', 'all'].includes(type)) {
    return res.status(400).json({ code: 400, msg: '无效的更新类型' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (e) { /* 连接已断开 */ }
  };
  const log = (msg, level = 'info') => send({ type: 'log', msg, level });

  try {
    if (type === 'browser') {
      await updater.updateBrowser(log);
      send({ type: 'done', ok: true, msg: '浏览器更新完成' });
    } else if (type === 'source') {
      await updater.updateSource(log);
      send({ type: 'done', ok: true, msg: '源码更新完成，即将重启服务', restart: true });
      // 重启前关闭浏览器池，避免孤儿进程
      setTimeout(async () => {
        for (const b of browserPool) await b.close().catch(() => {});
        updater.restartServer(log);
      }, 800);
    } else {
      // 一键升级：先浏览器，再源码
      await updater.updateBrowser(log);
      await updater.updateSource(log);
      send({ type: 'done', ok: true, msg: '一键升级完成，即将重启服务', restart: true });
      setTimeout(async () => {
        for (const b of browserPool) await b.close().catch(() => {});
        updater.restartServer(log);
      }, 800);
    }
  } catch (err) {
    send({ type: 'log', msg: '更新失败: ' + err.message, level: 'err' });
    send({ type: 'done', ok: false, msg: '更新失败: ' + err.message });
  } finally {
    setTimeout(() => {
      try { res.end(); } catch (e) { /* 忽略 */ }
    }, 300);
  }
});

// ============================================================
// 9. 启动：先初始化浏览器池，再监听端口
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
  server.on('listening', () => {
    console.log('');
    console.log('=============================================');
    console.log(`  超级嗅探 v${updater.getCurrentVersion()} 已启动`);
    console.log('=============================================');
    console.log(`  解析接口   : http://${MX_HOST === '0.0.0.0' ? 'localhost' : MX_HOST}:${MX_PORT}/node.js?url=`);
    console.log(`  管理后台   : http://${MX_HOST === '0.0.0.0' ? 'localhost' : MX_HOST}:${MX_PORT}/admin`);
    console.log(`  后台认证   : ${ADMIN_AUTH_ENABLED ? '已开启 (Basic Auth) - 请妥善保管账号密码' : '未开启 (生产环境请设置 MX_ADMIN_USER / MX_ADMIN_PASS)'}`);
    console.log(`  Chrome 路径: ${MX_CHROME_PATH}`);
    console.log(`  浏览器池   : ${browserPool.length} 实例 × 每实例 ${MX_PAGE_POOL_SIZE} 页面池`);
    console.log(`  缓存       : ${MX_CACHE_ENABLE ? `启用，TTL ${MX_CACHE_TTL}s，上限 ${MX_CACHE_MAX} 条` : '未启用'}`);
    console.log(`  并发上限   : ${MX_MAX_CONCURRENT} 同时解析`);
    console.log(`  找到即返回 : ${MX_EARLY_RETURN ? '已启用 (找到 m3u8 立即返回)' : '未启用'}`);
    console.log('---------------------------------------------');
    console.log(`  万能嗅探   : ${MX_UNIVERSAL_ENABLE ? `启用，${MX_UNIVERSAL_PROVIDERS.length} 个第三方接口，并发 ${MX_UNIVERSAL_CONCURRENCY} 路，超时 ${MX_UNIVERSAL_TIMEOUT}ms` : '未启用'}`);
    if (MX_UNIVERSAL_ENABLE) {
      console.log(`  └ 测试页    : http://${MX_HOST === '0.0.0.0' ? 'localhost' : MX_HOST}:${MX_PORT}/admin/sniff`);
      console.log(`  └ 对外接口  : http://${MX_HOST === '0.0.0.0' ? 'localhost' : MX_HOST}:${MX_PORT}/sniff?url=`);
      console.log(`  └ 缓存      : TTL ${MX_UNIVERSAL_TTL}s，上限 ${MX_UNIVERSAL_CACHE_MAX} 条，最多返回 ${MX_UNIVERSAL_MAX_RESULTS} 条去重地址`);
      if (MX_UNIVERSAL_EARLY_HITS > 0) console.log(`  └ 提前返回  : 命中 ${MX_UNIVERSAL_EARLY_HITS} 条即返回`);
      if (MX_UNIVERSAL_PROXY)         console.log(`  └ 代理      : ${MX_UNIVERSAL_PROXY}`);
    }
    console.log('=============================================');
  });
}

// 入口：初始化浏览器池 -> 启动监听
(async function main() {
  console.log('[超级嗅探] 正在初始化浏览器池，请稍候...');
  try {
    await initBrowserPool();
  } catch (e) {
    console.error('[超级嗅探] 浏览器池初始化失败: ' + e.message);
    console.error('[超级嗅探] 请检查 Chrome 是否可用，或通过 MX_CHROME_PATH 指定正确路径');
    // 注意：不退出，部分平台 puppeteer 可自带浏览器下载
  }
  listenWithRetry(MX_PORT, 20);
})().catch((e) => {
  console.error('[超级嗅探] 启动异常: ' + e.message);
  process.exit(1);
});

// 优雅退出：SIGINT/SIGTERM 时关闭浏览器池
let closing = false;
const shutdown = (sig) => {
  if (closing) return;
  closing = true;
  console.log(`[超级嗅探] 收到 ${sig}，正在优雅退出...`);
  (async () => {
    for (const b of browserPool) await b.close().catch(() => {});
    process.exit(0);
  })();
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
