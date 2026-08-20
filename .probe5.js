const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const target = encodeURIComponent('https://tv.cctv.com/2024/01/01/VIDErGkYKj8vR5uMQ7P9V5e4240101.shtml');
const urls = [
  'https://jx.playerjy.com/?url=',
  'https://jx.yangtu.top/?url=',
  'https://www.yemu.xyz/?url=',
  'https://www.ckplayer.vip/jiexi/?url=',
];
(async () => {
  for (const p of urls) {
    console.log('\n==== ' + p + ' ====');
    try {
      const res = await fetch(p + target, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const ct = res.headers.get('content-type') || '';
      if (!(ct.includes('text') || ct.includes('html') || ct.includes('json'))) { console.log('非文本 ' + ct + ' status=' + res.status); continue; }
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      console.log('status=' + res.status + ' len=' + raw.length);
      const m3u8 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
      const mp4 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g) || [];
      const ifr = raw.match(/<iframe[^>]*src=["']?([^"'\s>]+)/gi) || [];
      const base64url = raw.match(/[A-Za-z0-9+/]{80,}={0,2}/g) || [];
      const iframes = ifr.slice(0,2).map(x => x.slice(0,140));
      console.log('  m3u8:', m3u8.slice(0,2).map(x=>x.slice(0,100)));
      console.log('  mp4:', mp4.slice(0,2).map(x=>x.slice(0,100)));
      console.log('  iframe:', iframes.join('\n             ') || '(none)');
      for (const b of base64url.slice(0,4)) { const d = Buffer.from(b,'base64').toString('utf8'); if (/https?:/.test(d)) console.log('  B64-> '+d.slice(0,100)); }
    } catch (e) { console.log('  ERR', e.name, e.message); }
  }
})();