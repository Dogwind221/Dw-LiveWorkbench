/**
 * 身份认证与租户身份来源验证（Day 2）。
 *
 * 这一份只测一件事：**"这次请求属于哪个租户"只能由 token 决定**。
 *
 * 所以核心不是"有没有 401"，而是这几条攻击能不能得逞：
 *   - 带 A 的 token，但手动塞 X-Tenant-Id: tenant_b  → 必须仍按 A 处理
 *   - 带 A 的 token，body 里塞 tenantId: tenant_b     → 必须仍按 A 处理
 *   - 不带 token，只带 x-tenant-id                    → 必须 401
 *
 * 用法：
 *   node scripts/auth-smoke.mjs
 *
 * 注意：脚本会临时注册 tenant_a / tenant_b 并创建测试 token，
 * 结束时在 finally 里全部清理 —— 否则下次以"未开认证"启动会被安全护栏拦住
 * （护栏逻辑：>1 个启用租户 + 未开认证 = 拒绝启动）。
 */
process.env.WORKBENCH_AUTH = 'required';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkbenchHandler } from '../server/lib/handler.mjs';
import { DATA_ROOT, OUTPUT_ROOT } from '../server/lib/paths.mjs';
import {
  ensureDefaultTenant,
  upsertTenant,
  removeTenant,
  disableTenant,
} from '../server/lib/tenants.mjs';
import { createToken, revokeToken, listTokens, authMode, verifyToken } from '../server/lib/auth.mjs';
import { DEFAULT_TENANT } from '../server/lib/tenant.mjs';

const TA = 'tenant_a';
const TB = 'tenant_b';
const PORT = 8799;
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

async function call(method, p, { token, headers = {}, body } = {}) {
  // connection: close —— 不给 undici 留 keep-alive 句柄，
  // 否则进程退出时它们还在关闭中，Windows 上会触发 libuv 断言（退出码 0xC0000409）
  const h = { 'content-type': 'application/json', connection: 'close', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 120) }; }
  return { status: res.status, data };
}

/** 给租户写一个可识别的标记文件，用来判断"到底读到谁的租户"。 */
function writeTenantMarker(tenantId, marker) {
  const dir = path.join(DATA_ROOT, 'tenants', tenantId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ marker }), 'utf8');
}

function cleanupTenant(tenantId) {
  fs.rmSync(path.join(DATA_ROOT, 'tenants', tenantId), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_ROOT, 'tenants', tenantId), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */
console.log('=== 身份认证验证（Day 2）===');
console.log(`认证模式：${authMode()}`);

ensureDefaultTenant();
upsertTenant({ id: TA, name: '测试租户 A' });
upsertTenant({ id: TB, name: '测试租户 B' });

/**
 * **测试绝不能碰 default 租户的真实数据。**
 *
 * 第一版这里写了 `writeTenantMarker(DEFAULT_TENANT, 'DEFAULT')`，
 * 直接把真实的 settings.json（host / complianceWhitelist）覆盖成了 {marker:'DEFAULT'}，
 * 清理时又写成 {} —— 真实配置被测试吃掉了。
 *
 * 教训：测试要污染的是"自己创建的临时租户"，不是用户的数据。
 * 这里额外再做一层保险：跑之前快照 default 的 settings，finally 里无条件还原。
 */
const DEFAULT_SETTINGS = path.join(DATA_ROOT, 'tenants', DEFAULT_TENANT, 'settings.json');
const defaultSettingsSnapshot = fs.existsSync(DEFAULT_SETTINGS) ? fs.readFileSync(DEFAULT_SETTINGS, 'utf8') : null;

// 只给临时租户写标记
writeTenantMarker(TA, 'A');
writeTenantMarker(TB, 'B');

// 开跑先清掉上次可能残留的测试 token（进程被强杀时 finally 跑不完）
{
  let swept = 0;
  for (const t of listTokens()) {
    if (t.label === 'auth-smoke' || t.label === 'auth-smoke-revoked') { revokeToken({ id: t.id }); swept++; }
  }
  if (swept) console.log(`  （清扫了上次遗留的 ${swept} 个测试 token）`);
}

const tokA = createToken({ tenantId: TA, userId: 'alice', role: 'editor', label: 'auth-smoke' });
const tokB = createToken({ tenantId: TB, userId: 'bob', role: 'viewer', label: 'auth-smoke' });
const tokApprover = createToken({ tenantId: TA, userId: 'boss', role: 'approver', label: 'auth-smoke' });
const tokDead = createToken({ tenantId: TB, userId: 'bob', role: 'viewer', label: 'auth-smoke-revoked' });
createdTokens.push(tokA.record.id, tokB.record.id, tokApprover.record.id, tokDead.record.id);

server = http.createServer(createWorkbenchHandler());
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`服务已启动：${BASE}`);

try {
  /* ---------------------------------------------------------------- *
   * A. 未认证访问
   * ---------------------------------------------------------------- */
  section('[A] 未认证访问');

  const noToken = await call('GET', '/api/kb');
  check('无 token 访问 /api/kb → 401', noToken.status === 401, `实际 ${noToken.status}`);
  check('401 返回明确的错误码', noToken.data.error === 'UNAUTHORIZED', JSON.stringify(noToken.data));

  const badToken = await call('GET', '/api/kb', { token: 'wb_totally-invalid-token-1234567890' });
  check('坏 token → 401', badToken.status === 401, `实际 ${badToken.status}`);
  check('坏 token 返回 BAD_TOKEN', badToken.data.error === 'BAD_TOKEN', JSON.stringify(badToken.data));

  const health = await call('GET', '/api/health');
  check('公开路径 /api/health 无需 token → 200', health.status === 200, `实际 ${health.status}`);

  const home = await call('GET', '/');
  check('静态首页无需 token → 200', home.status === 200, `实际 ${home.status}`);

  const files = await call('GET', '/files/pptx/whatever.pptx');
  check('★ /files/* 需要 token（租户导出物含真实内容）', files.status === 401, `实际 ${files.status}`);

  /* ---------------------------------------------------------------- *
   * B. 身份来源（核心）
   * ---------------------------------------------------------------- */
  section('[B] 身份只能来自 token（★ 核心）');

  // B1：带 A 的 token，但用各种方式试图指定 B
  const forgedHeader = await call('GET', '/api/settings', {
    token: tokA.raw,
    headers: { 'x-tenant-id': TB, 'x-tenant': TB },
  });
  check('B1 带 A token + X-Tenant-Id: tenant_b → 读到的仍是 A',
    forgedHeader.data.marker === 'A', `实际 marker=${forgedHeader.data.marker}`);

  const forgedBody = await call('POST', '/api/settings', {
    token: tokA.raw,
    body: { tenantId: TB, marker: 'A' },
  });
  const afterBody = await call('GET', '/api/settings?tenantId=' + TB, { token: tokA.raw });
  check('B1 body/query 里塞 tenantId 不生效（仍读 A）',
    afterBody.data.marker === 'A', `实际 marker=${afterBody.data.marker}`);

  // B2：不带 token 只带 x-tenant-id
  const noTokenHeader = await call('GET', '/api/settings', { headers: { 'x-tenant-id': TB } });
  check('B2 只带 X-Tenant-Id 不带 token → 401（参数不能当身份）',
    noTokenHeader.status === 401, `实际 ${noTokenHeader.status}`);

  // B3：A 的 token 读不到 B 的数据
  const bMarker = await call('GET', '/api/settings', { token: tokB.raw });
  check('B3 B 的 token 读到 B 的数据', bMarker.data.marker === 'B', `实际 marker=${bMarker.data.marker}`);
  check('B3 A 的 token 读不到 B 的 marker', forgedHeader.data.marker !== 'B');

  /* ---------------------------------------------------------------- *
   * C. 三租户隔离（HTTP 层）
   * ---------------------------------------------------------------- */
  section('[C] HTTP 层租户隔离');

  const aRead = await call('GET', '/api/settings', { token: tokA.raw });
  const bRead = await call('GET', '/api/settings', { token: tokB.raw });
  check('A 读到 A', aRead.data.marker === 'A', `实际 ${aRead.data.marker}`);
  check('B 读到 B', bRead.data.marker === 'B', `实际 ${bRead.data.marker}`);
  check('A、B 读到的内容不同', aRead.data.marker !== bRead.data.marker);

  // 写入隔离：A 写自己的设置，B 不受影响
  await call('POST', '/api/settings', { token: tokA.raw, body: { marker: 'A2' } });
  const bAfter = await call('GET', '/api/settings', { token: tokB.raw });
  check('A 写入不影响 B', bAfter.data.marker === 'B', `实际 ${bAfter.data.marker}`);

  /* ---------------------------------------------------------------- *
   * D. token 生命周期
   * ---------------------------------------------------------------- */
  section('[D] token 生命周期');

  check('验证有效 token 能解析出租户与角色',
    (() => { const v = verifyToken(tokA.raw); return v?.tenantId === TA && v.role === 'editor'; })());

  check('明文 token 不在 tokens.json 里（只存哈希）',
    (() => {
      const raw = fs.readFileSync(path.join(DATA_ROOT, 'tokens.json'), 'utf8');
      return !raw.includes(tokA.raw) && raw.includes('"hash"');
    })());

  revokeToken({ id: tokDead.record.id });
  const afterRevoke = await call('GET', '/api/settings', { token: tokDead.raw });
  check('撤销后的 token → 401', afterRevoke.status === 401, `实际 ${afterRevoke.status}`);

  disableTenant(TB);
  const afterDisable = await call('GET', '/api/settings', { token: tokB.raw });
  check('★ 租户停用后其 token 立即失效 → 401', afterDisable.status === 401, `实际 ${afterDisable.status}`);
  upsertTenant({ id: TB, name: '测试租户 B' }); // 恢复
  const afterRestore = await call('GET', '/api/settings', { token: tokB.raw });
  check('租户恢复后 token 又能用', afterRestore.status === 200, `实际 ${afterRestore.status}`);

  /* ---------------------------------------------------------------- *
   * E. 角色信息传递
   * ---------------------------------------------------------------- */
  section('[E] 角色信息');

  const viewerRead = await call('GET', '/api/kb', { token: tokB.raw });
  check('viewer 角色可以读 → 200', viewerRead.status === 200, `实际 ${viewerRead.status}`);

  check('token 元数据里能查到角色',
    (() => { const t = listTokens().find((x) => x.id === tokApprover.record.id); return t?.role === 'approver'; })());

  check('token 列表不含明文',
    listTokens().every((t) => !('hash' in t) && !('raw' in t)));

  /* ---------------------------------------------------------------- *
   * F. 安全护栏
   * ---------------------------------------------------------------- */
  section('[F] 安全护栏（多租户 + 无认证 = 拒绝启动）');

  const { execFileSync } = await import('node:child_process');
  let refused = false;
  let stdout = '';
  try {
    // 子进程：不开认证启动，应该被护栏拦住（注册表里现在有 default + A + B 三个租户）
    stdout = execFileSync(process.execPath, ['server/index.mjs', '8801'], {
      cwd: process.cwd(),
      env: { ...process.env, WORKBENCH_AUTH: '' },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    });
  } catch (err) {
    refused = err.status === 1;
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  check('多租户 + 未开认证 → 拒绝启动', refused, `exit=${refused} 输出=${stdout.slice(0, 120)}`);
  check('拒绝启动时说明了原因和修复方式', /拒绝启动/.test(stdout) && /WORKBENCH_AUTH/.test(stdout), stdout.slice(0, 200));
} finally {
  /* ---------------------------------------------------------------- *
   * 清理（必须无条件执行）
   * ---------------------------------------------------------------- */
  console.log('\n=== 清理 ===');
  try {
    for (const id of createdTokens) revokeToken({ id });
    removeTenant(TA);
    removeTenant(TB);
    cleanupTenant(TA);
    cleanupTenant(TB);
    // 无条件还原 default 的 settings（保险：万一哪里误写了）
    if (defaultSettingsSnapshot !== null) {
      fs.mkdirSync(path.dirname(DEFAULT_SETTINGS), { recursive: true });
      fs.writeFileSync(DEFAULT_SETTINGS, defaultSettingsSnapshot, 'utf8');
    }
    console.log('  已撤销测试 token、移除 tenant_a / tenant_b 注册与目录、还原 default settings');
  } catch (err) {
    console.log(`  ⚠ 清理失败：${err.message}`);
    fail++;
    failures.push(`清理失败：${err.message}`);
  }
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`身份认证验证：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exitCode = fail ? 1 : 0;
