// 候选接口 Puppeteer 渲染探针：渲染播放器页，抓取 m3u8/mp4/flv 响应
// 用法: node .probe_render_cand.js [视频URL]
const puppeteer = require('puppeteer');

const TARGET = process.argv[2] || 'https://www.bilibili.com/video/BV1kS8H6VERt';
const CHROME = '/root/.cache/puppeteer/chrome/linux-151.0.7922.71/chrome-linux64/chrome';

const CANDIDATES = [
  ['爱豆', 'https://jx.aidouer.net/?url='],
  ['nnxv', 'https://jx.nnxv.cn/tv.php?url='],
  ['qianqi', 'https://api.qianqi.net/vip/?url='],
  ['bd.jx', 'https://bd.jx.cn/?url='],
  ['ckmov.vip', 'https://www.ckmov.vip/api.php?url='],
  ['ckmov.com', 'https://www.ckmov.com/?url='],
  ['gai4', 'https://www.gai4.com/?url='],
  ['fongmi', 'https://json.fongmi.cc/web?url='],
  ['hls.one', 'https://jx.hls.one/?url='],
  ['vipjiexi', 'http://www.vipjiexi.com/yun.php?url='],
  ['jidiaose', 'http://player.jidiaose.com/supapi/iframe.php?v='],
  ['pucms', 'http://api.pucms.com/index.php?url='],
  ['shankubf', 'https://www.shankubf.com/m3u8/?url='],
  ['dphw8', 'https://player.dphw8.com/player?url='],
  ['nepian', 'http://api.nepian.com/ckparse/?url='],
  ['ckmov.ccyjjd', 'https://ckmov.ccyjjd.com/ckmov/?url='],
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'],
  });
  console.log('目标:', TARGET);
  console.log('===============================================');
  let okCount = 0;
  for (const [name, base] of CANDIDATES) {
    const url = base + encodeURIComponent(TARGET);
    const page = await browser.newPage();
    const hits = new Set();
    page.on('response', (res) => {
      const u = res.url();
      if (/\.(m3u8|mp4|flv|ts)(\?|$)/i.test(u)) hits.add(u.slice(0, 200));
    });
    page.on('requestfailed', () => {});
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
      await page.setExtraHTTPHeaders({ 'Referer': 'https://www.bilibili.com/' });
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 6000));
      const ms = Date.now() - t0;
      // 额外抓取 iframe 链后的响应
      try {
        const frames = page.frames();
        for (const f of frames.slice(0, 5)) {
          try {
            await f.waitForTimeout(3000);
          } catch (e) {}
        }
      } catch (e) {}
      // 从页面内容再提取一次
      const html = await page.content().catch(() => '');
      const m = html.match(/https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv)[^\s"'<>\\]*/gi) || [];
      m.forEach((u) => { if (!/\.(js|css|png|jpg)/i.test(u)) hits.add(u.slice(0, 200)); });
      const hit = hits.size > 0;
      if (hit) okCount++;
      console.log(`[${hit ? 'HIT' : '---'}] ${name.padEnd(12)} ${ms}ms hits=${hits.size}`);
      hits.forEach((u) => console.log('        -> ' + u));
    } catch (e) {
      console.log(`[---] ${name.padEnd(12)} 渲染失败: ${String(e.message).slice(0, 80)}`);
    }
    await page.close().catch(() => {});
  }
  await browser.close();
  console.log('===============================================');
  console.log(`总计: ${CANDIDATES.length} 条, 渲染命中: ${okCount} 条`);
})().catch((e) => { console.error(e); process.exit(1); });
