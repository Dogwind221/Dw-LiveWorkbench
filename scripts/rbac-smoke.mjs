/**
 * 角色权限 + 审计隔离验证（第 10 周 Day 4）。
 *
 * 这一份测三件事：
 *   1. **角色分工**：viewer 不能写、editor 能提不能批、只有 approver 能批准
 *   2. **pending 跨租户隔离**：A 的 actionId 拿到 B 去确认必须查不到（不能靠猜 id 越权）
 *   3. **审计可追责**：每条记录都带 tenantId / actor / role，且不串租户
 *
 * 用法：
 *   node scripts/rbac-smoke.mjs          确定性的部分（不需要模型）
 *   node scripts/rbac-smoke.mjs --llm    额外跑一次真实模型的端到端（editor 提议）
 *
 * 测试会创建 tenant_a / tenant_b 与测试 token，finally 里全部清理。
 */
process.env.WORKBENCH_AUTH = 'required';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkbenchHandler } from '../server/lib/handler.mjs';
import { DATA_ROOT, OUTPUT_ROOT } from '../server/lib/paths.mjs';
import { ensureDefaultTenant, upsertTenant, removeTenant } from '../server/lib/tenants.mjs';
import { createToken, revokeToken, listTokens } from '../server/lib/auth.mjs';
import { runAsTenant } from '../server/lib/tenant.mjs';
import {
  decide,
  registerPending,
  listPending,
  confirmPending,
  listAudit,
  WRITE_APPLIERS,
} from '../server/lib/agent/permissions.mjs';
import { getTool } from '../server/lib/agent/tools.mjs';

const TA = 'tenant_a';
const TB = 'tenant_b';
const PORT = 8800;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_LLM = process.argv.includes('--llm');

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
const rel = (p) => p.replace(process.cwd(), '.').replace(/\\/g, '/');

async function call(method, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json', connection: 'close' };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

const asA = (role, fn) => runAsTenant({ tenantId: TA, userId: `u_${role}`, role }, fn);
const asB = (role, fn) => runAsTenant({ tenantId: TB, userId: `u_${role}_b`, role }, fn);

/** 直接登记一个待确认动作（不走模型，保证测试确定性）。 */
function seedPending(tenantRunner, args, actionId) {
  return tenantRunner('editor', () => {
    registerPending({
      actionId,
      tool: 'save_faq',
      args,
      impact: { action: '新增问答', target: 'data/faq.json', before: '0 条', after: '1 条' },
      applyArgs: args,
    });
  });
}

function cleanupTenant(tenantId) {
  fs.rmSync(path.join(DATA_ROOT, 'tenants', tenantId), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_ROOT, 'tenants', tenantId), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */
console.log('=== 角色权限与审计隔离（Day 4）===');
ensureDefaultTenant();
upsertTenant({ id: TA, name: '测试租户 A' });
upsertTenant({ id: TB, name: '测试租户 B' });

// 快照 default 的 settings，万一误写就还原（Day 2 踩过的坑）
const DEFAULT_SETTINGS = path.join(DATA_ROOT, 'tenants', 'default', 'settings.json');
const defaultSnapshot = fs.existsSync(DEFAULT_SETTINGS) ? fs.readFileSync(DEFAULT_SETTINGS, 'utf8') : null;

// 开跑先清掉上次可能残留的测试 token（进程被强杀时 finally 跑不完）
{
  let swept = 0;
  for (const t of listTokens()) if (t.label === 'rbac-smoke') { revokeToken({ id: t.id }); swept++; }
  if (swept) console.log(`  （清扫了上次遗留的 ${swept} 个测试 token）`);
}

const tokViewer = createToken({ tenantId: TA, userId: 'viewer1', role: 'viewer', label: 'rbac-smoke' });
const tokEditor = createToken({ tenantId: TA, userId: 'editor1', role: 'editor', label: 'rbac-smoke' });
const tokApprover = createToken({ tenantId: TA, userId: 'boss1', role: 'approver', label: 'rbac-smoke' });
const tokApproverB = createToken({ tenantId: TB, userId: 'boss_b', role: 'approver', label: 'rbac-smoke' });
createdTokens.push(tokViewer.record.id, tokEditor.record.id, tokApprover.record.id, tokApproverB.record.id);

server = http.createServer(createWorkbenchHandler());
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`服务已启动：${BASE}`);

try {
  /* ================================================================ *
   * A. 角色分工（模块级，确定性）
   * ================================================================ */
  section('[A] 角色分工（decide）');

  const saveFaq = getTool('save_faq');
  const readTool = getTool('search_knowledge');
  const args = { question: '角色测试问题', answer: '角色测试回答' };

  check('viewer 发起写操作 → deny（连提议都不行）',
    decide({ tool: saveFaq, args, policy: { role: 'viewer' } }).decision === 'deny');
  check('viewer 的 deny 说明了原因',
    /viewer/.test(decide({ tool: saveFaq, args, policy: { role: 'viewer' } }).reason || ''));
  check('editor 发起写操作 → confirm（能提，不能批）',
    decide({ tool: saveFaq, args, policy: { role: 'editor' } }).decision === 'confirm');
  check('approver 发起写操作 → confirm（也需要确认，只是能批）',
    decide({ tool: saveFaq, args, policy: { role: 'approver' } }).decision === 'confirm');
  check('任何角色都能读', ['viewer', 'editor', 'approver'].every(
    (r) => decide({ tool: readTool, args: {}, policy: { role: r } }).decision === 'execute'));
  check('无角色（本地模式）不受限', decide({ tool: saveFaq, args, policy: {} }).decision === 'confirm');

  /* ================================================================ *
   * B. confirmPending 的角色与租户隔离（模块级）
   * ================================================================ */
  section('[B] confirmPending 的角色 + 租户隔离');

  const actionA = 'aaaa1111aaaa1111';
  await seedPending(asA, { ...args, question: 'A 待确认问题' }, actionA);

  const viewerConfirm = await asA('viewer', () => confirmPending(actionA, WRITE_APPLIERS));
  check('viewer 调 confirm → FORBIDDEN_ROLE',
    viewerConfirm.ok === false && viewerConfirm.code === 'FORBIDDEN_ROLE', JSON.stringify(viewerConfirm));

  const editorConfirm = await asA('editor', () => confirmPending(actionA, WRITE_APPLIERS));
  check('editor 调 confirm → FORBIDDEN_ROLE（能提不能批）',
    editorConfirm.ok === false && editorConfirm.code === 'FORBIDDEN_ROLE', JSON.stringify(editorConfirm));

  const crossTenant = await asB('approver', () => confirmPending(actionA, WRITE_APPLIERS));
  check('★ B 的 approver 拿 A 的 actionId → NO_PENDING（跨租户拿不到）',
    crossTenant.ok === false && crossTenant.code === 'NO_PENDING', JSON.stringify(crossTenant));

  check('A 的 pending 列表里能看到自己的动作',
    await asA('editor', () => listPending().some((p) => p.actionId === actionA)));
  check('★ B 的 pending 列表里看不到 A 的动作',
    await asB('editor', () => !listPending().some((p) => p.actionId === actionA)));

  const approverConfirm = await asA('approver', () => confirmPending(actionA, WRITE_APPLIERS));
  check('A 的 approver 确认成功', approverConfirm.ok === true, JSON.stringify(approverConfirm).slice(0, 160));
  check('确认后 A 的 pending 清空',
    await asA('editor', () => !listPending().some((p) => p.actionId === actionA)));

  const reapplied = await asA('approver', () => confirmPending(actionA, WRITE_APPLIERS));
  check('重复确认被拒绝（动作已消费）', reapplied.ok === false && reapplied.code === 'NO_PENDING');

  /* ================================================================ *
   * C. HTTP 层角色与跨租户
   * ================================================================ */
  section('[C] HTTP 层角色与跨租户');

  const actionHttp = 'bbbb2222bbbb2222';
  await seedPending(asA, { question: 'HTTP 待确认问题', answer: 'HTTP 待确认回答' }, actionHttp);

  const viewerHttp = await call('POST', '/api/agent/confirm', { token: tokViewer.raw, body: { actionId: actionHttp } });
  check('HTTP: viewer 确认 → 403', viewerHttp.status === 403, `实际 ${viewerHttp.status} ${JSON.stringify(viewerHttp.data)}`);

  const editorHttp = await call('POST', '/api/agent/confirm', { token: tokEditor.raw, body: { actionId: actionHttp } });
  check('HTTP: editor 确认 → 403', editorHttp.status === 403, `实际 ${editorHttp.status}`);

  const crossHttp = await call('POST', '/api/agent/confirm', { token: tokApproverB.raw, body: { actionId: actionHttp } });
  check('★ HTTP: B 的 approver 确认 A 的动作 → 404', crossHttp.status === 404, `实际 ${crossHttp.status} ${JSON.stringify(crossHttp.data)}`);

  const pendingA = await call('GET', '/api/agent/pending', { token: tokEditor.raw });
  const pendingB = await call('GET', '/api/agent/pending', { token: tokApproverB.raw });
  check('HTTP: A 的 pending 列表含自己的动作',
    (pendingA.data.pending || []).some((p) => p.actionId === actionHttp));
  check('★ HTTP: B 的 pending 列表看不到 A 的动作',
    !(pendingB.data.pending || []).some((p) => p.actionId === actionHttp));

  const approverHttp = await call('POST', '/api/agent/confirm', { token: tokApprover.raw, body: { actionId: actionHttp } });
  check('HTTP: A 的 approver 确认 → 200', approverHttp.status === 200, `实际 ${approverHttp.status} ${JSON.stringify(approverHttp.data)}`);
  check('数据真的写进了 A 的租户目录',
    fs.existsSync(path.join(DATA_ROOT, 'tenants', TA, 'faq.json')));
  check('没有写到 default 或 B',
    !fs.existsSync(path.join(DATA_ROOT, 'tenants', TB, 'faq.json')));

  // 关键：editor 在 /run 里塞 approvals 不能绕过确认
  const editorBypass = await call('POST', '/api/agent/run', {
    token: tokEditor.raw,
    body: { task: '把这条存进问答库：问「绕过测试」，答「不该被写入」', approvals: ['fake-action-id'] },
  });
  check('editor 在 /run 里塞 approvals 不会被当成批准（仍需要确认）',
    editorBypass.status === 200 && (editorBypass.data.writeExecuted !== true),
    JSON.stringify(editorBypass.data).slice(0, 200));

  /* ================================================================ *
   * D. 审计可追责
   * ================================================================ */
  section('[D] 审计可追责');

  const auditA = await asA('approver', () => listAudit(200));
  check('审计记录非空', auditA.length > 0, `实际 ${auditA.length} 条`);
  check('每条审计都有 tenantId', auditA.every((r) => r.tenantId === TA), JSON.stringify(auditA[0] || {}));
  check('每条审计都有 actor', auditA.every((r) => !!r.actor));
  check('每条审计都有 role', auditA.every((r) => !!r.role));
  check('审计能追到"谁批的"（有 approver 记录）',
    auditA.some((r) => r.kind === 'execute' && r.role === 'approver' && r.actor === 'u_approver'),
    JSON.stringify(auditA.slice(0, 2)));

  const auditB = await asB('approver', () => listAudit(200));
  check('★ B 的审计里看不到 A 的记录',
    !auditB.some((r) => r.tenantId === TA), JSON.stringify(auditB.slice(0, 2)));
  check('审计按租户分文件',
    fs.existsSync(path.join(DATA_ROOT, 'tenants', TA, 'agent-audit.jsonl')));

  /* ================================================================ *
   * E. 端到端：真实模型（可选）
   * ================================================================ */
  if (RUN_LLM) {
    section('[E] 端到端：editor 用真实模型提议（--llm）');
    const r = await call('POST', '/api/agent/run', {
      token: tokEditor.raw,
      body: { task: '把这条问答存进问答库：问「真实模型提议测试」，答「这条应该生成待确认卡片」', maxSteps: 4 },
    });
    console.log(`      steps=${r.data.meta?.steps} toolCalls=${r.data.meta?.toolCalls} pending=${(r.data.pending || []).length}`);
    check('editor 能生成待确认动作（HTTP 200）', r.status === 200, `实际 ${r.status}`);
    check('editor 的提议确实进了 pending', (r.data.pending || []).length > 0);
    check('editor 没有被当成批准者（writeExecuted 为 false）', r.data.writeExecuted !== true);
  } else {
    section('[E] 端到端：真实模型 —— 跳过（加 --llm 才跑，会调模型花钱）');
  }
} finally {
  /* ---------------------------------------------------------------- *
   * 清理
   * ---------------------------------------------------------------- */
  console.log('\n=== 清理 ===');
  try {
    for (const id of createdTokens) revokeToken({ id });
    removeTenant(TA);
    removeTenant(TB);
    cleanupTenant(TA);
    cleanupTenant(TB);
    if (defaultSnapshot !== null) {
      fs.mkdirSync(path.dirname(DEFAULT_SETTINGS), { recursive: true });
      fs.writeFileSync(DEFAULT_SETTINGS, defaultSnapshot, 'utf8');
    }
    console.log('  已撤销测试 token、移除 tenant_a / tenant_b、还原 default settings');
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
console.log(`角色权限与审计隔离：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exitCode = fail ? 1 : 0;
