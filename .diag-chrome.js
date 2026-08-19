// 独立验证：puppeteer 是否能在此环境启动 Chrome 并渲染页面
const puppeteer = require('puppeteer');

async function main() {
  const chromePaths = [
    process.env.CHROME_PATH,
    '/root/.cache/puppeteer/chrome/linux-151.0.7922.71/chrome-linux64/chrome',
    '/root/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome'
  ].filter(Boolean);

  for (const ep of chromePaths) {
    try {
      const t0 = Date.now();
      const browser = await puppeteer.launch({
        executablePath: ep,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-zygote', '--single-process', '--disable-dev-shm-usage']
      });
      const page = await browser.newPage();
      await page.goto('data:text/html,<html><body><video src="https://x.com/a.m3u8"></video>HELLO</body></html>', { waitUntil: 'domcontentloaded' });
      const content = await page.content();
      console.log(`OK  ${ep}  耗时 ${Date.now() - t0}ms  contains video tag: ${content.includes('<video')}`);
      await browser.close();
      return;
    } catch (e) {
      console.log(`FAIL ${ep}  -> ${e.message.split('\n')[0]}`);
    }
  }
  console.log('ALL CHROME LAUNCH FAILED');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
