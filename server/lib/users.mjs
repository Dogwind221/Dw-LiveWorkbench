/**
 * 用户与密码（第 11 周：登录）。
 *
 * ## 为什么 token 之外还要有用户
 *
 * token 适合**程序调用**（CLI / CI / 插件），但人不该去复制一串 43 位的字符串。
 * 所以两条入口并存：
 *   - **token**：API key，给脚本和集成用（`Authorization: Bearer`）
 *   - **用户名 + 密码**：给人用，登录后发一个会话 cookie
 *
 * 这不是两套权限系统 —— 两者最终都归约成同一份身份 `{ tenantId, userId, role }`。
 *
 * ## 密码存储
 *
 * 用 Node 内置的 `crypto.scryptSync` 加盐哈希，**零依赖**。
 * 选 scrypt 而不是 sha256：sha256 太快，适合被暴力破解；scrypt 故意慢且吃内存。
 * 用 `timingSafeEqual` 比较，避免时序侧信道。
 *
 * ## 为什么密码不写成"用户表里存 bcrypt"
 *
 * bcrypt 是 npm 包。项目硬约束是零依赖，而 scrypt 是 Node 内置的、强度足够，
 * 所以没有引入依赖的必要。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_ROOT, usersFile } from './paths.mjs';
import { assertTenantId, DEFAULT_TENANT } from './tenant.mjs';
import { ROLES, isValidRole } from './auth.mjs';
import { destroyUserSessions } from './session.mjs';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;
const KEYLEN = 64;

function readStore() {
  try {
    const raw = fs.readFileSync(usersFile(), 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return { version: 1, users: [] };
    const j = JSON.parse(raw);
    return { version: j.version || 1, users: Array.isArray(j.users) ? j.users : [] };
  } catch {
    return { version: 1, users: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const tmp = `${usersFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, usersFile());
}

/** 对外形态：**绝不含 salt / hash**。 */
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    tenantId: u.tenantId,
    role: u.role,
    isAdmin: !!u.isAdmin,
    status: u.status || 'active',
    label: u.label || '',
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const calc = crypto.scryptSync(String(password), String(salt), KEYLEN);
    const expect = Buffer.from(String(hash), 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

export function isValidUsername(n) {
  return USERNAME_RE.test(String(n ?? ''));
}

/** 用户名不区分大小写查重（避免 Admin / admin 两个账号）。 */
const norm = (s) => String(s ?? '').trim().toLowerCase();

export function listUsers() {
  return readStore().users.map(publicUser);
}

export function getUserById(id) {
  const u = readStore().users.find((x) => x.id === id);
  return u ? publicUser(u) : null;
}

export function getUserByUsername(username) {
  const u = readStore().users.find((x) => norm(x.username) === norm(username));
  return u ? publicUser(u) : null;
}

/**
 * 创建用户。返回**明文密码只在传入 password 时用于哈希，永不返回**。
 *
 * @param {{username:string, password:string, tenantId?:string, role?:string, isAdmin?:boolean, label?:string}} input
 */
export function createUser({ username, password, tenantId = DEFAULT_TENANT, role = 'editor', isAdmin = false, label = '' } = {}) {
  const uname = String(username ?? '').trim();
  if (!isValidUsername(uname)) {
    const err = new Error('用户名不合法：2–32 位，只允许字母数字 . _ -');
    err.code = 'BAD_USERNAME';
    throw err;
  }
  if (String(password ?? '').length < 8) {
    const err = new Error('密码至少 8 位');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const tid = assertTenantId(tenantId);
  if (!isValidRole(role)) {
    const err = new Error(`非法角色：${role}（只允许 ${ROLES.join(' / ')}）`);
    err.code = 'BAD_ROLE';
    throw err;
  }

  const store = readStore();
  if (store.users.some((u) => norm(u.username) === norm(uname))) {
    const err = new Error(`用户名已存在：${uname}`);
    err.code = 'USERNAME_TAKEN';
    throw err;
  }

  const { salt, hash } = hashPassword(password);
  const rec = {
    id: `usr_${crypto.randomBytes(6).toString('hex')}`,
    username: uname,
    tenantId: tid,
    role,
    isAdmin: !!isAdmin,
    salt,
    hash,
    status: 'active',
    label: String(label || '').slice(0, 80),
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  store.users.push(rec);
  writeStore(store);
  return publicUser(rec);
}

/**
 * 校验用户名密码。
 *
 * @returns {{ok:true, user:object} | {ok:false, code:string, message:string}}
 */
export function authenticate(username, password) {
  const store = readStore();
  const rec = store.users.find((u) => norm(u.username) === norm(username));
  // 无论用户不存在还是密码错，都返回同一句话 —— 不泄露"这个用户名存在"。
  const FAIL = { ok: false, code: 'BAD_CREDENTIALS', message: '用户名或密码不正确' };
  if (!rec) {
    // 即使查不到用户也跑一次哈希，避免用响应时间探测用户名是否存在
    hashPassword(String(password ?? ''));
    return FAIL;
  }
  if (rec.status === 'disabled') {
    return { ok: false, code: 'USER_DISABLED', message: '该账号已停用' };
  }
  if (!verifyPassword(password, rec.salt, rec.hash)) return FAIL;

  rec.lastLoginAt = new Date().toISOString();
  writeStore(store);
  return { ok: true, user: publicUser(rec) };
}

/**
 * 停用/启用用户。
 *
 * 停用时**必须同时踢掉该用户所有会话** —— 否则"停用"只是拦住了下次登录，
 * 已经在浏览器里登录着的人还能继续用。这种"以为停用了其实没停"是最危险的假安全。
 *
 * 放在领域层而不是让调用方记得做：任何调用 setUserStatus 的地方都自动获得这个保证。
 */
export function setUserStatus(id, status) {
  const store = readStore();
  const rec = store.users.find((u) => u.id === id);
  if (!rec) {
    const err = new Error(`用户不存在：${id}`);
    err.code = 'NO_USER';
    throw err;
  }
  rec.status = status === 'disabled' ? 'disabled' : 'active';
  writeStore(store);
  if (rec.status === 'disabled') destroyUserSessions(id);
  return publicUser(rec);
}

export function removeUser(id) {
  const store = readStore();
  const before = store.users.length;
  store.users = store.users.filter((u) => u.id !== id);
  writeStore(store);
  if (before !== store.users.length) destroyUserSessions(id);
  return before - store.users.length;
}

/** 改密码。改完**踢掉所有会话**，强制用新密码重新登录。 */
export function setPassword(id, newPassword) {
  if (String(newPassword ?? '').length < 8) {
    const err = new Error('密码至少 8 位');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const store = readStore();
  const rec = store.users.find((u) => u.id === id);
  if (!rec) {
    const err = new Error(`用户不存在：${id}`);
    err.code = 'NO_USER';
    throw err;
  }
  const { salt, hash } = hashPassword(newPassword);
  rec.salt = salt;
  rec.hash = hash;
  writeStore(store);
  destroyUserSessions(id);
  return publicUser(rec);
}

/** 首次启动：没有任何用户时创建一个 admin，密码随机生成并**只返回一次**。 */
export function ensureBootstrapAdmin() {
  const store = readStore();
  if (store.users.length) return null;
  const password = crypto.randomBytes(9).toString('base64url'); // ~12 字符
  const user = createUser({
    username: 'admin',
    password,
    tenantId: DEFAULT_TENANT,
    role: 'approver',
    isAdmin: true,
    label: '初始管理员（自动生成）',
  });
  return { user, password };
}
