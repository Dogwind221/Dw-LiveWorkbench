/**
 * 配额与成本验证（第 10 周 Day 5）。
 *
 * 测四件事：
 *   1. **限额生效**：日调用/月 token 到上限后 → 429，且**在调用模型之前**拦住（不花钱）
 *   2. **计数准确**：按真实 usage 记账，不是按"调了一次"估
 *   3. **自动重置**：跨天调用次数归零、跨月 token 归零
 *   4. **租户隔离**：A 的用量不影响 B
 *
 * 用法：
 *   node scripts/quota-smoke.mjs
 *
 * 说明：429 的测试**不需要真跑模型** —— 因为配额检查在模型调用之前，
 * 把额度故意设为 0 就能触发。这也是这条设计的好处之一：超限时一分钱都不花。
 */
process.env.WORKBENCH_AUTH = 'required';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkbenchHandler } from '../server/lib/handler.mjs';
import { DATA_ROOT, OUTPUT_ROOT } from '../server/lib/paths.mjs';
import { ensureDefaultTenant, upsertTenant, removeTenant, getTenant } from '../server/lib/tenants.mjs';
import { createToken, revokeToken } from '../server/lib/auth.mjs';
import { runAsTenant } from '../server/lib/tenant.mjs';
import {
  checkQuota,
  consume,
  usage,
  limits,
  estimateCost,
  quotaStatus,
  _resetUsageForTest,
  DEFAULT_PRICE,
} from '../server/lib/quota.mjs';

const TA = 'tenant_a';
const TB = 'tenant_b';
const PORT = 8805;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];
let server = null;
const createdTokens = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);
const asA = (fn) => runAsTenant({ tenantId: TA, userId: 'u_a', role: 'editor' }, fn);
const asB = (fn) => runAsTenant({ tenantId: TB, userId: 'u_b', role: 'editor' }, fn);

async function call(method, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json', connection: 'close' };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

const usageFile = (id) => path.join(DATA_ROOT, 'tenants', id, 'quota-usage.json');

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */
console.log('=== 配额与成本验证（Day 5）===');
ensureDefaultTenant();

// 快照 default 的额度，最后还原
const defaultQuotaBefore = getTenant('default')?.quota;

upsertTenant({ id: TA, name: '测试租户 A', quota: { dailyCalls: 3, monthlyTokens: 10000 } });
upsertTenant({ id: TB, name: '测试租户 B', quota: { dailyCalls: 100, monthlyTokens: 100000 } });

const tokA = createToken({ tenantId: TA, userId: 'a1', role: 'approver', label: 'quota-smoke' });
const tokB = createToken({ tenantId: TB, userId: 'b1', role: 'approver', label: 'quota-smoke' });
createdTokens.push(tokA.record.id, tokB.record.id);

server = http.createServer(createWorkbenchHandler());
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`服务已启动：${BASE}`);

try {
  /* ================================================================ *
   * A. 计数与限额（模块级，确定性）
   * ================================================================ */
  section('[A] 计数与限额');

  await asA(_resetUsageForTest);
  const lim = await asA(limits);
  check('限额来自租户注册表', lim.dailyCalls === 3 && lim.monthlyTokens === 10000, JSON.stringify(lim));

  const q0 = await asA(checkQuota);
  check('初始状态可调用', q0.ok === true);
  check('剩余次数 = 限额', q0.day.remaining === 3, JSON.stringify(q0.day));

  await asA(() => consume({ calls: 1, tokensIn: 100, tokensOut: 50 }));
  const u1 = await asA(usage);
  check('消费后调用数 +1', u1.calls === 1, JSON.stringify(u1));
  check('消费后 token 分开记（输入/输出）', u1.tokensIn === 100 && u1.tokensOut === 50, JSON.stringify(u1));

  await asA(() => consume({ calls: 2 }));
  const qFull = await asA(checkQuota);
  check('达到日限额后 → 拒绝', qFull.ok === false && qFull.error === 'DAILY_CALLS_EXCEEDED', JSON.stringify(qFull));
  check('拒绝时说明了重置时间', /明天|重置/.test(qFull.message || ''), qFull.message);

  /* ================================================================ *
   * B. 月 token 上限
   * ================================================================ */
  section('[B] 月 token 上限');

  await asA(_resetUsageForTest);
  await asA(() => consume({ calls: 1, tokensIn: 6000, tokensOut: 5000 })); // 11000 > 10000
  const qToken = await asA(checkQuota);
  check('月 token 超限 → 拒绝', qToken.ok === false && qToken.error === 'MONTHLY_TOKENS_EXCEEDED', JSON.stringify(qToken));
  check('拒绝时说明了已用/总量', /11000|10000/.test(qToken.message || ''), qToken.message);

  /* ================================================================ *
   * C. 自动重置
   * ================================================================ */
  section('[C] 自动重置（跨天 / 跨月）');

  await asA(_resetUsageForTest);
  // 手写一个"昨天的用量"，读的时候应自动把 calls 归零，但 token 保留（还在同月）
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(DATA_ROOT, 'tenants', TA), { recursive: true });
  fs.writeFileSync(usageFile(TA), JSON.stringify({
    day: yesterday, calls: 999, month: new Date().toISOString().slice(0, 7), tokensIn: 100, tokensOut: 50,
  }), 'utf8');
  const afterDay = await asA(usage);
  check('★ 跨天：调用次数自动归零', afterDay.calls === 0, JSON.stringify(afterDay));
  check('跨天：同月 token 保留', afterDay.tokensIn === 100 && afterDay.tokensOut === 50, JSON.stringify(afterDay));

  // 手写一个"上个月的用量"
  fs.writeFileSync(usageFile(TA), JSON.stringify({
    day: new Date().toISOString().slice(0, 10), calls: 5, month: '2020-01', tokensIn: 999999, tokensOut: 1,
  }), 'utf8');
  const afterMonth = await asA(usage);
  check('★ 跨月：token 自动归零', afterMonth.tokensIn === 0 && afterMonth.tokensOut === 0, JSON.stringify(afterMonth));
  check('跨月：同月内的调用次数保留', afterMonth.calls === 5, JSON.stringify(afterMonth));

  /* ================================================================ *
   * D. 租户隔离
   * ================================================================ */
  section('[D] 用量按租户隔离');

  await asA(_resetUsageForTest);
  await asB(_resetUsageForTest);
  await asA(() => consume({ calls: 2, tokensIn: 1000, tokensOut: 500 }));

  const uA = await asA(usage);
  const uB = await asB(usage);
  check('A 的用量记在 A', uA.calls === 2, JSON.stringify(uA));
  check('★ B 的用量不受 A 影响', uB.calls === 0 && uB.tokensIn === 0, JSON.stringify(uB));
  check('用量文件按租户分文件',
    fs.existsSync(usageFile(TA)) && !fs.existsSync(usageFile(TB)));

  /* ================================================================ *
   * E. 成本估算
   * ================================================================ */
  section('[E] 成本估算');

  const cost = estimateCost({ tokensIn: 1_000_000, tokensOut: 500_000 }, { inPerMTok: 1, outPerMTok: 2 });
  check('成本 = 输入×单价 + 输出×单价', Math.abs(cost.total - 2) < 1e-9, `实际 ${cost.total}`);
  check('输入/输出成本分开算', Math.abs(cost.costIn - 1) < 1e-9 && Math.abs(cost.costOut - 1) < 1e-9,
    JSON.stringify(cost));
  check('单价可配置', DEFAULT_PRICE.inPerMTok >= 0 && DEFAULT_PRICE.outPerMTok >= 0, JSON.stringify(DEFAULT_PRICE));

  const status = await asA(quotaStatus);
  check('quotaStatus 含日/月/成本三段', !!status.day && !!status.month && !!status.cost, JSON.stringify(status).slice(0, 200));
  check('成本里标注了"输出单价是假设值"', /假设/.test(status.cost?.priceNote || ''), status.cost?.priceNote);

  /* ================================================================ *
   * F. HTTP：429 在调用模型之前
   * ================================================================ */
  section('[F] HTTP 429（超限时不花钱）');

  // 把 A 的额度设成 0，这样第一次调用就该被拦
  upsertTenant({ id: TA, name: '测试租户 A', quota: { dailyCalls: 0, monthlyTokens: 0 } });
  await asA(_resetUsageForTest);

  const t0 = Date.now();
  const askBlocked = await call('POST', '/api/kb/ask', { token: tokA.raw, body: { question: '倚邦的山场特征' } });
  const ms = Date.now() - t0;
  check('超配额调 /api/kb/ask → 429', askBlocked.status === 429, `实际 ${askBlocked.status} ${JSON.stringify(askBlocked.data)}`);
  check('429 返回明确的错误码', askBlocked.data.error === 'DAILY_CALLS_EXCEEDED', JSON.stringify(askBlocked.data));
  check('★ 429 发生在调用模型之前（响应极快，<2s）', ms < 2000, `实际 ${ms}ms`);

  const runBlocked = await call('POST', '/api/agent/run', { token: tokA.raw, body: { task: '查一下倚邦' } });
  check('超配额调 /api/agent/run → 429', runBlocked.status === 429, `实际 ${runBlocked.status}`);
  check('429 的 /run 没有产生 agent 轨迹', !runBlocked.data.steps, JSON.stringify(runBlocked.data).slice(0, 150));

  // B 不受影响
  const askB = await call('POST', '/api/kb/ask', { token: tokB.raw, body: { question: '倚邦的山场特征' } });
  check('★ A 超限不影响 B', askB.status !== 429, `B 实际 ${askB.status}`);

  // 恢复 A 的额度后应可继续
  upsertTenant({ id: TA, name: '测试租户 A', quota: { dailyCalls: 3, monthlyTokens: 10000 } });
  await asA(_resetUsageForTest);

  /* ================================================================ *
   * G. HTTP：配额状态接口
   * ================================================================ */
  section('[G] GET /api/quota');

  const qs = await call('GET', '/api/quota', { token: tokA.raw });
  check('GET /api/quota → 200', qs.status === 200, `实际 ${qs.status}`);
  check('返回当前租户 id', qs.data.tenantId === TA, JSON.stringify(qs.data).slice(0, 120));
  check('含调用次数与 token 用量', !!qs.data.calls && !!qs.data.tokens, JSON.stringify(qs.data).slice(0, 200));
  check('含成本估算', typeof qs.data.cost?.total === 'number', JSON.stringify(qs.data.cost));
} finally {
  /* ---------------------------------------------------------------- *
   * 清理
   * ---------------------------------------------------------------- */
  console.log('\n=== 清理 ===');
  try {
    for (const id of createdTokens) revokeToken({ id });
    removeTenant(TA);
    removeTenant(TB);
    for (const id of [TA, TB]) {
      fs.rmSync(path.join(DATA_ROOT, 'tenants', id), { recursive: true, force: true });
      fs.rmSync(path.join(OUTPUT_ROOT, 'tenants', id), { recursive: true, force: true });
    }
    if (defaultQuotaBefore) upsertTenant({ id: 'default', name: '默认租户（迁移保留）', quota: defaultQuotaBefore });
    console.log('  已撤销测试 token、移除 tenant_a / tenant_b、还原 default 额度');
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
console.log(`配额与成本验证：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exitCode = fail ? 1 : 0;
