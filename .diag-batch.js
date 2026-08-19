// 独立批量压测：模拟"批量嗅探"场景，监控服务存活、内存峰值与成功率
// 用法：node .diag-batch.js [并发数] [每轮间隔ms]
const { execSync } = require('child_process');
const fs = require('fs');

const CONC = parseInt(process.argv[2] || '6', 10);
const BASE = 'http://localhost:1314/sniff?url=';
// 用不同 URL 避免 LRU 缓存（同 URL 会缓存空结果）
const URLS = [
  'https://v.qq.com/x/cover/mzc00200q98x75k.html',
  'https://www.bilibili.com/video/BV1xx411c7mD',
  'https://www.bilibili.com/video/BV1GJ411x7h7',
  'https://www.sohu.com/a/123456789_114988',
  'https://v.qq.com/x/cover/mzc00200q98x75k.html',
  'https://www.bilibili.com/video/BV1Qv411x7kG',
  'https://www.bilibili.com/video/BV1vt4y1r7Vg',
  'https://v.qq.com/x/cover/mzc00200q98x75k.html'
];

function cgroupMemMB() {
  try { return Math.floor(parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10) / 1024 / 1024); } catch (e) { return 0; }
}

async function one(url, idx) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch(BASE + encodeURIComponent(url), { signal: ctrl.signal });
    const body = await res.json();
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const ok = body.code === 200 && body.url;
    console.log(`[#${idx}] ${ok ? '✅' : '❌'} ${ms}ms code=${body.code} providers=${body.providers || (body.hitProviders + '/' + body.totalProviders) || '-'} url=${(body.url || '').slice(0, 80) || (body.msg || '')}`);
    return ok ? 1 : 0;
  } catch (e) {
    console.log(`[#${idx}] 💥 ERR ${Date.now() - t0}ms ${e.message.split('\n')[0]}`);
    return 0;
  }
}

async function main() {
  console.log(`=== 批量压测: 并发 ${CONC}，URLs ${URLS.length} ===`);
  const peak = { mem: 0 };
  const memTimer = setInterval(() => { peak.mem = Math.max(peak.mem, cgroupMemMB()); }, 300);
  const results = [];
  // 分 3 轮，模拟持续批量
  for (let round = 0; round < 3; round++) {
    const batch = [];
    const slice = URLS.slice(0, CONC);
    for (let i = 0; i < slice.length; i++) batch.push(one(slice[i], round * CONC + i));
    const r = await Promise.all(batch);
    results.push(...r);
    console.log(`--- 第 ${round + 1} 轮完成: 成功 ${r.filter(Boolean).length}/${r.length}，当前内存 ${cgroupMemMB()}MB ---`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  clearInterval(memTimer);
  const total = results.length;
  const ok = results.filter(Boolean).length;
  console.log(`\n=== 汇总: 成功 ${ok}/${total}（${((ok / total) * 100).toFixed(0)}%）峰值内存 ${peak.mem}MB ===`);
  // 服务存活检查
  try {
    const alive = await fetch('http://localhost:1314/', { signal: AbortSignal.timeout(5000) });
    console.log(`服务存活: ✅ HTTP ${alive.status}`);
  } catch (e) {
    console.log(`服务存活: ❌ ${e.message.split('\n')[0]}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
