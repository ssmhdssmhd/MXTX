// 聚焦测试：用与服务端一致的拦截逻辑，验证 im1907.top 在真实渲染下能否捕获 m3u8
const puppeteer = require('puppeteer');
const CHROME = '/workspace/chrome-linux64/chrome';
const PROXY = process.env.HTTPS_PROXY || '';

const TESTS = [
  { provider: 'im1907.top', url: 'https%3A%2F%2Fv.youku.com%2Fv_show%2Fid_XNjM3Mzc1NTYw.html', base: 'https://im1907.top/?jx=' },
  { provider: 'im1907.top', url: 'https%3A%2F%2Fwww.iqiyi.com%2Fv_19rrb6ldl8.html', base: 'https://im1907.top/?jx=' },
  { provider: 'm3u8.tv', url: 'https%3A%2F%2Fv.youku.com%2Fv_show%2Fid_XNjM3Mzc1NTYw.html', base: 'https://jx.m3u8.tv/jiexi/?url=' }
];

// 与服务端一致的 isVideoUrl
function isVideoUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (/(^|\.)(doubleclick|googlesyndication|adservice|adsystem|domob|admob|mobads|bdstatic|bytedance|byteimg|ixigua|toutiao|pstatp|bing|msn|sogou|360|sohu|ad|ads|adv|adt|adn|adserver|adservice|adtags|adtech|adzerk|amazon-adsystem|amazonaws|googleadservices|quantserve|scorecardresearch|taboola|outbrain|criteo|pubmatic|rubiconproject|openx|indexexchange|spotxchange|yieldmo|smartadserver|imrworldwide|atdmt|moatads|serving-sys|2mdn|googletagmanager|analytics|mixpanel|facebook|doubleverify|teads|ligatus|adform|appnexus|casalemedia|contextweb|bidswitch|turn|mathtag|zedo|tremormedia|gumgum|adroll|sonobi|improvedigital|adcolony|vungle|unityads|chartboost|applovin|inmobi|supersonic|fyber|adincube|yieldlab|smaato|mopub|verizonmedia|adnxs|adsafeprotected|sitescout|avocet|tapad|krxd|adsrvr|amazon-adsystem|hotjar|clarity|jquery|jqueryui|bootstrapcdn|cloudflare|jsdelivr|unpkg|cdnjs)/.test(host)) return false;
    const path = (u.pathname || '').toLowerCase();
    if (/(\.m3u8|\.mp4|\.flv|\/m3u8[/?#]|m3u8_[a-z0-9]+)/.test(path)) return true;
    const q = decodeURIComponent(u.search || '');
    if (/(https?:\/\/[^&"'<> ]+?\.(m3u8|mp4)(\?|&|$))/i.test(q)) return true;
    return false;
  } catch (e) { return false; }
}

function extractVideoUrls(str) {
  const out = new Set();
  if (!str || typeof str !== 'string') return [...out];
  const re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|flv)[^\s"'<>\\]*/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    const u = m[0].replace(/[\\\]\)\}\;]*$/, '').trim();
    if (isVideoUrl(u)) out.add(u);
  }
  return [...out];
}

function walkJsonForVideoUrls(obj, out) {
  if (!out) out = new Set();
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string') {
    extractVideoUrls(obj).forEach((u) => out.add(u));
    return out;
  }
  if (Array.isArray(obj)) { obj.forEach((i) => walkJsonForVideoUrls(i, out)); return out; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const key = String(k).toLowerCase();
      if (typeof v === 'string' && (key.includes('url') || key.includes('src') || key.includes('play') || key.includes('video') || key.includes('m3u8') || key.includes('mp4'))) {
        extractVideoUrls(v).forEach((u) => out.add(u));
      }
      walkJsonForVideoUrls(v, out);
    }
  }
  return out;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled',
      '--disable-extensions', ...(PROXY ? [`--proxy-server=${PROXY}`] : [])]
  });

  for (const t of TESTS) {
    const page = await browser.newPage();
    const hits = new Set();
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        const hdrs = resp.headers();
        const ct = (hdrs && hdrs['content-type']) || '';
        if (/\.m3u8(\?|$)/i.test(u) || /mpegurl/i.test(ct)) {
          if (isVideoUrl(u)) hits.add(u);
          return;
        }
        if (/json|javascript|text\//i.test(ct) && /(api|json|play|video|url|jx|hls)/i.test(u)) {
          try {
            const body = await resp.text();
            extractVideoUrls(body).forEach((x) => { if (isVideoUrl(x)) hits.add(x); });
            try {
              const jm = body.match(/\{[\s\S]*\}/);
              if (jm) walkJsonForVideoUrls(JSON.parse(jm[0]), hits);
            } catch (e) {}
          } catch (e) {}
        }
      } catch (e) {}
    });
    const full = t.base + t.url;
    try {
      await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {}
    // 等待 10s 让播放器发起 m3u8 请求
    const start = Date.now();
    while (Date.now() - start < 10000 && hits.size === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(JSON.stringify({ test: t.provider, url: t.url, hits: [...hits].slice(0, 5) }));
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
