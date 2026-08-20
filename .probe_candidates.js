// 候选解析接口探针（undici 代理感知版）
// 用法: node .probe_candidates.js [视频URL]
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');

const TARGET = process.argv[2] || 'https://www.bilibili.com/video/BV1kS8H6VERt';

const CANDIDATES = [
  ['爱豆', 'https://jx.aidouer.net/?url='],
  ['战狼', 'https://jx.zhanlangbu.com/?url='],
  ['联发卡', 'https://vip.lianfaka.com/vip/?url='],
  ['jsonplayer', 'https://jx.jsonplayer.com/player/?url='],
  ['okjx', 'https://okjx.cc/?url='],
  ['nxflv', 'https://www.nxflv.com/?url='],
  ['m3u8.tv', 'https://jx.m3u8.tv/jiexi/?url='],
  ['blbo', 'https://jx.blbo.cc:4433/?url='],
  ['qianqi', 'https://api.qianqi.net/vip/?url='],
  ['nnxv', 'https://jx.nnxv.cn/tv.php?url='],
  ['bd.jx', 'https://bd.jx.cn/?url='],
  ['1dior', 'https://123.1dior.cn/?url='],
  ['ckmov.vip', 'https://www.ckmov.vip/api.php?url='],
  ['ckmov.ccyjjd', 'https://ckmov.ccyjjd.com/ckmov/?url='],
  ['ckmov.com', 'https://www.ckmov.com/?url='],
  ['h8jx', 'https://www.h8jx.com/jiexi.php?url='],
  ['bljiex', 'https://svip.bljiex.cc/?v='],
  ['jiexi.la', 'https://api.jiexi.la/?url='],
  ['janan', 'https://jiexi.janan.net/jiexi/?url='],
  ['mtosz', 'https://www.mtosz.com/erzi.php?url='],
  ['administratorw', 'https://www.administratorw.com/video.php?url='],
  ['pangujiexi.cc', 'https://www.pangujiexi.cc/jiexi.php?url='],
  ['gai4', 'https://www.gai4.com/?url='],
  ['yh0523', 'https://go.yh0523.cn/y.cy?url='],
  ['1717yun', 'https://www.1717yun.com/jx/ty.php?url='],
  ['4kdv', 'https://jx.4kdv.com/?url='],
  ['dj6u', 'https://jx.dj6u.com/?url='],
  ['000180', 'https://jx.000180.top/jx/?url='],
  ['fongmi', 'https://json.fongmi.cc/web?url='],
  ['hls.one', 'https://jx.hls.one/?url='],
  ['冰豆', 'https://www.bingdou.net/?url='],
  ['baiyug', 'http://api.baiyug.cn/vip/index.php?url='],
  ['vipjiexi', 'http://www.vipjiexi.com/yun.php?url='],
  ['1008net', 'http://api.1008net.com/v.php?url='],
  ['nepian', 'http://api.nepian.com/ckparse/?url='],
  ['jidiaose', 'http://player.jidiaose.com/supapi/iframe.php?v='],
  ['pucms', 'http://api.pucms.com/index.php?url='],
  ['wlzhan', 'http://api.wlzhan.com/sudu/?url='],
  ['0335haibo', 'http://www.0335haibo.com/yun.php?url='],
  ['sfsft', 'http://www.sfsft.com/video.php?url='],
  ['shankubf', 'https://www.shankubf.com/m3u8/?url='],
  ['dphw8', 'https://player.dphw8.com/player?url='],
  ['hoplayer', 'https://hoplayer.com/index.html?url='],
  ['mmbb', 'https://mmbb.icu/?url='],
];

const VIDEO_RE = /https?:\/\/[^\s"'<>\\]+?\.(m3u8|mp4|flv)[^\s"'<>\\]*/gi;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function extractUrls(body) {
  const found = new Set();
  const m = body.match(VIDEO_RE) || [];
  m.forEach((u) => {
    if (/\.(js|css|png|jpg|gif|ico)(\?|$)/i.test(u)) return;
    if (/player\.js|logo|icon/.test(u)) return;
    found.add(u.slice(0, 220));
  });
  ['m3u8', 'mp4'].forEach((k) => {
    const re = new RegExp(`https?:\\\\?/\\\\?/[^"'\\s]+?\\.${k}[^"'\\s]*`, 'gi');
    const mm = body.match(re) || [];
    mm.forEach((u) => { if (!u.includes('\\/')) found.add(u.replace(/\\\//g, '/').slice(0, 220)); });
  });
  return [...found];
}

(async () => {
  const dispatcher = new EnvHttpProxyAgent();
  console.log('目标:', TARGET);
  console.log('===============================================');
  let okCount = 0;
  for (const [name, base] of CANDIDATES) {
    const url = base + encodeURIComponent(TARGET);
    const t0 = Date.now();
    let r = null;
    try {
      const res = await undiciFetch(url, {
        dispatcher,
        redirect: 'follow',
        headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
      });
      const buf = await res.arrayBuffer();
      r = { code: res.status, body: Buffer.from(buf).toString('utf8') };
    } catch (e) {
      r = { code: 0, body: '' };
    }
    const ms = Date.now() - t0;
    const urls = (r.code === 200 && r.body) ? extractUrls(r.body) : [];
    const status = r.code === 0 ? '失败' : ('HTTP ' + r.code);
    const hit = urls.length > 0;
    if (hit) okCount++;
    console.log(`[${hit ? 'HIT' : '---'}] ${name.padEnd(14)} ${status.padEnd(10)} ${ms}ms len=${r.body ? r.body.length : 0} urls=${urls.length}`);
    if (hit) urls.forEach((u) => console.log('        -> ' + u));
  }
  console.log('===============================================');
  console.log(`总计: ${CANDIDATES.length} 条, 命中: ${okCount} 条`);
})();
