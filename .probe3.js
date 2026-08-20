const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const target = encodeURIComponent('https://v.qq.com/x/cover/mzc00200m8dggl2t.html');
const urls = [
  'https://jx.xmflv.com/?url=',
  'https://www.playm3u8.cn/playm3u8.php?url=',
];
(async () => {
  for (const p of urls) {
    console.log('\n==== ' + p + ' ====');
    try {
      const res = await fetch(p + target, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://www.playm3u8.cn/' } });
      const ct = res.headers.get('content-type') || '';
      if (!(ct.includes('text') || ct.includes('html') || ct.includes('json') || ct.includes('mpegurl'))) { console.log('非文本: ' + ct + ' status=' + res.status); continue; }
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      console.log('status=' + res.status + ' len=' + raw.length);
      const m3u8 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
      const mp4 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g) || [];
      console.log('m3u8:', m3u8.slice(0,3));
      console.log('mp4:', mp4.slice(0,3));
      let m = raw.match(/<iframe[^>]*src=["']?([^"'\s>]+)/gi); if (m) console.log('iframe:', m.slice(0,3));
      const snippet = raw.replace(/\s+/g,' ').slice(0, 500);
      console.log('snippet:', snippet);
    } catch (e) { console.log('ERR', e.name, e.message); }
  }
})();