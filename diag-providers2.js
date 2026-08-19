/**
 * 诊断2：查看 Provider 返回的 HTML 内容特征（是否含 JS 播放器 / iframe / 需要浏览器渲染）
 */
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');
const PROVIDERS = require('./node_modules/undici/package.json') ? [
  'https://jx.xmflv.cc/?url=',
  'https://im1907.top/?jx=',
  'https://www.ckplayer.vip/jiexi/?url=',
  'https://www.8090g.cn/?url=',
  'https://www.pangujiexi.com/jiexi/?url=',
  'https://json.ovvo.pro/jx.php?url=',
  'https://jx.yparse.com/index.php?url=',
  'https://jx.4kdv.com/?url=',
  'https://www.mtosz.com/m3u8.php?url='
] : [];
const targetUrl = process.argv[2] || 'https://www.bilibili.com/video/BV1xx411c7mD';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const dispatcher = new EnvHttpProxyAgent();

async function main() {
  for (const p of PROVIDERS) {
    const fullUrl = p + encodeURIComponent(targetUrl);
    try {
      const res = await undiciFetch(fullUrl, {
        dispatcher,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: targetUrl },
        redirect: 'follow'
      });
      const raw = await res.text();
      const h = raw.slice(0, 400).replace(/\s+/g, ' ').trim();
      console.log('========================================');
      console.log(`${p}`);
      console.log(`status=${res.status} len=${raw.length}`);
      console.log(`has video ext: ${/(\.m3u8|\.mp4|\.flv|\.ts)(?![a-z0-9])/i.test(raw)}`);
      console.log(`has iframe: ${/iframe/i.test(raw)}  has player: ${/(player|video|dplayer|artplayer|jwplayer|aliplayer)/i.test(raw)}`);
      console.log(`has script src: ${/script\s+src=/i.test(raw)}`);
      console.log(`HEAD: ${h.slice(0, 200)}`);
    } catch (e) {
      console.log(`${p}  ERR: ${e.message}`);
    }
  }
  process.exit(0);
}
main();
