// 联网候选接口批量实测：同一真实视频，测可达性 + 返回结构
const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const T = 'https://www.bilibili.com/video/BV1kS8H6VERt';
const enc = encodeURIComponent(T);
const cand = [
  ['爱豆', 'https://jx.aidouer.net/?url='],
  ['战狼', 'https://jx.zhanlangbu.com/?url='],
  ['联发卡', 'https://vip.lianfaka.com/vip/?url='],
  ['博兹播放器', 'https://jx.bozrc.com:4433/player/?url='],
  ['TYUN', 'https://api.tyun77.cn/api.php/provide/parserUrl?url='],
  ['无名', 'https://bfq.xingwendiyixian.cn/?url='],
  ['七哥', 'https://jx.nnxv.cn/tv.php?url='],
  ['fongmi', 'https://json.fongmi.cc/web?url='],
  ['HLS.one', 'https://jx.hls.one/?url='],
  ['冰豆', 'https://bd.jx.cn/?url='],
  ['789解析', 'https://jiexi.789jiexi.com/?url='],
  ['极速', 'https://jx.2s0.cn/player/?url='],
  ['麒麟', 'https://t2.qlplayer.cyou/player/analysis.php?v='],
  ['RdfPlayer', 'https://rdfplayer.mrgaocloud.com/player/?url='],
  ['听乐', 'https://jx.dj6u.com/?url='],
  ['维多', 'https://jx.ivito.cn/?url='],
  ['52jiexi', 'https://vip.52jiexi.top/?url='],
  ['lfeifei', 'https://jx.lfeifei.cn/?url='],
  ['steak517', 'https://api.steak517.top/?url='],
  ['elwtc', 'https://jx.elwtc.com/vip/?url='],
  ['78sy', 'https://api.78sy.cn/?url='],
  ['2ajx', 'https://www.2ajx.com/vip.php?url='],
];
(async () => {
  for (const [name, p] of cand) {
    const base = p.replace(/\?url=$/, '?url='); // 麒麟用 v= 参数需特殊拼
    const sep = /v=$/.test(p) ? 'v=' : 'url=';
    const full = p + (sep === 'v=' ? encodeURIComponent(T) : enc);
    const start = Date.now();
    try {
      const res = await fetch(full, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(9000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: T } });
      const ct = res.headers.get('content-type') || '';
      const loc = res.headers.get('location') || '';
      if (!/text|html|json|mpegurl/.test(ct)) { console.log(`[${name}] ${p} status=${res.status} 非文本(${ct.split(';')[0]}) ${Date.now()-start}ms`); continue; }
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      const m3u8 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
      const mp4 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g) || [];
      const ifr = raw.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi) || [];
      const title = (raw.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      const jsn = raw.match(/\{"?url"?[^}]{0,120}/);
      console.log(`\n[${name}] ${p}`);
      console.log(`  status=${res.status} len=${raw.length} ${Date.now()-start}ms title=${title.slice(0,40)}`);
      if (loc) console.log('  redirect-> ' + loc.slice(0, 90));
      if (m3u8.length) console.log('  ★m3u8: ' + m3u8[0].slice(0, 120));
      if (mp4.length) console.log('  ★mp4:  ' + mp4[0].slice(0, 120));
      if (ifr.length) console.log('  iframe: ' + ifr[0].slice(0, 110));
      if (!m3u8.length && !mp4.length && !ifr.length && jsn) console.log('  json片段: ' + jsn[0].slice(0, 110));
    } catch (e) { console.log(`[${name}] ${p} ERR ${e.name} ${Date.now()-start}ms ${e.message.slice(0,50)}`); }
  }
})();