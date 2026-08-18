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

// ---------- 7.2 健康检查 / 状态 ----------
app.get('/', (req, res) => {
  res.json({
    code: 200,
    msg: '超级嗅探解析服务运行中',
    port: MX_PORT,
    version: updater.getCurrentVersion(),
    cache: MX_CACHE_ENABLE ? { enabled: true, size: resultCache.size, ttl: MX_CACHE_TTL } : { enabled: false },
    concurrent: { max: MX_MAX_CONCURRENT, current: parseSem.current, queue: parseSem.queue.length }
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
    browserPool: { size: browserPool.length, pagePoolSize: MX_PAGE_POOL_SIZE }
  });
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
