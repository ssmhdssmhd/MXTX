/**
 * 独立诊断脚本：逐个测试万能嗅探 18 个 PROVIDER 的 HTTP 阶段可用性
 * 目的：找出「单独都能成功、批量失败过多」的根因
 * 用法：node diag-providers.js [url]
 *   url 默认用 B站 BV1xx411c7mD
 */
const { fetch: undiciFetch, EnvHttpProxyAgent } = require('undici');

const PROVIDERS = [
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
  'https://jx.playerjy.com/?url='
];

const targetUrl = process.argv[2] || 'https://www.bilibili.com/video/BV1xx411c7mD';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const dispatcher = new EnvHttpProxyAgent();
const M3U8_REGEX = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g;
const MP4_REGEX = /https?:\/\/[^\s"'<>\\]+?\.mp4[^\s"'<>\\]*/g;
const VIDEO_EXT = /\.(m3u8|mp4|flv|mkv|avi|mov|wmv|webm|ts)(?![a-z0-9])/i;

function extractUrls(raw) {
  const out = new Set();
  const text = String(raw || '');
  let m;
  const re1 = new RegExp(M3U8_REGEX.source, 'g');
  while ((m = re1.exec(text)) !== null) out.add(m[0].replace(/\\\//g, '/'));
  const re2 = new RegExp(MP4_REGEX.source, 'g');
  while ((m = re2.exec(text)) !== null) out.add(m[0].replace(/\\\//g, '/'));
  return [...out].filter((u) => VIDEO_EXT.test(u));
}

async function testOne(provider, idx, timeout) {
  const fullUrl = provider + encodeURIComponent(targetUrl);
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await undiciFetch(fullUrl, {
      dispatcher,
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', Referer: targetUrl },
      redirect: 'follow'
    });
    const ct = res.headers.get('content-type') || '';
    // 读取有限 body
    const reader = res.body.getReader();
    let raw = '';
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) { try { await reader.cancel(); } catch (e) {} break; }
      raw += Buffer.from(value).toString('utf8');
    }
    const urls = extractUrls(raw);
    const ms = Date.now() - start;
    const ctType = ct.split(';')[0].trim() || '(none)';
    return { provider, idx, status: res.status, ms, ct: ctType, body: bytes, urls, ok: urls.length > 0, note: '' };
  } catch (e) {
    const ms = Date.now() - start;
    return { provider, idx, status: 0, ms, ct: '', body: 0, urls: [], ok: false, note: e.name === 'AbortError' ? `超时(${timeout}ms)` : e.message.split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('=== 万能嗅探 Provider 逐一直连诊断 ===');
  console.log('目标:', targetUrl);
  console.log('代理: EnvHttpProxyAgent（自动读系统代理）\n');
  const results = [];
  // 逐个串行测试（避免并发互相干扰，模拟「单独都能成功」）
  for (let i = 0; i < PROVIDERS.length; i++) {
    const r = await testOne(PROVIDERS[i], i, 20000);
    results.push(r);
    console.log(
      `[${String(i).padStart(2)}] ${r.ok ? '✅' : '❌'} ${r.status} ${r.ms}ms ${r.ct.padEnd(22)} ${r.urls.length}个 | ${r.provider} ${r.note}`
    );
    for (const u of r.urls.slice(0, 2)) console.log(`      → ${u.slice(0, 110)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n=== 汇总: 成功 ${okCount}/18 ===`);
  console.log('成功:', results.filter((r) => r.ok).map((r) => `#${r.idx}`).join(' '));
  console.log('失败:', results.filter((r) => !r.ok).map((r) => `#${r.idx}(${r.note})`).join(' '));
  process.exit(0);
}

main();
