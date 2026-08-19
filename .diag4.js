// 复刻服务端拦截逻辑，确认是否导致 im1907.top goto 超时
const puppeteer = require('puppeteer');
const CHROME = '/workspace/chrome-linux64/chrome';
const PROXY = process.env.HTTPS_PROXY || '';
const GLOBAL_BLOCK_RE = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|css|mp3|wav|flac|aac)(\?|$)/i;
const GLOBAL_BLOCK_HOST_RE = /(google-analytics|googletagmanager|doubleclick|adservice|scorecardresearch|facebook|disqus)\./i;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
      '--disable-extensions', ...(PROXY ? [`--proxy-server=${PROXY}`] : [])]
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  const aborted = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!/^https?:/i.test(url)) { aborted.push(url); try { req.abort(); } catch (e) {} return; }
    if (GLOBAL_BLOCK_RE.test(url) || GLOBAL_BLOCK_HOST_RE.test(url)) { aborted.push(url); try { req.abort(); } catch (e) {} return; }
    try { req.continue(); } catch (e) {}
  });
  const hits = new Set();
  page.on('response', async (resp) => {
    try {
      const u = resp.url(); const ct = (resp.headers()['content-type'] || '');
      if (/\.m3u8(\?|$)/i.test(u) || /mpegurl/i.test(ct)) hits.add(u);
    } catch (e) {}
  });
  const url = 'https://im1907.top/?jx=' + encodeURIComponent('https://v.youku.com/v_show/id_XNjM3Mzc1NTYw.html');
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('goto OK in', Date.now() - t0, 'ms');
  } catch (e) {
    console.log('goto FAILED after', Date.now() - t0, 'ms:', e.message.slice(0, 60));
  }
  // 再多等几秒看是否还能捕获
  const waitStart = Date.now();
  while (Date.now() - waitStart < 8000 && hits.size === 0) await new Promise((r) => setTimeout(r, 500));
  console.log('hits:', [...hits].slice(0, 5));
  console.log('aborted sample:', aborted.slice(0, 8));
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
