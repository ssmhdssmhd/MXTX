// 临时连通性探针：测 18 家 Provider 与候选新源的 HTTP 可达性
const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const providers = [
  'https://jx.xmflv.cc/?url=',
  'https://jx.xmflv.com/?url=',
  'https://im1907.top/?jx=',
  'https://yparse.ik9.cc/index.php?url=',
  'https://www.ckplayer.vip/jiexi/?url=',
  'https://jiexi.789jiexi.icu:4433/?url=',
  'https://www.8090g.cn/?url=',
  'https://www.pangujiexi.com/jiexi/?url=',
  'https://jx.m3u8.tv/jiexi/?url=',
  'https://www.playm3u8.cn/jiexi.php?url=',
  'https://json.ovvo.pro/jx.php?url=',
  'https://api.qianqi.net/vip/?url=',
  'https://jx.yparse.com/index.php?url=',
  'https://www.yemu.xyz/?url=',
  'https://jx.yangtu.top/?url=',
  'https://jx.4kdv.com/?url=',
  'https://www.mtosz.com/m3u8.php?url=',
  'https://jx.playerjy.com/?url=',
  // 候选新源
  'https://api.107kan.cn/jx.php?url=',
  'https://api.zjx.app/api/bus.php?url=',
  'https://jiexi.cc/api/jiexi.php?url=',
  'https://www.mcfun.top/jx.php?url=',
  'https://api.videocn.cn/api/api.php?url=',
  'https://xml.310hk.com/x5.php?url=',
  'https://api.wujiekeji.com/jx.php?url=',
  'https://jx.apiacg.xyz/?url=',
  'https://qiyue.vip/api/jiexi/?url=',
  'https://parsec.icu/api/jx/?url=',
  'https://jx.bozrc.com/?url=',
  'https://dhlvip.com/api.php?url=',
];
function statusText(n) {
  if (n < 300) return 'LIVE';
  if (n === 302) return 'REDIRECT';
  if (n >= 400) return 'DEAD' + n;
  return String(n);
}
(async () => {
  for (const p of providers) {
    const start = Date.now();
    try {
      const res = await fetch(p + encodeURIComponent('https://www.bilibili.com/video/BV1xx411c7mD'), {
        dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      let body = '';
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        const bytes = [];
        for (let i = 0; i < 5; i++) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes.push(value);
        }
        body = Buffer.concat(bytes.map(b => Buffer.from(b))).toString('utf8').replace(/https?:\/\/[^\s"'<>]+?\.m3u8/g, '[M3U8]').replace(/https?:\/\/[^\s"'<>]+?\.mp4/g, '[MP4]');
        try { await reader.cancel(); } catch (e) { }
      }
      const type = res.headers.get('content-type') || '';
      const ms = Date.now() - start;
      console.log(`[${statusText(res.status)}] ${ms}ms ${p}`);
      if (body) console.log(`       ${type.slice(0,30)} | ${body.slice(0, 120).replace(/\n/g,' ')}`);
    } catch (e) {
      console.log(`[ERR ] ${e.name} ${Date.now()-start}ms ${p}`);
    }
  }
})();