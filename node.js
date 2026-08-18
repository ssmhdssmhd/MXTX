/**
 * 超级嗅探 - Node.js 视频解析服务 v2.1
 *
 * 版本：v2.1
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
 * 性能优化：
 *   - LRU 缓存：解析结果（TTL 1800s/500条）+ 万能嗅探结果（TTL 3600s/200条）
 *   - 浏览器池：BrowserWrapper 类管理多浏览器实例，避免每次启动/关闭
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
 */

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const updater = require('./update');

// ============================================================
// 3. 环境变量辅助函数 + 所有 MX_ 配置变量
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

// 服务配置
const MX_PORT = envInt('MX_PORT', envInt('PORT', 1314));
const MX_HOST = envStr('MX_HOST', '0.0.0.0');

// 后台配置
const MX_ADMIN_USER = envStr('MX_ADMIN_USER', 'admin');
const MX_ADMIN_PASS = envStr('MX_ADMIN_PASS', '');
const MX_ADMIN_AUTH = envBool('MX_ADMIN_AUTH', !!MX_ADMIN_PASS);

// 浏览器配置
const MX_CHROME_PATH = envStr('MX_CHROME_PATH', envStr('CHROME_PATH',
  path.join(__dirname, 'chrome-linux64', 'chrome')));
const MX_BROWSER_POOL_SIZE = envInt('MX_BROWSER_POOL_SIZE', 3);
const MX_BROWSER_ARGS = envStr('MX_BROWSER_ARGS', '').split(',').filter(Boolean);

// 嗅探配置
const MX_PARSE_TIMEOUT = envInt('MX_PARSE_TIMEOUT', envInt('PARSE_TIMEOUT', 30000));
const MX_EXTRA_WAIT = envInt('MX_EXTRA_WAIT', envInt('EXTRA_WAIT', 3000));
const MX_USER_AGENT = envStr('MX_USER_AGENT',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

// 缓存配置
const MX_CACHE_MAX = envInt('MX_CACHE_MAX', 500);
const MX_CACHE_TTL = envInt('MX_CACHE_TTL', 1800);

// 并发配置
const MX_PARSE_CONCURRENCY = envInt('MX_PARSE_CONCURRENCY', 5);
const MX_UNIVERSAL_CONCURRENCY = envInt('MX_UNIVERSAL_CONCURRENCY', 6);
const MX_SNIFF_ONE_TIMEOUT = envInt('MX_SNIFF_ONE_TIMEOUT', 15000);
const MX_UNIVERSAL_EARLY_HITS = envInt('MX_UNIVERSAL_EARLY_HITS', 3);

// 更新配置
const MX_AUTO_UPDATE = envBool('MX_AUTO_UPDATE', false);

// 万能嗅探配置
const MX_UNIVERSAL_CACHE_MAX = envInt('MX_UNIVERSAL_CACHE_MAX', 200);
const MX_UNIVERSAL_CACHE_TTL = envInt('MX_UNIVERSAL_CACHE_TTL', 3600);
const MX_UNIVERSAL_DETAILED = envBool('MX_UNIVERSAL_DETAILED', false);

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
const VIDEO_EXT_REGEX = /\.(m3u8|mp4|flv|mkv|avi|mov|wmv|webm|ts)(\?|$)/i;

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol);
  } catch (e) {
    return false;
  }
}

function extractFromText(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  const regex = new RegExp(M3U8_REGEX.source, 'g');
  let match;
  while ((match = regex.exec(text)) !== null) {
    found.add(match[0].replace(/\\\//g, '/'));
  }
  const mp4Regex = new RegExp(MP4_REGEX.source, 'g');
  while ((match = mp4Regex.exec(text)) !== null) {
    found.add(match[0].replace(/\\\//g, '/'));
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
  return undefined;
}

// ============================================================
// 5. LRUCache 类 + resultCache
// ============================================================
class LRUCache {
  constructor(maxSize = 500, ttlMs = 1800000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  _isExpired(entry) {
    return Date.now() - entry.createdAt > this.ttlMs;
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
  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, { value, createdAt: Date.now() });
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
}

const resultCache = new LRUCache(MX_CACHE_MAX, MX_CACHE_TTL * 1000);

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

// 4.5 万能嗅探的 LRU 与 Semaphore
const universalCache = new LRUCache(MX_UNIVERSAL_CACHE_MAX, MX_UNIVERSAL_CACHE_TTL * 1000);
const universalSem = new Semaphore(MX_UNIVERSAL_CONCURRENCY);

// 4.6 万能嗅探引擎
const VIDEO_URL_REGEX = /https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv|mkv|avi|mov|wmv|webm|ts)[^\s"'<>\\]*/ig;

function extractVideoUrls(text) {
  const found = new Set();
  if (!text || typeof text !== 'string') return [];
  const regex = new RegExp(VIDEO_URL_REGEX.source, 'ig');
  let match;
  while ((match = regex.exec(text)) !== null) {
    let url = match[0].replace(/\\\//g, '/');
    url = url.replace(/[,.，。、；;]+$/g, '');
    if (isValidUrl(url)) {
      found.add(url);
    }
  }
  return [...found];
}

function walkJsonForVideoUrls(obj, out) {
  if (!out) out = new Set();
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string') {
    if (VIDEO_EXT_REGEX.test(obj) && isValidUrl(obj)) {
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
        if (VIDEO_EXT_REGEX.test(v) && isValidUrl(v)) {
          out.add(v);
        }
        extractVideoUrls(v).forEach((u) => out.add(u));
      }
      walkJsonForVideoUrls(v, out);
    }
  }
  return out;
}

function makeProxyDispatcher() {
  const http = require('http');
  const https = require('https');
  return (parsed) => (parsed.protocol === 'https:' ? https : http);
}

async function sniffOne(provider, targetUrl, options) {
  const timeout = (options && options.timeout) || MX_SNIFF_ONE_TIMEOUT;
  const fullUrl = provider + encodeURIComponent(targetUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const https = require('https');
  const http = require('http');

  try {
    const parsed = new URL(fullUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = lib.get(fullUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': MX_USER_AGENT,
          'Accept': '*/*',
          'Referer': targetUrl
        },
        timeout: timeout
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          if (VIDEO_EXT_REGEX.test(loc)) {
            const abs = new URL(loc, fullUrl).href;
            clearTimeout(timer);
            return resolve([abs]);
          }
        }
        if (!isTextResponse(res.headers)) {
          res.resume();
          clearTimeout(timer);
          return resolve([]);
        }
        let raw = '';
        let bytes = 0;
        const MAX_BYTES = 2 * 1024 * 1024;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= MAX_BYTES) {
            raw += chunk.toString('utf8', 0, Math.min(chunk.length, MAX_BYTES - (bytes - chunk.length)));
          } else {
            res.destroy();
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          const urls = new Set();

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

          resolve([...urls]);
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.setTimeout(timeout, () => {
        req.destroy(new Error('timeout'));
      });
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || err.message === 'timeout') {
      return [];
    }
    return [];
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
  const onProgress = opts.onProgress || (() => {});
  const earlyHits = opts.earlyHits != null ? opts.earlyHits : MX_UNIVERSAL_EARLY_HITS;
  const providers = opts.providers || PROVIDERS;

  const allUrls = new Set();
  const providerResults = [];
  let doneCount = 0;
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
    onProgress({
      index: i,
      provider,
      status: 'pending',
      count: 0,
      done: doneCount,
      total,
      hits: hitCount
    });
    try {
      const urls = await sniffOne(provider, targetUrl, opts);
      const validUrls = urls.filter(isValidUrl);
      validUrls.forEach((u) => allUrls.add(u));
      if (validUrls.length > 0) hitCount++;
      providerResults[i] = { provider, status: validUrls.length > 0 ? 'ok' : 'fail', urls: validUrls };
      onProgress({
        index: i,
        provider,
        status: validUrls.length > 0 ? 'ok' : 'fail',
        count: validUrls.length,
        done: ++doneCount,
        total,
        hits: hitCount
      });
      if (earlyHits > 0 && hitCount >= earlyHits) {
        aborted = true;
      }
    } catch (e) {
      providerResults[i] = { provider, status: 'fail', urls: [], error: e.message };
      onProgress({
        index: i,
        provider,
        status: 'fail',
        count: 0,
        done: ++doneCount,
        total,
        hits: hitCount,
        error: e.message
      });
    }
  });

  await runWithLimit(tasks, MX_UNIVERSAL_CONCURRENCY);

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
// 7. BrowserWrapper 类 + 浏览器池
// ============================================================
class BrowserWrapper {
  constructor(executablePath) {
    this.executablePath = executablePath;
    this.browser = null;
    this.lastUsed = 0;
    this.ready = false;
  }
  async launch() {
    const defaultArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled'
    ];
    const args = [...defaultArgs, ...MX_BROWSER_ARGS];
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args
    });
    this.browser.on('disconnected', () => {
      this.ready = false;
    });
    this.ready = true;
  }
  async newPage() {
    if (!this.browser || !this.ready) {
      await this.launch();
    }
    this.lastUsed = Date.now();
    return await this.browser.newPage();
  }
  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) { }
      this.browser = null;
      this.ready = false;
    }
  }
  isAlive() {
    return this.ready && this.browser && this.browser.process() != null;
  }
}

let browserPool = [];
let browserPoolIndex = 0;

async function initBrowserPool() {
  const executablePath = checkChrome();
  const size = MX_BROWSER_POOL_SIZE;
  browserPool = [];
  for (let i = 0; i < size; i++) {
    const bw = new BrowserWrapper(executablePath);
    try {
      await bw.launch();
      browserPool.push(bw);
    } catch (e) {
      console.log(`[超级嗅探] 浏览器池实例 ${i + 1} 启动失败: ${e.message}`);
    }
  }
  if (browserPool.length === 0) {
    console.log('[超级嗅探] 警告：浏览器池未启动成功，将使用按需启动模式');
  } else {
    console.log(`[超级嗅探] 浏览器池已启动: ${browserPool.length}/${size} 个实例`);
  }
}

async function nextBrowser() {
  if (browserPool.length === 0) {
    const executablePath = checkChrome();
    const bw = new BrowserWrapper(executablePath);
    await bw.launch();
    return bw;
  }
  let attempts = 0;
  while (attempts < browserPool.length) {
    const idx = browserPoolIndex % browserPool.length;
    browserPoolIndex++;
    const bw = browserPool[idx];
    if (bw.isAlive()) {
      return bw;
    }
    attempts++;
  }
  const executablePath = checkChrome();
  const bw = new BrowserWrapper(executablePath);
  await bw.launch();
  return bw;
}

// ============================================================
// 8. 核心 sniffVideoUrl 函数
// ============================================================
async function sniffVideoUrl(videoUrl) {
  if (/\.m3u8|\.mp4/i.test(videoUrl)) {
    return { code: 200, url: videoUrl };
  }
  let browserWrapper = null;
  let page = null;
  try {
    browserWrapper = await nextBrowser();
    page = await browserWrapper.newPage();

    await page.setUserAgent(MX_USER_AGENT);
    await page.setViewport({ width: 1280, height: 720 });

    const videoUrls = new Set();

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (VIDEO_EXT_REGEX.test(url)) {
        videoUrls.add(url);
      }
      request.continue().catch(() => {});
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (VIDEO_EXT_REGEX.test(url)) {
        videoUrls.add(url);
      }
      if (isTextResponse(response.headers())) {
        try {
          const text = await response.text();
          extractFromText(text).forEach((u) => videoUrls.add(u));
          extractVideoUrls(text).forEach((u) => videoUrls.add(u));
        } catch (e) { }
      }
    });

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
      extractFromText(content).forEach((u) => videoUrls.add(u));
      extractVideoUrls(content).forEach((u) => videoUrls.add(u));
    } catch (e) { }

    for (const frame of page.frames()) {
      try {
        const frameContent = await frame.content();
        extractFromText(frameContent).forEach((u) => videoUrls.add(u));
        extractVideoUrls(frameContent).forEach((u) => videoUrls.add(u));
      } catch (e) { }
    }

    if (videoUrls.size > 0) {
      const sorted = [...videoUrls].sort((a, b) => qualityScore(b) - qualityScore(a));
      return { code: 200, url: sorted[0], allUrls: sorted };
    }

    return { code: 404, msg: '未找到播放链接' };
  } catch (err) {
    return { code: 500, msg: '解析失败: ' + err.message };
  } finally {
    if (page) {
      try {
        await page.close().catch(() => {});
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
// 10. /node.js 解析主接口
// ============================================================
app.get('/node.js', async (req, res) => {
  const videoUrl = (req.query.url || '').trim();

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
    const result = await parseSem.run(() => sniffVideoUrl(videoUrl));
    if (result.code === 200) {
      resultCache.set(cacheKey, result);
    }
    return res.json(result);
  } catch (err) {
    return res.json({ code: 500, msg: '解析失败: ' + err.message });
  }
});

// ============================================================
// 11. /sniff 万能嗅探对外接口
// ============================================================
app.get('/sniff', async (req, res) => {
  const videoUrl = (req.query.url || '').trim();
  const detailed = req.query.detailed != null ? (req.query.detailed === '1' || req.query.detailed === 'true') : MX_UNIVERSAL_DETAILED;

  if (!videoUrl) {
    return res.json({ code: 400, msg: '请提供需要解析的链接' });
  }
  if (!isValidUrl(videoUrl)) {
    return res.json({ code: 400, msg: '链接格式不正确' });
  }

  const cacheKey = 'universal:' + videoUrl;
  const cached = universalCache.get(cacheKey);
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
    const result = await universalSem.run(() => runUniversalSniff(videoUrl));
    universalCache.set(cacheKey, result);
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
  res.json({
    code: 200,
    msg: '超级嗅探解析服务运行中',
    port: MX_PORT,
    version: 'v' + updater.getCurrentVersion(),
    providers: PROVIDERS.length,
    cache: {
      parse: resultCache.size,
      universal: universalCache.size
    },
    universal: {
      enabled: true,
      providers: PROVIDERS.length,
      concurrency: MX_UNIVERSAL_CONCURRENCY,
      earlyHits: MX_UNIVERSAL_EARLY_HITS
    },
    browserPool: browserPool.length
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
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>超级嗅探管理后台 v2.1</title>
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
  <h1>🎬 超级嗅探管理后台 v2.1</h1>
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
async function loadStatus() {
  try {
    const r = await fetch('/admin/api/status').then(r => r.json());
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
    const r = await fetch('/admin/api/providers').then(r => r.json());
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
    const r = await fetch('/node.js?url=' + encodeURIComponent(url)).then(r => r.json());
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
<title>万能嗅探测试 v2.1</title>
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
  <h1>🔍 万能嗅探测试 v2.1</h1>
  <p>并发 ${MX_UNIVERSAL_CONCURRENCY} · 提前命中 ${MX_UNIVERSAL_EARLY_HITS} · ${PROVIDERS.length} 个 Provider</p>
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
  log('Provider 数量: ${PROVIDERS.length} · 并发: ${MX_UNIVERSAL_CONCURRENCY} · 提前命中: ${MX_UNIVERSAL_EARLY_HITS}', 'info');

  const urlParams = new URLSearchParams();
  urlParams.set('url', url);
  const endpoint = '/admin/api/sniff-stream?' + urlParams.toString();

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
    setProvStatus(i, status, urls);
    if (status === 'ok') {
      log('[#' + (i+1) + '] ✅ 命中 ' + urls.length + ' 个 URL - ' + (provider || '').slice(0, 50), 'ok');
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
    browserPool: browserPool.length,
    providers: PROVIDERS.length,
    universal: {
      enabled: true,
      providers: PROVIDERS.length,
      concurrency: MX_UNIVERSAL_CONCURRENCY,
      earlyHits: MX_UNIVERSAL_EARLY_HITS,
      cacheSize: universalCache.size
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
// 16. /admin/api/sniff-stream SSE
// ============================================================
app.get('/admin/api/sniff-stream', adminAuth, async (req, res) => {
  const videoUrl = (req.query.url || '').trim();
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

app.post('/admin/api/update', adminAuth, async (req, res) => {
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
    } catch (e) { }
  };
  const log = (msg, level = 'info') => send({ type: 'log', msg, level });

  try {
    if (type === 'browser') {
      await updater.updateBrowser(log);
      send({ type: 'done', ok: true, msg: '浏览器更新完成' });
    } else if (type === 'source') {
      await updater.updateSource(log);
      send({ type: 'done', ok: true, msg: '源码更新完成，即将重启服务', restart: true });
      setTimeout(() => updater.restartServer(log), 800);
    } else {
      await updater.updateBrowser(log);
      await updater.updateSource(log);
      send({ type: 'done', ok: true, msg: '一键升级完成，即将重启服务', restart: true });
      setTimeout(() => updater.restartServer(log), 800);
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
    console.log('║           超级嗅探视频解析服务 v2.1 启动成功                  ║');
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
    console.log(`║  提前命中:     ${String(MX_UNIVERSAL_EARLY_HITS).padEnd(36)}║`);
    console.log(`║  结果缓存:     ${String(MX_UNIVERSAL_CACHE_MAX + '条/' + MX_UNIVERSAL_CACHE_TTL + 's').padEnd(36)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Chrome 路径: ${String(checkChrome() || '使用系统默认').padEnd(36)}║`);
    console.log(`║  浏览器池:     ${String(browserPool.length + ' 个实例').padEnd(36)}║`);
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
