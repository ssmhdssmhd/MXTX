const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const target = encodeURIComponent('https://v.qq.com/x/cover/mzc00200m8dggl2t.html');
(async () => {
  const res = await fetch('https://jx.xmflv.com/?url=' + target, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
  const lines = raw.split('\n');
  console.log('total lines', lines.length);
  // 找 api / ajax / jsonp / src 引用 / .js
  lines.forEach((l, i) => {
    if (/api\.php|ajax|jsonp|\.js["']|action=|auths|parse|src=|fetch\(|\.get\(|vid=|vsrc|url=|token/i.test(l)) {
      console.log(i + ': ' + l.replace(/^\s+/,'').slice(0, 220));
    }
  });
})();