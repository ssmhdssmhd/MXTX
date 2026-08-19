// 诊断脚本：加载 jiexi 页面，输出所有网络请求 / 响应 / 控制台
const puppeteer = require('puppeteer');
const CHROME = '/workspace/chrome-linux64/chrome';
const PROXY = process.env.HTTPS_PROXY || '';
const TARGET = process.argv[2] || 'https://jx.xmflv.com/?url=https%3A%2F%2Fv.youku.com%2Fv_show%2Fid_XNjM3Mzc1NTYw.html';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled', '--disable-extensions',
      ...(PROXY ? [`--proxy-server=${PROXY}`] : [])
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', (msg) => console.log('[console]', msg.type(), msg.text().slice(0, 300)));
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
  page.on('request', (req) => {
    const u = req.url();
    if (/\bm3u8\b|mpegurl|\.mp4|\.flv|play|video|api|json/i.test(u)) {
      console.log('[req]', req.method(), u.slice(0, 220));
    }
  });
  page.on('response', async (resp) => {
    const u = resp.url();
    const ct = (resp.headers()['content-type'] || '');
    if (/\/Api/i.test(u)) {
      let body = '';
      try { body = (await resp.text()).slice(0, 600); } catch (e) { body = '<read err ' + e.message + '>'; }
      console.log('[ApiResp]', resp.status(), u.slice(0, 120), 'CT=' + ct.slice(0, 40));
      console.log('[ApiBody]', body.replace(/\n/g, ' '));
    }
    if (/\bm3u8\b|mpegurl|\.mp4|\.flv/i.test(u) || /mpegurl|video\/mp4/i.test(ct)) {
      console.log('[resp]', resp.status(), u.slice(0, 220), 'CT=' + ct.slice(0, 60));
    }
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (/cache|hls|Api|m3u8|video/i.test(u)) console.log('[reqfail]', u.slice(0, 180), '->', req.failure() && req.failure().errorText);
  });
  page.on('requestfinished', (req) => {
    const u = req.url();
    if (/cache|hls|Api|m3u8|video/i.test(u)) console.log('[reqdone]', req.method(), u.slice(0, 180));
  });

  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { console.log('[goto err]', e.message.slice(0, 200)); }

  // 等待更长时间观察
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const hits = [];
    for (const f of page.frames()) {
      try { const c = await f.content(); if (/\bm3u8\b|mpegurl/i.test(c)) hits.push(c.match(/\S*m3u8\S*/i).slice(0, 2)); } catch (e) {}
    }
    if (hits.length) console.log('[t+' + (i + 1) + 's] frame contains m3u8 text:', hits);
  }
  console.log('[final] frames:', page.frames().map((f) => f.url()).slice(0, 10));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
