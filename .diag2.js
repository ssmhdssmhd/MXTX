// 批量诊断：逐个加载 Provider，统计是否捕获到 m3u8 / API 响应 / 视频 URL
const puppeteer = require('puppeteer');
const CHROME = '/workspace/chrome-linux64/chrome';
const PROXY = process.env.HTTPS_PROXY || '';
const VIDEO = 'https%3A%2F%2Fv.youku.com%2Fv_show%2Fid_XNjM3Mzc1NTYw.html';

const PROVIDERS = [
  'https://www.playm3u8.cn/jiexi.php?url=',
  'https://json.ovvo.pro/jx.php?url=',
  'https://api.qianqi.net/vip/?url=',
  'https://www.yemu.xyz/?url=',
  'https://jx.yangtu.top/?url=',
  'https://www.8090g.cn/?url=',
  'https://im1907.top/?jx=',
  'https://www.ckplayer.vip/jiexi/?url='
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
      '--disable-extensions', ...(PROXY ? [`--proxy-server=${PROXY}`] : [])]
  });

  for (const p of PROVIDERS) {
    const page = await browser.newPage();
    const hits = new Set();
    const apiHits = new Set();
    page.on('response', async (resp) => {
      try {
        const u = resp.url(); const ct = (resp.headers()['content-type'] || '');
        if (/\.m3u8(\?|$)/i.test(u) || /mpegurl/i.test(ct)) hits.add(u);
        if (/\/Api|\.php|json/i.test(u) && /json|javascript|text\//i.test(ct)) {
          try { const b = await resp.text(); (b.match(/https?:\/\/[^\s"'<>]+?\.(m3u8|mp4|flv)[^\s"'<>]*/ig) || []).forEach((x) => apiHits.add(x)); } catch (e) {}
        }
      } catch (e) {}
    });
    try {
      await page.goto(p + VIDEO, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 8000));
    let txt = 0;
    for (const f of page.frames()) {
      try { const c = await f.content(); txt += ((c.match(/\bm3u8\b/gi) || []).length); } catch (e) {}
    }
    console.log(JSON.stringify({ provider: p, m3u8Resp: [...hits].slice(0, 3), apiVideoUrls: [...apiHits].slice(0, 3), m3u8TextFrames: txt }));
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
