/**
 * 超级嗅探 - Node.js 视频解析服务
 *
 * 功能：
 *   使用 Puppeteer 无头浏览器打开目标视频页面，
 *   通过「网络请求拦截 + 页面内容扫描 + iframe 扫描」三种方式，
 *   提取页面中的 .m3u8 播放地址并返回。
 *
 * 启动：
 *   node node.js
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

const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const updater = require('./update');

const app = express();
const PORT = parseInt(process.env.PORT || '1314', 10);

app.use(express.json());

// Chrome 可执行文件路径（优先使用项目内打包的 Chrome，可被环境变量覆盖）
const CHROME_PATH =
  process.env.CHROME_PATH || path.join(__dirname, 'chrome-linux64', 'chrome');

// 单次解析超时（毫秒）
const PARSE_TIMEOUT = parseInt(process.env.PARSE_TIMEOUT || '30000', 10);

// 页面加载完成后额外等待时间（毫秒），用于等待动态加载的视频地址
const EXTRA_WAIT = parseInt(process.env.EXTRA_WAIT || '3000', 10);

// m3u8 地址正则（支持带查询参数）
const M3U8_REGEX = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;

// 校验 URL 是否合法
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol);
  } catch (e) {
    return false;
  }
}

// 从文本内容中提取所有 m3u8 地址（去重）
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

// 检查响应是否可能是文本类内容（避免读取二进制导致卡死）
function isTextResponse(headers) {
  const ct = (headers['content-type'] || '').toLowerCase();
  return (
    ct.includes('text/') ||
    ct.includes('json') ||
    ct.includes('mpegurl') ||
    ct.includes('vnd.apple') ||
    ct === '' ||
    ct.includes('x-mpegurl')
  );
}

// 检查 Chrome 是否存在
function checkChrome() {
  if (fs.existsSync(CHROME_PATH)) {
    return CHROME_PATH;
  }
  // 回退：让 puppeteer 使用默认下载的浏览器
  return undefined;
}

app.get('/node.js', async (req, res) => {
  const videoUrl = (req.query.url || '').trim();

  if (!videoUrl) {
    return res.json({ code: 400, msg: '请提供需要解析的链接' });
  }
  if (!isValidUrl(videoUrl)) {
    return res.json({ code: 400, msg: '链接格式不正确' });
  }

  // 如果传入的本身就是 m3u8 地址，直接返回
  if (/\.m3u8/i.test(videoUrl)) {
    return res.json({ code: 200, url: videoUrl });
  }

  let browser = null;
  try {
    const executablePath = checkChrome();

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 720 });

    const m3u8Urls = new Set();

    // 方式一：拦截网络请求，捕获所有 m3u8 请求
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        m3u8Urls.add(url);
      }
      request.continue().catch(() => {});
    });

    // 方式二：监听响应，从文本类响应体中提取 m3u8 地址
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.m3u8')) {
        m3u8Urls.add(url);
      }
      if (isTextResponse(response.headers())) {
        try {
          const text = await response.text();
          extractFromText(text).forEach((u) => m3u8Urls.add(u));
        } catch (e) {
          /* 忽略读取失败 */
        }
      }
    });

    // 打开目标页面，等待网络空闲
    // 注意：直接访问 m3u8 等非 HTML 资源时导航可能被中止（ERR_ABORTED），
    // 此时仍可依赖请求拦截与内容扫描提取地址，因此导航失败不视为致命错误。
    try {
      await page.goto(videoUrl, {
        waitUntil: 'networkidle2',
        timeout: PARSE_TIMEOUT
      });
    } catch (e) {
      console.log('[超级嗅探] 页面导航失败，尝试从已捕获的请求中提取: ' + e.message);
    }

    // 额外等待，让动态加载的视频地址出现
    await new Promise((r) => setTimeout(r, EXTRA_WAIT));

    // 方式三：扫描最终页面内容
    const content = await page.content();
    extractFromText(content).forEach((u) => m3u8Urls.add(u));

    // 方式四：扫描页面内所有 iframe 内容
    for (const frame of page.frames()) {
      try {
        const frameContent = await frame.content();
        extractFromText(frameContent).forEach((u) => m3u8Urls.add(u));
      } catch (e) {
        /* 忽略单个 frame 读取失败 */
      }
    }

    if (m3u8Urls.size > 0) {
      const url = [...m3u8Urls][0];
      return res.json({ code: 200, url });
    }

    return res.json({ code: 404, msg: '未找到播放链接' });
  } catch (err) {
    return res.json({ code: 500, msg: '解析失败: ' + err.message });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

// 健康检查
app.get('/', (req, res) => {
  res.json({ code: 200, msg: '超级嗅探解析服务运行中', port: PORT });
});

// ============================================================
// 后台管理 & 在线更新
// ============================================================

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
  res.json({
    code: 200,
    service: '运行中',
    port: PORT,
    version,
    chromeVersion,
    chromeInstalled: chromeVersion !== '未安装' && chromeVersion !== '不可用',
    updateSource: `${updater.GITHUB_OWNER}/${updater.GITHUB_REPO}`
  });
});

// 检查更新接口
app.get('/admin/api/check-update', async (req, res) => {
  try {
    const release = await updater.getLatestRelease();
    const latestVersion = String(release.tag_name || '').replace(/^v/, '');
    const currentVersion = updater.getCurrentVersion();

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
    } catch (e) {
      /* 连接已断开 */
    }
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
      // 一键升级：先浏览器，再源码
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
      } catch (e) {
        /* 忽略 */
      }
    }, 300);
  }
});

// 带端口重试的启动逻辑：
// 在线更新重启服务时，旧进程可能尚未完全释放端口，
// 这里自动重试，确保新进程最终能成功监听。
function listenWithRetry(port, retries) {
  const server = app.listen(port);
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
    console.log(`[超级嗅探] 解析服务已启动: http://localhost:${PORT}/node.js?url=`);
    console.log(`[超级嗅探] 管理后台: http://localhost:${PORT}/admin`);
    console.log(`[超级嗅探] Chrome 路径: ${CHROME_PATH}`);
    console.log(`[超级嗅探] 当前版本: v${updater.getCurrentVersion()}`);
  });
}

listenWithRetry(PORT, 20);
