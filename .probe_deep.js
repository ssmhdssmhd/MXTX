// 深挖有希望的候选：看返回结构，确定提取策略
const { fetch, EnvHttpProxyAgent } = require('undici');
const dispatcher = new EnvHttpProxyAgent();
const T = 'https://www.bilibili.com/video/BV1kS8H6VERt';
const enc = encodeURIComponent(T);
const list = [
  ['fongmi', 'https://json.fongmi.cc/web?url=' + enc],
  ['爱豆', 'https://jx.aidouer.net/?url=' + enc],
  ['冰豆', 'https://bd.jx.cn/?url=' + enc],
  ['七哥new', 'https://jx.202617.xyz/tv.php?url=' + enc],
  ['极速inner', 'https://jx.2s0.cn/player/analysis.php?v=' + enc],
];
(async () => {
  for (const [name, url] of list) {
    console.log('\n==== ' + name + ' ==== ' + url.slice(0, 80));
    try {
      const res = await fetch(url, { dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: T } });
      const raw = Buffer.from(await res.arrayBuffer()).toString('utf8');
      console.log('status=' + res.status + ' len=' + raw.length);
      const m3u8 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
      const mp4 = raw.match(/https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g) || [];
      const ifr = raw.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi) || [];
      console.log('  m3u8:', m3u8.slice(0,2).map(x=>x.slice(0,110)));
      console.log('  mp4:', mp4.slice(0,2).map(x=>x.slice(0,110)));
      console.log('  iframe:', ifr.slice(0,2).map(x=>x.slice(0,100)));
      // 判断是否 JSON 直出
      const jsonLike = raw.trim().startsWith('{') || raw.trim().startsWith('[');
      console.log('  JSON直出: ' + jsonLike);
      if (jsonLike) console.log('  头200字: ' + raw.replace(/\s+/g,' ').slice(0, 200));
      else {
        // 找关键 js/api 引用
        const refs = raw.match(/(?:src|href)=["']([^"']+\.(?:js|php)[^"']*)["']/gi) || [];
        console.log('  引用:', [...new Set(refs)].slice(0,4).map(x=>x.slice(0,90)));
      }
    } catch (e) { console.log('  ERR', e.name, e.message.slice(0,60)); }
  }
})();