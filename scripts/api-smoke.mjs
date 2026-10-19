/**
 * API 冒烟测试：逐个打通所有端点。
 * 需要先启动服务（默认 8788，可用 PORT 或第一个参数覆盖）。
 * 用法：node scripts/api-smoke.mjs [port]
 */
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

function ok(cond, label, extra = '') {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${extra && !cond ? ' → ' + extra : ''}`);
}

function expectStatus(r, want, label) {
  ok(r.status === want, label, `期望 ${want}，实际 ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data;
}

console.log(`API 冒烟测试 @ ${BASE}\n`);

/* --- 基础 --- */
const health = expectStatus(await call('GET', '/api/health'), 200, 'GET /api/health');
ok(health.python?.ok === true, '  PPT 引擎可用');
expectStatus(await call('GET', '/api/options'), 200, 'GET /api/options');
expectStatus(await call('GET', '/api/settings'), 200, 'GET /api/settings');
expectStatus(await call('POST', '/api/settings', { host: '测试主播' }), 200, 'POST /api/settings');

/* --- 知识库 --- */
const kb = expectStatus(await call('GET', '/api/kb'), 200, 'GET /api/kb');
ok((kb.mountains || []).length > 20, `  山头条目 ${(kb.mountains || []).length}`);
expectStatus(await call('GET', '/api/kb/stats'), 200, 'GET /api/kb/stats');
const search = expectStatus(await call('GET', '/api/kb/search?q=冰岛'), 200, 'GET /api/kb/search?q=冰岛');
ok((search.mountains || []).length > 0, '  搜索「冰岛」有结果');
const mk = expectStatus(
  await call('POST', '/api/kb/mountain', { id: '__smoke_test__', name: '冒烟测试山头', region: '测试' }),
  200,
  'POST /api/kb/mountain'
);
ok(mk.ok, '  新增山头成功');
expectStatus(await call('POST', '/api/kb/delete', { type: 'mountain', id: '__smoke_test__' }), 200, 'POST /api/kb/delete');

/* --- 模块3 --- */
const deck = expectStatus(
  await call('POST', '/api/decks/build', {
    topic: 'API 冒烟场',
    host: '测试',
    products: [{ name: '冰岛老寨春茶', mountainName: '冰岛', type: '生普', spec: '200g/饼', price: 1980 }],
    purpose: 'knowledge',
    durationMin: 30,
  }),
  200,
  'POST /api/decks/build'
);
ok(deck.slides?.length > 5, `  生成页数 ${deck.slides?.length}`);
ok(deck.script?.fullText?.length > 1000, `  稿子字数 ${deck.script?.fullText?.length}`);
const deckList = expectStatus(await call('GET', '/api/decks'), 200, 'GET /api/decks');
ok(deckList.some((d) => d.id === deck.id), '  方案出现在列表里');
const loaded = expectStatus(await call('GET', `/api/decks/${deck.id}`), 200, 'GET /api/decks/:id');
ok(loaded.id === deck.id, '  按 id 取回方案');
expectStatus(await call('POST', `/api/decks/${deck.id}/recheck`, {}), 200, 'POST /api/decks/:id/recheck');
const exp = expectStatus(await call('POST', `/api/decks/${deck.id}/export`, { format: 'pptx' }), 200, 'POST /api/decks/:id/export (pptx)');
ok(exp.pptx?.ok === true, '  PPTX 导出成功', JSON.stringify(exp.pptx).slice(0, 200));
const exp2 = expectStatus(await call('POST', `/api/decks/${deck.id}/export`, { format: 'script' }), 200, 'POST /api/decks/:id/export (script)');
ok(exp2.script?.ok === true, '  口播稿导出成功');

/* --- 产物下载 --- */
if (exp.pptx?.ok) {
  const name = exp.pptx.pptxPath.split(/[\\/]/).pop();
  const r = await fetch(`${BASE}/files/pptx/${encodeURIComponent(name)}`);
  ok(r.status === 200, 'GET /files/pptx/:name 可下载');
  const buf = Buffer.from(await r.arrayBuffer());
  ok(buf.slice(0, 2).toString() === 'PK', `  下载内容为合法 PPTX（${(buf.length / 1024).toFixed(0)} KB）`);
}

/* --- 合规 --- */
const cmp = expectStatus(await call('GET', '/api/compliance'), 200, 'GET /api/compliance');
ok((cmp.categories || []).length > 5, `  风险分类 ${(cmp.categories || []).length} 类`);
expectStatus(await call('GET', '/api/compliance/stats'), 200, 'GET /api/compliance/stats');
const hit = expectStatus(await call('POST', '/api/compliance/check', { text: '全国最低价，能降三高' }), 200, 'POST /api/compliance/check');
ok(hit.hits?.length > 0, `  命中 ${hit.hits?.length} 处`);
const clean = expectStatus(await call('POST', '/api/compliance/check', { text: '第一泡快出汤，老班章这款茶最多泡十次' }), 200, 'POST /api/compliance/check（正常表达）');
ok(clean.hits?.length === 0, '  正常茶行业表达零误报', JSON.stringify(clean.hits));
expectStatus(await call('POST', '/api/compliance/whitelist', { word: '__smoke__' }), 200, 'POST /api/compliance/whitelist');
expectStatus(await call('DELETE', '/api/compliance/whitelist', { word: '__smoke__' }), 200, 'DELETE /api/compliance/whitelist');

/* --- 情报 --- */
expectStatus(await call('GET', '/api/intel'), 200, 'GET /api/intel');
const added = expectStatus(await call('POST', '/api/intel', { title: '冒烟测试情报：云南春茶减产', summary: '古树茶原料价格上涨' }), 200, 'POST /api/intel');
ok(added.added >= 0, `  录入 ${added.added} 条`);
expectStatus(await call('POST', '/api/intel/autotag', { text: '冰岛古树春茶价格行情' }), 200, 'POST /api/intel/autotag');
expectStatus(await call('GET', '/api/intel/sources'), 200, 'GET /api/intel/sources');
const topics = expectStatus(await call('GET', '/api/intel/topics?limit=5'), 200, 'GET /api/intel/topics');
ok(Array.isArray(topics), `  选题建议 ${topics.length} 条`);
for (const it of (await call('GET', '/api/intel')).data.items || []) {
  if (it.title?.startsWith('冒烟测试情报')) await call('DELETE', `/api/intel/${it.id}`);
}

/* --- 弹幕问答 --- */
expectStatus(await call('GET', '/api/qa/intents'), 200, 'GET /api/qa/intents');
const risky = expectStatus(await call('POST', '/api/qa/answer', { question: '这个茶能降三高吗' }), 200, 'POST /api/qa/answer（功效类）');
ok(risky.blocked === true, '  功效类问题被拦截并改写');
ok(!/降三高|抗癌/.test(risky.answer), '  改写后的回答不含功效表述');
const normal = expectStatus(await call('POST', '/api/qa/answer', { question: '这个茶怎么泡比较好' }), 200, 'POST /api/qa/answer（冲泡）');
ok(normal.answer?.length > 20, '  正常问题有回答');
ok(normal.blocked === false, '  正常问题未误拦');
expectStatus(await call('POST', '/api/qa/batch', { questions: ['多少钱', '会不会苦', '能存多久'] }), 200, 'POST /api/qa/batch');
expectStatus(await call('GET', '/api/qa/faq'), 200, 'GET /api/qa/faq');
const faq = expectStatus(await call('POST', '/api/qa/faq', { q: '__smoke_q__', a: '冒烟回答' }), 200, 'POST /api/qa/faq');
if (faq.item?.id) await call('DELETE', `/api/qa/faq/${faq.item.id}`);

/* --- 复盘 --- */
expectStatus(await call('GET', '/api/sessions'), 200, 'GET /api/sessions');
const sess = expectStatus(
  await call('POST', '/api/sessions', {
    title: '冒烟复盘',
    durationMin: 60,
    metrics: { peakViewers: 320, avgViewers: 140, productClicks: 460, orders: 26, gmv: 12400, newFollowers: 38, comments: 210 },
    segments: [{ t: '00:18:00', label: '老班章讲解', viewers: 320, orders: 9, note: '山场讲得细' }],
  }),
  200,
  'POST /api/sessions'
);
ok(!!sess.id, '  新建场次返回 id');
const rv = expectStatus(await call('POST', `/api/sessions/${sess.id}/analyze`, {}), 200, 'POST /api/sessions/:id/analyze');
ok(rv.metrics?.aov > 0, `  派生指标 客单价 ${rv.metrics?.aov}`);
ok(Array.isArray(rv.issues), `  诊断 ${rv.issues?.length} 条`);
ok(Array.isArray(rv.clips), `  切片建议 ${rv.clips?.length} 条`);
ok(Array.isArray(rv.actions) && rv.actions.length > 0, `  行动清单 ${rv.actions?.length} 条`);
expectStatus(await call('GET', `/api/sessions/${sess.id}`), 200, 'GET /api/sessions/:id');
expectStatus(await call('DELETE', `/api/sessions/${sess.id}`), 200, 'DELETE /api/sessions/:id');

/* --- 视觉风格（渲染期选择，不进 DeckSpec） --- */
const opts = expectStatus(await call('GET', '/api/options'), 200, 'GET /api/options（含视觉风格）');
ok(Array.isArray(opts.deckStyles) && opts.deckStyles.length >= 1, `  风格清单 ${opts.deckStyles?.length} 个`);
ok(
  opts.deckStyles.every((s) => s.id && s.label && s.source && typeof s.ready === 'boolean'),
  '  每个风格都有 id/label/source/ready（出处诚实标注）'
);
ok(!!opts.defaultDeckStyle, `  默认风格 ${opts.defaultDeckStyle}`);

const readyStyle = (opts.deckStyles.find((s) => s.ready) || {}).id;
const notReady = (opts.deckStyles.find((s) => !s.ready) || {}).id;

const html = expectStatus(
  await call('POST', `/api/decks/${deck.id}/export-html`, { style: readyStyle, mode: 'present' }),
  200,
  `POST /api/decks/:id/export-html（风格 ${readyStyle}）`
);
ok(html.ok === true, '  HTML 渲染成功');
ok(html.bytes > 5000 && html.slides > 0, `  ${html.slides} 页 / ${(html.bytes / 1024).toFixed(1)} KB`);
ok(/^output\/html\//.test(html.relativePath || ''), `  落在 ${html.relativePath}`);

// 生成出来的 HTML 必须是同源可取回、且是 inline（新标签页直接打开）而不是下载
const fileRes = await fetch(`${BASE}/files/html/${encodeURIComponent(html.fileName)}`);
ok(fileRes.status === 200, `GET /files/html/<name> 返回 ${fileRes.status}`);
ok((fileRes.headers.get('content-type') || '').includes('text/html'), '  以 text/html 提供');
ok(/inline/i.test(fileRes.headers.get('content-disposition') || ''), '  disposition=inline（新标签页打开）');
const htmlBody = await fileRes.text();
ok((htmlBody.match(/<section class="slide/g) || []).length === html.slides, '  取回的 HTML 页数与返回一致');

// flat 模式：所有页同时可见（HTML→PPTX 转换的前提）
const flat = expectStatus(
  await call('POST', `/api/decks/${deck.id}/export-html`, { style: readyStyle, mode: 'flat' }),
  200,
  'POST /api/decks/:id/export-html（flat 模式）'
);
ok(flat.ok === true && /-flat\.html$/.test(flat.fileName), `  flat 产物 ${flat.fileName}`);

if (notReady) {
  const bad = expectStatus(
    await call('POST', `/api/decks/${deck.id}/export-html`, { style: notReady }),
    200,
    `POST 未实现的风格 ${notReady} 应明确报错`
  );
  ok(bad.ok === false && /尚未实现/.test(bad.message || ''), `  明确报错：${bad.message}`);
}

const unknown = expectStatus(await call('POST', `/api/decks/${deck.id}/export-html`, { style: '__nope__' }), 200, 'POST 不存在的风格');
ok(unknown.ok === false, `  也明确报错：${unknown.message}`);

const pps = expectStatus(await call('GET', '/api/pptx-by-style/status'), 200, 'GET /api/pptx-by-style/status');
ok(typeof pps.ok === 'boolean', `  按风格转 PPTX 环境 ${pps.ok ? '可用' : '不可用（' + (pps.message || '').slice(0, 40) + '）'}`);

/* --- 末尾斜杠容错 --- */
expectStatus(await call('GET', '/api/sessions/'), 200, 'GET /api/sessions/（末尾斜杠容错）');

/* --- 404 --- */
expectStatus(await call('GET', '/api/not-exist'), 404, 'GET /api/not-exist 返回 404');

await call('DELETE', `/api/decks/${deck.id}`);

console.log(`\n${failures === 0 ? `全部通过 ✅（${checks} 项）` : `失败 ${failures} / ${checks} 项 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
