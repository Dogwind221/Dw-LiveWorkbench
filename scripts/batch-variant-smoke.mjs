/**
 * 批量生成 + A/B 对比验证（第 12 周）。
 *
 * 测什么：
 *   1. **批量**：N 份一次生成、进度回调、单项失败不拖垮整批、幂等跳过、force、dryRun
 *   2. **A/B**：事实锁定（改价格必须被拒）、时长不同要提示不可比、合规预警、决策提示
 *   3. **HTTP**：/api/batch、/api/variants 路由
 *
 * 用法：
 *   node scripts/batch-variant-smoke.mjs
 *
 * 全程**不调模型**（批量生成是确定性模板引擎），所以又快又免费。
 * 结束时删除本次生成的所有方案与批次清单，不污染用户数据。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runBatch, listMountainChoices, signatureOf } from '../server/lib/batch.mjs';
import { buildVariants, factSignatureOf } from '../server/lib/variant.mjs';
import { decksDir } from '../server/lib/paths.mjs';
import { createWorkbenchHandler } from '../server/lib/handler.mjs';
import http from 'node:http';

const PORT = 8809;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];
const createdDecks = new Set();
const createdManifests = new Set();
let server = null;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

const decksPath = () => decksDir();

/**
 * 本次测试的标记。
 *
 * 为什么不能只靠"记录 deckId 再删"：如果测试进程被外部打断
 * （比如 PowerShell 管道接到 `Select-Object -First`，上游会被提前终止），
 * `finally` 根本跑不完，遗留文件就会污染下一次运行 ——
 * 下次跑第一批会因为"签名已存在"而全部跳过，测试直接假失败。
 *
 * 所以给产物打 tag，**开始和结束各清扫一次**，即使上次被杀也能自愈。
 */
const TAG = 'smoke-batch-variant';
const runB = (opts) => runBatch({ ...opts, tag: TAG });
const buildV = (opts) => buildVariants({ ...opts, tag: TAG });

/** 扫掉所有带本次 tag 的方案与批次清单（含上次被杀留下的）。 */
function sweepTag() {
  const dir = decksPath();
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(dir, f);
    try {
      const d = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (d?.tag === TAG) { fs.unlinkSync(full); n++; }
    } catch {
      /* 坏文件跳过 */
    }
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */
console.log('=== 批量生成与 A/B 对比验证（第 12 周）===');
const swept = sweepTag();
if (swept) console.log(`  （清扫了上次遗留的 ${swept} 个测试产物）`);
const choices = listMountainChoices();
check('能拿到山头候选清单', choices.length > 0, `实际 ${choices.length} 个`);
const [m1, m2, m3] = choices;

server = http.createServer(createWorkbenchHandler());
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

try {
  /* ================================================================ *
   * A. 批量生成
   * ================================================================ */
  section('[A] 批量生成');

  /**
   * 每次运行都用**唯一的 topic**。
   *
   * 为什么必须这样：批量生成是幂等的（签名相同就跳过），而签名包含 `topic`。
   * 如果用固定的 topic，那么"用户自己已经生成过同参数方案"或"上一轮测试留下的方案"
   * 会让本轮的"应该新生成 3 份"变成"全部跳过" —— 测试直接假失败。
   *
   * 这是真实发生过的：我在界面上手点了几次批量生成（同样参数），
   * 之后跑这个测试就变成 41/44 失败。**测试不能依赖全局数据状态。**
   */
  const RUN = `smoke-${Date.now().toString(36)}`;
  const template = { topic: RUN, purpose: 'knowledge', audience: 'veteran', style: 'storyteller', durationMin: 45 };
  const batchInputs = [{ mountainName: m1.name }, { mountainName: m2.name }, { mountainName: m3.name }];

  const progress = [];
  const r1 = await runB({
    items: batchInputs,
    template,
    onProgress: (p) => progress.push(p),
  });
  for (const x of r1.results) if (x.deckId) createdDecks.add(x.deckId);
  createdManifests.add(`_batch-${r1.batchId}.json`);

  check('三份全部生成成功', r1.ok === 3 && r1.failed === 0, JSON.stringify({ total: r1.total, ok: r1.ok, failed: r1.failed }));
  check('每份都有 deckId', r1.results.every((x) => !!x.deckId));
  check('进度回调被调用 3 次', progress.length === 3, `实际 ${progress.length}`);
  check('进度里带 status=ok', progress.every((p) => p.status === 'ok'));
  check('每份都带可选指标（页数/字数/合规）',
    r1.results.every((x) => x.stats && x.stats.slides > 0 && x.stats.scriptChars > 0 && !!x.stats.complianceLevel),
    JSON.stringify(r1.results[0]?.stats));
  check('生成的文件真的落盘了',
    r1.results.every((x) => fs.existsSync(path.join(decksPath(), `${x.deckId}.json`))));
  check('批次清单也落盘了', fs.existsSync(path.join(decksPath(), `_batch-${r1.batchId}.json`)));

  // 同一个山头 + 同样参数 → 应该跳过
  const r2 = await runB({ items: batchInputs, template });
  for (const x of r2.results) if (x.deckId) createdDecks.add(x.deckId);
  createdManifests.add(`_batch-${r2.batchId}.json`);
  check('★ 幂等：同样输入重跑全部跳过', r2.skipped === 3 && r2.ok === 0, JSON.stringify({ skipped: r2.skipped, ok: r2.ok }));
  check('跳过时复用原有 deckId', r2.results.every((x) => r1.results.some((y) => y.deckId === x.deckId)));

  const r3 = await runB({ items: batchInputs, template, force: true });
  for (const x of r3.results) if (x.deckId) createdDecks.add(x.deckId);
  createdManifests.add(`_batch-${r3.batchId}.json`);
  check('force 强制重跑，不跳过', r3.ok === 3 && r3.skipped === 0, JSON.stringify({ ok: r3.ok, skipped: r3.skipped }));
  check('force 后 deckId 是新的', r3.results.every((x) => !r1.results.some((y) => y.deckId === x.deckId)));

  const r4 = await runB({ items: batchInputs, template, dryRun: true });
  check('dryRun 不生成方案', r4.ok === 3 && r4.results.every((x) => !x.deckId));
  check('dryRun 会标出哪些会被跳过', r4.results.every((x) => x.wouldSkip === true), JSON.stringify(r4.results.map((x) => x.wouldSkip)));

  /* ---- 单项失败不拖垮整批 ---- */
  const rBad = await runB({
    items: [
      { mountainName: m1.name, durationMin: 30 },      // 正常
      { mountainName: '不存在的山头xyz', durationMin: 30 }, // 不会抛错，只会没有山场
      { mountainName: m2.name, durationMin: 30 },
    ],
    template: { topic: `${RUN}-bad` },
  });
  for (const x of rBad.results) if (x.deckId) createdDecks.add(x.deckId);
  createdManifests.add(`_batch-${rBad.batchId}.json`);
  check('不存在的山头不会让整批失败（降级为无山场方案）',
    rBad.ok === 3 && rBad.failed === 0, JSON.stringify({ ok: rBad.ok, failed: rBad.failed }));

  /* ---- ★ 静默降级必须被标出来 ---- */
  check('★ 山场没匹配上时标记 degraded + MOUNTAIN_NOT_FOUND',
    rBad.results[1].degraded === true &&
    rBad.results[1].warnings.some((w) => w.code === 'MOUNTAIN_NOT_FOUND'),
    JSON.stringify(rBad.results[1]?.warnings));
  check('★ 正常的项不应被标记 degraded', rBad.results[0].degraded === false);
  check('★ 批次汇总里 degraded 计数正确', rBad.degraded === 1, `实际 ${rBad.degraded}`);
  check('生成成功但没山场时 stats.hasMountain 为 false', rBad.results[1].stats.hasMountain === false);

  const rWrongField = await runB({
    items: [{ mountainId: m1.id, topic: `${RUN}-wrong` }],   // 传错字段名：buildDeck 认 mountainName
    template: {},
  });
  for (const x of rWrongField.results) if (x.deckId) createdDecks.add(x.deckId);
  createdManifests.add(`_batch-${rWrongField.batchId}.json`);
  check('★ 传 mountainId 而非 mountainName → 明确提示字段用错',
    rWrongField.results[0].warnings.some((w) => w.code === 'WRONG_FIELD'),
    JSON.stringify(rWrongField.results[0]?.warnings));

  /* ---- 边界 ---- */
  let emptyErr = null;
  try { await runB({ items: [] }); } catch (e) { emptyErr = e; }
  check('空批次抛 EMPTY_BATCH', emptyErr?.code === 'EMPTY_BATCH', String(emptyErr?.code));

  let tooManyErr = null;
  try { await runB({ items: Array.from({ length: 51 }, () => ({ mountainName: m1.name })) }); } catch (e) { tooManyErr = e; }
  check('超过 50 项抛 BATCH_TOO_LARGE', tooManyErr?.code === 'BATCH_TOO_LARGE', String(tooManyErr?.code));

  check('签名对同样输入稳定', signatureOf(template) === signatureOf({ ...template }));

  /* ================================================================ *
   * B. A/B 对比
   * ================================================================ */
  section('[B] A/B 对比');

  const base = { mountainName: m1.name, durationMin: 45 };
  const v1 = buildV({
    base,
    variants: [
      { label: '知识科普', overrides: { purpose: 'knowledge', audience: 'veteran', style: 'storyteller' } },
      { label: '大促逼单', overrides: { purpose: 'promo', audience: 'regular', style: 'practical' } },
    ],
  });
  for (const v of v1.variants) createdDecks.add(v.deckId);

  check('生成两个变体', v1.variants.length === 2);
  check('★ 事实锁定校验通过（同一件商品）', v1.factLocked === true, JSON.stringify(v1.factSignature));
  check('识别出改变的呈现字段', v1.changedFields.length > 0, v1.changedFields.join(','));
  check('每个变体带可对比指标',
    v1.variants.every((v) => v.metrics.slides > 0 && v.metrics.scriptChars > 0 && v.metrics.densityPerMin > 0),
    JSON.stringify(v1.variants[0]?.metrics).slice(0, 160));
  check('每个变体都有开场钩子', v1.variants.every((v) => !!v.metrics.hook), JSON.stringify(v1.variants.map((v) => v.metrics.hook)));
  check('给出三组决策提示（安全/密度/互动）',
    !!v1.guidance.safest && !!v1.guidance.densest && !!v1.guidance.mostInteractive);
  check('决策提示明确说了"没有唯一最优"', /没有唯一最优/.test(v1.guidance.note || ''), v1.guidance.note);

  /* ---- 事实锁定：改价格必须被拒 ---- */
  const vBad = buildV({
    base,
    variants: [
      { label: '原价', overrides: { purpose: 'knowledge' } },
      { label: '偷偷改价', overrides: { purpose: 'promo', price: 9999 } },
    ],
  });
  for (const v of vBad.variants) createdDecks.add(v.deckId);
  check('★ 变体改了价格 → factLocked 为 false', vBad.factLocked === false);
  check('★ 并且给出 error 级 FACT_CHANGED 警告',
    vBad.warnings.some((w) => w.code === 'FACT_CHANGED' && w.level === 'error'),
    JSON.stringify(vBad.warnings.map((w) => w.code)));
  check('两个变体的事实指纹确实不同',
    new Set(vBad.variants.map((v) => v.factSignature)).size === 2);

  /* ---- 时长不同要提示不可直接比 ---- */
  const vDur = buildV({
    base,
    variants: [
      { label: '45 分钟', overrides: { purpose: 'knowledge', durationMin: 45 } },
      { label: '30 分钟', overrides: { purpose: 'knowledge', durationMin: 30 } },
    ],
  });
  for (const v of vDur.variants) createdDecks.add(v.deckId);
  check('时长不同 → 给出 DURATION_DIFFERS 提示',
    vDur.warnings.some((w) => w.code === 'DURATION_DIFFERS'), JSON.stringify(vDur.warnings.map((w) => w.code)));
  check('时长不同时仍然事实锁定（事实不变）', vDur.factLocked === true);

  /* ---- 边界 ---- */
  let oneErr = null;
  try { buildV({ base, variants: [{ label: 'only' }] }); } catch (e) { oneErr = e; }
  check('只给一个变体抛 NEED_TWO_VARIANTS', oneErr?.code === 'NEED_TWO_VARIANTS', String(oneErr?.code));

  let manyErr = null;
  try {
    buildV({ base, variants: Array.from({ length: 7 }, (_, i) => ({ label: `v${i}` })) });
  } catch (e) { manyErr = e; }
  check('超过 6 个变体抛 TOO_MANY_VARIANTS', manyErr?.code === 'TOO_MANY_VARIANTS', String(manyErr?.code));

  check('事实指纹基于事实字段，与风格无关',
    (() => {
      const a = buildV({ base, variants: [{ label: 'a', overrides: { style: 'warm' } }, { label: 'b', overrides: { style: 'professional' } }] });
      for (const v of a.variants) createdDecks.add(v.deckId);
      return a.factLocked === true;
    })());

  /* ================================================================ *
   * C. HTTP 路由
   * ================================================================ */
  section('[C] HTTP 路由');

  const hChoices = await call('GET', '/api/batch/choices');
  check('GET /api/batch/choices → 200', hChoices.status === 200, `实际 ${hChoices.status}`);
  check('返回山头清单', Array.isArray(hChoices.data.mountains) && hChoices.data.mountains.length > 0);

  const hBatch = await call('POST', '/api/batch', {
    mountains: [m1.name, m2.name],
    template: { purpose: 'knowledge', durationMin: 30 },
  });
  check('POST /api/batch → 200 且生成 2 份', hBatch.status === 200 && hBatch.data.ok === 2,
    `HTTP ${hBatch.status} ${JSON.stringify(hBatch.data).slice(0, 150)}`);
  for (const x of hBatch.data.results || []) if (x.deckId) createdDecks.add(x.deckId);
  if (hBatch.data.batchId) createdManifests.add(`_batch-${hBatch.data.batchId}.json`);

  const hEmpty = await call('POST', '/api/batch', { mountains: [] });
  check('空 mountains → 400', hEmpty.status === 400, `实际 ${hEmpty.status}`);

  const hVariants = await call('POST', '/api/variants', {
    base: { mountainName: m1.name, durationMin: 45 },
    variants: [
      { label: 'A', overrides: { purpose: 'knowledge', audience: 'veteran' } },
      { label: 'B', overrides: { purpose: 'promo', audience: 'regular' } },
    ],
  });
  check('POST /api/variants → 200 且事实锁定', hVariants.status === 200 && hVariants.data.factLocked === true,
    `HTTP ${hVariants.status} ${JSON.stringify(hVariants.data).slice(0, 150)}`);
  for (const v of hVariants.data.variants || []) if (v.deckId) createdDecks.add(v.deckId);

  const hOne = await call('POST', '/api/variants', { base: {}, variants: [{ label: 'only' }] });
  check('只给一个变体 → 400', hOne.status === 400, `实际 ${hOne.status}`);
} finally {
  /* ---------------------------------------------------------------- *
   * 清理：按 tag 扫，不动用户已有方案
   * ---------------------------------------------------------------- */
  console.log('\n=== 清理 ===');
  try {
    // 主要手段：按 tag 扫（即使某次生成没被记录也能删干净）
    const byTag = sweepTag();
    // 兜底：tag 功能失效时按记录的 id 删
    let byId = 0;
    for (const id of createdDecks) {
      const f = path.join(decksPath(), `${id}.json`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); byId++; }
    }
    for (const name of createdManifests) {
      const f = path.join(decksPath(), name);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`  按 tag 清理 ${byTag} 个，按 id 兜底清理 ${byId} 个`);
  } catch (err) {
    fail++;
    failures.push(`清理失败：${err.message}`);
    console.log(`  ⚠ 清理失败：${err.message}`);
  }
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`批量生成与 A/B 对比：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exitCode = fail ? 1 : 0;
