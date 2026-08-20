// 逐接口诊断：对同一真实视频，记录每家返回的结构特征（每个接口都不同）
const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const T = 'https://www.bilibili.com/video/BV1kS8H6VERt'; // 真实热播视频
const enc = encodeURIComponent(T);
const live = {
  'jx.xmflv.cc': 'https://jx.xmflv.cc/?url=',
  'jx.xmflv.com': 'https://jx.xmflv.com/?url=',
  'im1907.top': 'https://im1907.top/?jx=',
  'ckplayer.vip': 'https://www.ckplayer.vip/jiexi/?url=',
  '789jiexi.icu': 'https://jiexi.789jiexi.icu:4433/?url=',
  '8090g.cn': 'https://www.8090g.cn/?url=',
  'pangujiexi.com': 'https://www.pangujiexi.com/jiexi/?url=',
  'playm3u8.cn': 'https://www.playm3u8.cn/jiexi.php?url=',
  'json.ovvo.pro': 'https://json.ovvo.pro/jx.php?url=',
  'playerjy.com': 'https://jx.playerjy.com/?url=',
};
function classify(raw, base) {
  const out = { iframes: [], m3u8: [], mp4: [], api: [], obs: false };
  let m;
  const re = /<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = re.exec(raw)) !== null) out.iframes.push(m[1]);
  out.m3u8 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
  out.mp4 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g) || [];
  // 找解析 API 特征
  const apiRe = /(api\.php|jx\.php|api\/|action=|ajax|jsonp|\.php\?|vip|parse|player[^"']*\.js)/gi;
  const hits = raw.match(apiRe) || [];
  out.api = [...new Set(hits)].slice(0, 5);
  out.obs = /fromCharCode|atob\s*\(|base64|\\u00[0-9a-f]{2}|_0x[0-9a-f]{4}/i.test(raw);
  out.title = (raw.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  return out;
}
(async () => {
  for (const [name, p] of Object.entries(live)) {
    const start = Date.now();
    try {
      const res = await fetch(p + enc, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(9000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: T } });
      const ct = res.headers.get('content-type') || '';
      if (!/text|html|json/.test(ct)) { console.log(`\n[${name}] status=${res.status} 非文本 ${ct} (${Date.now()-start}ms)`); continue; }
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      const c = classify(raw, res.url || p);
      console.log(`\n[${name}] status=${res.status} len=${raw.length} (${Date.now()-start}ms) title=${c.title || '(空)'}`);
      if (c.iframes.length) console.log('  iframe: ' + c.iframes.slice(0,2).join('  |  '));
      if (c.m3u8.length) console.log('  m3u8:   ' + c.m3u8.slice(0,2).join('\n          ').slice(0,200));
      if (c.mp4.length) console.log('  mp4:    ' + c.mp4.slice(0,2).join(' | ').slice(0,160));
      if (c.api.length) console.log('  api特征: ' + c.api.join(', '));
      console.log('  混淆: ' + (c.obs ? '是(需浏览器渲染)' : '否') + ' | 类型: ' + (c.iframes.length ? 'iframe壳' : c.m3u8.length||c.mp4.length ? '直出' : 'JS渲染'));
    } catch (e) { console.log(`\n[${name}] ERR ${e.name} (${Date.now()-start}ms) ${e.message.slice(0,60)}`); }
  }
})();