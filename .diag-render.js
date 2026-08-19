// 独立诊断：用 Puppeteer 真实渲染单个 Provider，抓所有网络请求，定位 m3u8 为何捕获不到
const puppeteer = require('puppeteer');

const CHROME = process.env.CHROME_PATH || '/root/.cache/puppeteer/chrome/linux-151.0.7922.71/chrome-linux64/chrome';
const PROVIDER = process.argv[2] || 'https://jx.xmflv.cc/?url=';
const TARGET = process.argv[3] || 'https://v.qq.com/x/cover/mzc00200q98x75k.html';
const fullUrl = PROVIDER + encodeURIComponent(TARGET);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--disable-extensions']
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 720 });

  const m3u8Hits = new Set();
  const allResp = [];
  page.on('response', async (res) => {
    const u = res.url();
    try {
      const ct = res.headers()['content-type'] || '';
      if (/m3u8|mpegurl|mp4|\.ts\b|video/i.test(u) || /m3u8|mpegurl|video\/mp4/i.test(ct)) {
        if (u.length < 300) allResp.push(`  [CAPTURE] ${res.status()} ${u.slice(0, 160)}`);
        if (u.includes('.m3u8')) m3u8Hits.add(u);
      }
    } catch (e) {}
  });
  page.on('requestfailed', (req) => {
    const u = req.url();
    if (/m3u8|mp4/i.test(u) && u.length < 200) allResp.push(`  [FAILED-REQ] ${req.failure() && req.failure().errorText} ${u.slice(0, 120)}`);
  });
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.length < 200 && /m3u8|mp4|error|fail/i.test(t)) allResp.push(`  [CONSOLE] ${t.slice(0, 120)}`);
  });

  console.log(`=== 渲染: ${fullUrl} ===`);
  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) { console.log(`page.goto: ${e.message.split('\n')[0]}`); }
  console.log(`最终URL: ${page.url()}`);

  // 轮询等待 m3u8，最多 20s
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (m3u8Hits.size > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 3000));

  console.log(`等待 ${Date.now() - t0}ms 后 m3u8 捕获数: ${m3u8Hits.size}`);
  for (const u of [...m3u8Hits].slice(0, 3)) console.log(`  M3U8 → ${u.slice(0, 160)}`);
  console.log('--- 关键网络事件 ---');
  console.log(allResp.slice(0, 30).join('\n') || '  (无)');

  const content = await page.content();
  console.log(`--- 页面内容 ${content.length}B ---`);
  console.log(content.slice(0, 500).replace(/\s+/g, ' '));
  console.log('--- iframe ---');
  const frames = page.frames();
  for (const f of frames) console.log(`  frame: ${f.url().slice(0, 120)}`);
  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
