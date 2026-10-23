/**
 * 子路径挂载测试：验证同一份 handler 能作为 DSH 插件挂在 /live-workbench 下。
 * 这个能力是「左下角小模块」的基础 —— 插件用它把工作台页面挂进 GUI 同源路径。
 *
 * 用法：node scripts/mount-smoke.mjs
 */
import http from 'node:http';
import { createWorkbenchHandler } from '../server/lib/handler.mjs';

const BASE = '/live-workbench';
const PORT = 8791;

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${extra && !cond ? ' → ' + extra : ''}`);
};

const server = http.createServer(createWorkbenchHandler({ basePath: BASE }));
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

async function probe(path, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', location: res.headers.get('location') || '', text };
}

try {
  console.log(`子路径挂载测试 @ http://127.0.0.1:${PORT}${BASE}\n`);

  const root = await probe(BASE);
  ok(root.status === 302 && root.location === `${BASE}/`, 'GET /live-workbench 重定向补斜杠', JSON.stringify(root));

  const page = await probe(`${BASE}/`);
  ok(page.status === 200 && page.type.includes('text/html'), '页面可访问');
  ok(page.text.includes('直播工作台'), '页面内容正确');
  ok(/href="styles\.css(?:[?#][^"]*)?"/.test(page.text), '页面里的资源是相对路径（挂子路径的前提）');

  for (const [p, type] of [['app.js', 'javascript'], ['slides.js', 'javascript'], ['styles.css', 'text/css']]) {
    const r = await probe(`${BASE}/${p}`);
    ok(r.status === 200 && r.type.includes(type), `${p} 可访问 (${r.type})`);
  }

  const health = await probe(`${BASE}/api/health`);
  ok(health.status === 200, 'API 走前缀可访问');
  let parsed = {};
  try {
    parsed = JSON.parse(health.text);
  } catch { /* 下面断言会失败 */ }
  ok(parsed.ok === true, 'API 返回合法 JSON');

  const kb = await probe(`${BASE}/api/kb/stats`);
  ok(kb.status === 200, '知识库接口走前缀可访问');

  const build = await probe(`${BASE}/api/decks/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '挂载测试', durationMin: 30, products: [{ name: '冰岛老寨', mountainName: '冰岛', type: '生普' }] }),
  });
  const deck = JSON.parse(build.text);
  ok(build.status === 200 && deck.slides?.length > 3, `生成接口可用（${deck.slides?.length} 页）`);

  // 前缀之外必须拒绝，避免插件抢占 GUI 自己的路由
  const outside = await probe('/api/health');
  ok(outside.status === 404, '前缀之外返回 404（不会抢占 GUI 路由）');
  const outsidePage = await probe('/');
  ok(outsidePage.status === 404, '站点根不受影响');

  // 路径穿越防护
  const traversal = await probe(`${BASE}/../server/lib/paths.mjs`);
  ok(traversal.status === 404 || !traversal.text.includes('ensureAllDirs'), '路径穿越被挡住');

  console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
} finally {
  // await 关闭：紧跟 process.exit() 会与 libuv handle 收尾竞态（Windows 上触发断言）
  await new Promise((r) => server.close(r));
}
process.exitCode = failures === 0 ? 0 : 1;
