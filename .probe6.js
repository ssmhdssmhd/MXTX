const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const target = encodeURIComponent('https://tv.cctv.com/2024/01/01/VIDErGkYKj8vR5uMQ7P9V5e4240101.shtml');
(async () => {
  for (const p of ['https://jx.yangtu.top/?url=', 'https://www.yemu.xyz/?url=', 'https://www.ckplayer.vip/jx.php?url=']) {
    console.log('\n==== ' + p + ' ====');
    try {
      const res = await fetch(p + target, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.yemu.xyz/' } });
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      console.log('status=' + res.status + ' len=' + raw.length);
      const lines = raw.split('\n').filter(l => /url|src|iframe|player|\.js|api|token|m3u8|mp4|vid|domain|suibian|suiyi/i.test(l));
      lines.slice(0, 12).forEach(l => console.log('  ' + l.replace(/^\s+/, '').slice(0, 200)));
    } catch (e) { console.log('  ERR', e.name, e.message); }
  }
})();