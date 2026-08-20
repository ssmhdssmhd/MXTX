const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const target = encodeURIComponent('https://v.qq.com/x/cover/mzc00200m8dggl2t.html');
const urls = [
  'https://jiexi.789jiexi.icu:4433/?url=',
  'https://www.playm3u8.cn/jiexi.php?url=',
  'https://json.ovvo.pro/jx.php?url=',
];
(async () => {
  for (const p of urls) {
    console.log('\n==== ' + p + ' ====');
    try {
      const res = await fetch(p + target, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      const ct = res.headers.get('content-type') || '';
      if (!(ct.includes('text') || ct.includes('html') || ct.includes('json'))) { console.log('非文本: ' + ct + ' status=' + res.status); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = buf.toString('utf8');
      console.log('status=' + res.status + ' len=' + raw.length);
      // 看有没有 iframe / src / video / m3u8
      const iframes = [];
      let m;
      const re = /<iframe[^>]*src=["']?([^"'\s>]+)/gi;
      while ((m = re.exec(raw)) !== null) iframes.push(m[1]);
      console.log('iframe src:', iframes.slice(0,5));
      m = raw.match(/<video[^>]*src=["']?([^"' >]+)/i); if (m) console.log('video src:', m[1]);
      m = raw.match(/\.m3u8[^"'<>\\\s]*/g); if (m) console.log('m3u8片段:', m.slice(0,5));
      const snippet = raw.replace(/\s+/g,' ').slice(0, 600);
      console.log('snippet:', snippet);
    } catch (e) { console.log('ERR', e.name, e.message); }
  }
})();