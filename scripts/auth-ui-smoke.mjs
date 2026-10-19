/**
 * 登录界面 + 会话 cookie 验证（第 11 周）。
 *
 * 测的是"人能不能真的用起来"这条链路：
 *   未登录开页面 → 跳登录页 → 输账号密码 → 拿到会话 cookie → 页面正常用 → 登出失效
 *
 * 用法：
 *   node scripts/auth-ui-smoke.mjs
 *
 * 会临时创建一个测试用户，finally 里把 users.json 还原成跑之前的样子。
 */
process.env.WORKBENCH_AUTH = 'required';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkbenchHandler } from '../server/lib/handler.mjs';
import { DATA_ROOT, usersFile } from '../server/lib/paths.mjs';
import { ensureDefaultTenant } from '../server/lib/tenants.mjs';
import { createUser, getUserByUsername, removeUser, setUserStatus } from '../server/lib/users.mjs';
import { createToken, revokeToken, listTokens } from '../server/lib/auth.mjs';
import { _resetSessionsForTest } from '../server/lib/session.mjs';

const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'smoke_ui_user';
const PASS = 'SmokePass123';

let pass = 0;
let fail = 0;
const failures = [];
let server = null;
let tokenId = null;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

/** 发请求；cookie 可传，返回 {status, data, headers, setCookie}。 */
async function call(method, p, { body, cookie, token, headers = {}, redirect = 'manual' } = {}) {
  const h = { 'content-type': 'application/json', connection: 'close', ...headers };
  if (cookie) h.cookie = cookie;
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 120) }; }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data, headers: res.headers, setCookie, text };
}

/** 从 Set-Cookie 里取出可回传的 Cookie 头。 */
function cookieOf(setCookieList) {
  const first = (setCookieList || [])[0];
  if (!first) return '';
  return first.split(';')[0];
}

/* ------------------------------------------------------------------ *
 * 准备
 * ------------------------------------------------------------------ */
console.log('=== 登录界面 + 会话验证 ===');
ensureDefaultTenant();

// 快照 users.json，跑完原样还原（测试绝不能留下痕迹）
const snapshot = fs.existsSync(usersFile()) ? fs.readFileSync(usersFile(), 'utf8') : null;

// 清理可能残留的测试用户
const leftover = getUserByUsername(USER);
if (leftover) removeUser(leftover.id);
_resetSessionsForTest();
createUser({ username: USER, password: PASS, tenantId: 'default', role: 'editor' });

server = http.createServer(createWorkbenchHandler());
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`服务已启动：${BASE}`);

try {
  /* ---------------------------------------------------------------- *
   * A. 未登录时的行为
   * ---------------------------------------------------------------- */
  section('[A] 未登录');

  const home = await call('GET', '/');
  check('打开首页 → 302 跳登录页', home.status === 302, `实际 ${home.status}`);
  check('跳转目标正确', String(home.headers.get('location') || '').endsWith('/login'), home.headers.get('location'));

  const loginPage = await call('GET', '/login');
  check('登录页可访问（公开路径）→ 200', loginPage.status === 200, `实际 ${loginPage.status}`);
  check('登录页是真 HTML', /<html/i.test(loginPage.text) && /登录/.test(loginPage.text));

  const apiNoAuth = await call('GET', '/api/kb');
  check('未登录调 API → 401（不跳转，避免 fetch 拿到 302）', apiNoAuth.status === 401, `实际 ${apiNoAuth.status}`);

  const meNoAuth = await call('GET', '/api/auth/me');
  check('/api/auth/me 未登录返回 authenticated:false', meNoAuth.data.authenticated === false, JSON.stringify(meNoAuth.data));

  /* ---------------------------------------------------------------- *
   * B. 登录
   * ---------------------------------------------------------------- */
  section('[B] 登录');

  const badPw = await call('POST', '/api/auth/login', { body: { username: USER, password: 'wrong-password' } });
  check('密码错误 → 401', badPw.status === 401, `实际 ${badPw.status}`);
  check('错误提示不泄露"用户是否存在"', /用户名或密码/.test(badPw.data.message || ''), badPw.data.message);
  check('密码错误不发 cookie', cookieOf(badPw.setCookie) === '');

  const noUser = await call('POST', '/api/auth/login', { body: { username: 'nobody_here', password: 'whatever' } });
  check('用户不存在与密码错误返回同一句话（不泄露账号存在性）',
    noUser.status === 401 && noUser.data.message === badPw.data.message,
    `${noUser.data.message} vs ${badPw.data.message}`);

  const emptyInput = await call('POST', '/api/auth/login', { body: { username: '', password: '' } });
  check('空输入 → 400', emptyInput.status === 400, `实际 ${emptyInput.status}`);

  const login = await call('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  check('正确账号密码 → 200', login.status === 200, `实际 ${login.status} ${JSON.stringify(login.data)}`);
  check('返回用户信息', login.data.user?.username === USER, JSON.stringify(login.data.user));
  const cookie = cookieOf(login.setCookie);
  check('下发会话 cookie', !!cookie && cookie.startsWith('wb_sid='), cookie);
  const rawCookie = (login.setCookie || [])[0] || '';
  check('★ cookie 是 HttpOnly（JS 读不到）', /HttpOnly/i.test(rawCookie), rawCookie);
  check('★ cookie 是 SameSite=Lax（防 CSRF）', /SameSite=Lax/i.test(rawCookie), rawCookie);
  check('cookie 只放随机 sid，不含用户名/角色', !rawCookie.includes(USER) && !rawCookie.includes('editor'), rawCookie);

  /* ---------------------------------------------------------------- *
   * C. 带会话使用
   * ---------------------------------------------------------------- */
  section('[C] 带会话使用（页面里的 fetch 自动带 cookie）');

  const me = await call('GET', '/api/auth/me', { cookie });
  check('已登录 /api/auth/me → authenticated:true', me.data.authenticated === true, JSON.stringify(me.data));
  check('身份里带租户与角色', me.data.tenantId === 'default' && me.data.role === 'editor', JSON.stringify(me.data));

  const kb = await call('GET', '/api/kb/stats', { cookie });
  check('带 cookie 调业务 API → 200', kb.status === 200, `实际 ${kb.status}`);
  check('返回的是知识库数据', typeof kb.data.mountains === 'number', JSON.stringify(kb.data));

  const homeLogged = await call('GET', '/', { cookie });
  check('已登录打开首页 → 200（不再跳转）', homeLogged.status === 200, `实际 ${homeLogged.status}`);

  /* ---------------------------------------------------------------- *
   * D. 登出
   * ---------------------------------------------------------------- */
  section('[D] 登出');

  const logout = await call('POST', '/api/auth/logout', { cookie });
  check('登出 → 200', logout.status === 200, `实际 ${logout.status}`);
  check('登出清除 cookie（Max-Age=0）', /Max-Age=0/i.test((logout.setCookie || [])[0] || ''), (logout.setCookie || [])[0]);

  const afterLogout = await call('GET', '/api/kb/stats', { cookie });
  check('★ 登出后旧 cookie 立刻失效（服务端已删会话）', afterLogout.status === 401, `实际 ${afterLogout.status}`);

  const meAfter = await call('GET', '/api/auth/me', { cookie });
  check('登出后 /api/auth/me 为未登录', meAfter.data.authenticated === false);

  /* ---------------------------------------------------------------- *
   * E. 停用账号 → 会话立刻失效
   * ---------------------------------------------------------------- */
  section('[E] 停用账号');

  const login2 = await call('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  const cookie2 = cookieOf(login2.setCookie);
  check('重新登录成功', login2.status === 200);

  const u = getUserByUsername(USER);
  setUserStatus(u.id, 'disabled');
  const disabledUse = await call('GET', '/api/kb/stats', { cookie: cookie2 });
  check('★ 停用账号后旧会话立刻失效 → 401', disabledUse.status === 401, `实际 ${disabledUse.status}`);

  const disabledLogin = await call('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  check('停用账号不能登录 → 403', disabledLogin.status === 403, `实际 ${disabledLogin.status}`);
  setUserStatus(u.id, 'active');

  /* ---------------------------------------------------------------- *
   * F. token 入口仍然可用（程序调用）
   * ---------------------------------------------------------------- */
  section('[F] Bearer token 仍然可用（给脚本/集成）');

  // 开跑先清掉上次可能残留的测试 token（进程被强杀时 finally 跑不完）
{
  let swept = 0;
  for (const t of listTokens()) if (t.label === 'auth-ui-smoke') { revokeToken({ id: t.id }); swept++; }
  if (swept) console.log(`  （清扫了上次遗留的 ${swept} 个测试 token）`);
}

const tok = createToken({ tenantId: 'default', userId: USER, role: 'editor', label: 'auth-ui-smoke' });
  tokenId = tok.record.id;
  const byToken = await call('GET', '/api/kb/stats', { token: tok.raw });
  check('Bearer token 调 API → 200（人和程序两条入口并存）', byToken.status === 200, `实际 ${byToken.status}`);

  const meByToken = await call('GET', '/api/auth/me', { token: tok.raw });
  check('/api/auth/me 也认 token', meByToken.data.authenticated === true && meByToken.data.mode === 'token',
    JSON.stringify(meByToken.data));

  /* ---------------------------------------------------------------- *
   * G. 改密码
   * ---------------------------------------------------------------- */
  section('[G] 改密码');

  const login3 = await call('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  const cookie3 = cookieOf(login3.setCookie);
  const badOld = await call('POST', '/api/auth/password', { cookie: cookie3, body: { oldPassword: 'wrong', newPassword: 'NewPass456' } });
  check('原密码错 → 401（防会话被劫持后直接改密码）', badOld.status === 401, `实际 ${badOld.status}`);

  const okChange = await call('POST', '/api/auth/password', { cookie: cookie3, body: { oldPassword: PASS, newPassword: 'NewPass456' } });
  check('改密码成功', okChange.status === 200 && okChange.data.ok === true, JSON.stringify(okChange.data));

  const oldPwLogin = await call('POST', '/api/auth/login', { body: { username: USER, password: PASS } });
  check('旧密码不能再登录 → 401', oldPwLogin.status === 401, `实际 ${oldPwLogin.status}`);
  const newPwLogin = await call('POST', '/api/auth/login', { body: { username: USER, password: 'NewPass456' } });
  check('新密码可以登录 → 200', newPwLogin.status === 200, `实际 ${newPwLogin.status}`);
} finally {
  console.log('\n=== 清理 ===');
  try {
    if (tokenId) revokeToken({ id: tokenId });
    _resetSessionsForTest();
    const lu = getUserByUsername(USER);
    if (lu) removeUser(lu.id);
    // 还原 users.json（如果跑之前不存在，就删掉）
    if (snapshot === null) {
      try { fs.unlinkSync(usersFile()); } catch { /* 不存在 */ }
    } else {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.writeFileSync(usersFile(), snapshot, 'utf8');
    }
    console.log('  已删除测试用户、撤销 token、清空会话、还原 users.json');
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
console.log(`登录与会话验证：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exitCode = fail ? 1 : 0;
