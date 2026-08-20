// 直接验证：用 Puppeteer 渲染虾米播放器，能否抓到 m3u8 网络请求 / 页面内直链
const puppeteer = require('puppeteer');
const { EnvHttpProxyAgent } = require('undici');
(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/root/.cache/puppeteer/chrome/linux-151.0.7922.71/chrome-linux64/chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    const hits = new Set();
    page.on('response', async (res) => {
      const u = res.url();
      if (/\.m3u8|\.mp4|\.flv/.test(u)) hits.add(u.slice(0, 160));
    });
    page.on('request', (req) => {
      const u = req.url();
      if (/\.m3u8|\.mp4|\.flv/.test(u)) hits.add(u.slice(0, 160));
    });
    const target = 'https://www.bilibili.com/video/BV1kS8H6VERt';
    const url = 'https://jx.xmflv.com/?url=' + encodeURIComponent(target);
    console.log('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log('domcontentloaded OK');
    // 等待播放器加载 / 网络捕获
    const waitCap = 12000;
    const start = Date.now();
    while (Date.now() - start < waitCap && hits.size === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('网络捕获 m3u8/mp4:', hits.size);
    hits.forEach(h => console.log('  HIT ' + h));
    // 页面文本 & iframe 提取
    const content = await page.content();
    let m = content.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g);
    if (m) console.log('page.content m3u8:', m.slice(0, 3));
    m = content.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g);
    if (m) console.log('page.content mp4:', m.slice(0, 3));
    console.log('frames:', page.frames().length);
    for (const f of page.frames()) {
      try {
        const fc = await f.content();
        m = fc.match(/https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv)[^\s"'<>\\]*/g);
        if (m) { console.log('  frame', f.url().slice(0, 60), '->', m.slice(0, 3).map(x => x.slice(0, 100))); }
      } catch (e) { }
    }
    // 读页面上的 video src / js 数据
    const videoSrc = await page.evaluate(() => {
      const v = document.querySelector('video');
      const out = { src: v ? v.src : null, currentSrc: v ? v.currentSrc : null };
      const anchors = [];
      document.querySelectorAll('script').forEach(s => {
        const t = s.textContent || '';
        if (/m3u8|mp4|http/.test(t)) anchors.push(t.slice(0, 80));
      });
      return { out, anchors: anchors.slice(0, 3) };
    }).catch(e => ({ err: e.message }));
    console.log('evaluate:', JSON.stringify(videoSrc).slice(0, 400));
  } catch (e) {
    console.log('LAUNCH/NAV ERR', e.message.slice(0, 200));
  } finally {
    if (browser) await browser.close();
  }
})();