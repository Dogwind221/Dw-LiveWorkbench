/**
 * 身份认证与 token 管理（Day 2）。
 *
 * ## 这一层的唯一职责
 *
 * 回答一个问题：**"这次请求属于哪个租户、这个人是什么角色？"**
 * 答案**只能来自 token**，绝不来自请求体、query 或任何客户端可改的东西。
 *
 * 为什么这一点是安全根基：
 *
 * ```js
 * // ❌ 改一个参数就能读别人的数据 —— 多租户变成"假装多租户"，比不做还危险
 * const tenantId = body.tenantId || req.headers['x-tenant-id'];
 *
 * // ✅ 唯一正确来源
 * const { tenantId } = verifyToken(req.headers.authorization);
 * ```
 *
 * ## token 存储
 *
 * `data/tokens.json` 里**只存 sha256 哈希，不存明文**。
 * 明文只在创建时返回一次（给管理员保存），之后系统自己也拿不回来。
 * 这样即使 tokens.json 泄露，也不能直接拿来调用接口。
 *
 * ## 两种运行模式
 *
 * | 模式 | 触发 | 行为 |
 * | --- | --- | --- |
 * | `local`（默认） | 未设 `WORKBENCH_AUTH` | 单用户本地工具。所有请求落到 default 租户，角色 approver |
 * | `required` | `WORKBENCH_AUTH=required` | 每个 /api/* 和 /files/* 都必须带有效 token |
 *
 * 为什么默认是 local：这个工具默认是"自己店里一个人用"。硬要 token 会让
 * 现有 UI 和全部测试当场挂掉，而那些人并没有多租户需求。
 *
 * **但是有一条安全护栏**（在 `server/index.mjs`）：
 * 一旦注册表里有 **>1 个启用租户** 且认证没开，服务**拒绝启动**。
 * 这样"多租户但没认证"这个危险组合根本不可能跑起来。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { DATA_ROOT, tokensFile } from './paths.mjs';
import { assertTenantId, DEFAULT_TENANT } from './tenant.mjs';
import { isTenantActive } from './tenants.mjs';
import { SESSION_COOKIE, getSession, parseCookies } from './session.mjs';

export const ROLES = ['viewer', 'editor', 'approver'];
/** 权限从低到高，用于"至少需要某角色"的判断。 */
const ROLE_RANK = { viewer: 1, editor: 2, approver: 3 };

export const TOKEN_PREFIX = 'wb_';

export function isValidRole(role) {
  return ROLES.includes(role);
}

export function roleAtLeast(role, need) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[need] || 99);
}

/** 认证是否强制。**每次调用时读 env**，方便测试在同一进程里切换。 */
export function authRequired() {
  const v = String(process.env.WORKBENCH_AUTH || '').trim().toLowerCase();
  return v === 'required' || v === '1' || v === 'on' || v === 'true';
}

export function authMode() {
  return authRequired() ? 'required' : 'local';
}

/* ------------------------------------------------------------------ *
 * token 存储
 * ------------------------------------------------------------------ */

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function readStore() {
  try {
    const raw = fs.readFileSync(tokensFile(), 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return { version: 1, tokens: [] };
    const j = JSON.parse(raw);
    return { version: j.version || 1, tokens: Array.isArray(j.tokens) ? j.tokens : [] };
  } catch {
    return { version: 1, tokens: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const tmp = `${tokensFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, tokensFile());
}

/** 对外暴露的 token 元数据 —— **永远不含 hash**。 */
function publicRecord(t) {
  return {
    id: t.id,
    tenantId: t.tenantId,
    userId: t.userId,
    role: t.role,
    label: t.label || '',
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt || null,
  };
}

/**
 * 创建 token。返回的 `raw` **只显示这一次**，系统里只留哈希。
 *
 * @returns {{raw: string, record: object}}
 */
export function createToken({ tenantId, userId, role = 'editor', label = '' } = {}) {
  const tid = assertTenantId(tenantId);
  if (!isValidRole(role)) {
    const err = new Error(`非法角色：${role}（只允许 ${ROLES.join(' / ')}）`);
    err.code = 'BAD_ROLE';
    throw err;
  }
  const uid = String(userId || '').trim();
  if (!uid) {
    const err = new Error('userId 不能为空');
    err.code = 'BAD_USER_ID';
    throw err;
  }

  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const rec = {
    id: `tok_${crypto.randomBytes(8).toString('hex')}`,
    tenantId: tid,
    userId: uid,
    role,
    label: String(label || '').slice(0, 80),
    hash: sha256(raw),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const store = readStore();
  store.tokens.push(rec);
  writeStore(store);
  return { raw, record: publicRecord(rec) };
}

/** token 元数据列表（不含明文、不含 hash）。 */
export function listTokens() {
  return readStore().tokens.map(publicRecord);
}

/** 撤销 token（按 id 或按 userId）。返回撤销条数。 */
export function revokeToken({ id, userId } = {}) {
  const store = readStore();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => {
    if (id && t.id === id) return false;
    if (userId && t.userId === userId) return false;
    return true;
  });
  writeStore(store);
  return before - store.tokens.length;
}

/**
 * 校验 token。
 *
 * @param {string} raw
 * @returns {{tokenId:string, tenantId:string, userId:string, role:string}|null}
 */
export function verifyToken(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX) || raw.length < 20) return null;
  const h = sha256(raw);
  const store = readStore();
  let hit = null;
  for (const t of store.tokens) {
    // 定长比较，避免时序侧信道。两边都是 64 位 hex，长度必然相同。
    let same = false;
    try {
      same = crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(String(t.hash), 'hex'));
    } catch {
      same = false;
    }
    if (same) { hit = t; break; }
  }
  if (!hit) return null;

  // 第二道检查：租户必须是启用状态。否则"停用租户"只是改了个标志位，token 照样能用。
  if (!isTenantActive(hit.tenantId)) return null;

  touchLastUsed(hit.id);
  return { tokenId: hit.id, tenantId: hit.tenantId, userId: hit.userId, role: hit.role };
}

/** lastUsedAt 不必每个请求都写盘（写放大），一分钟一次足够。 */
const lastTouched = new Map();
function touchLastUsed(tokenId) {
  const now = Date.now();
  if (lastTouched.has(tokenId) && now - lastTouched.get(tokenId) < 60_000) return;
  lastTouched.set(tokenId, now);
  try {
    const store = readStore();
    const t = store.tokens.find((x) => x.id === tokenId);
    if (t) {
      t.lastUsedAt = new Date().toISOString();
      writeStore(store);
    }
  } catch {
    /* 记录使用时间失败不该影响请求 */
  }
}

/**
 * 首次启动时自动生成一个 owner token（如果系统里一个都没有）。
 *
 * 为什么要自动生成：否则"开了认证但没有任何 token"= 谁也进不去，
 * 而唯一的救命办法是手改 JSON。自动生成 + 启动时打印一次，是 Jupyter / Portainer
 * 这类本地工具的成熟做法。
 *
 * @returns {{raw:string, record:object}|null} 已存在 token 时返回 null
 */
export function ensureBootstrapToken() {
  if (readStore().tokens.length) return null;
  return createToken({
    tenantId: DEFAULT_TENANT,
    userId: 'owner',
    role: 'approver',
    label: '初始 owner token（自动生成，只显示这一次）',
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 层：从请求解析身份
 * ------------------------------------------------------------------ */

/**
 * 哪些路径**不需要**认证。
 *
 * - `/api/health`：健康检查，不含任何租户数据
 * - `/api/auth/*`：登录相关。不公开就没法登录（先有鸡还是先有蛋）
 * - `/login`：登录页本身
 * - 静态前端资源：`/`、`/app.js`、`/styles.css` 等，也不含租户数据
 *
 * **注意 `/files/*` 必须认证** —— 那里是租户导出的 PPTX / HTML / 脚本，
 * 含价格、树龄等真实内容。第一版差点漏掉，那等于把"数据隔离"从后门开了。
 */
export function isPublicPath(pathname) {
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname === '/login' || pathname === '/login.html') return true;
  if (pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/files/')) return false;
  // 应用主页面必须登录才能看。
  // 注意不能把所有非 API 路径都当公开：`/` 就是主界面本身，
  // 第一版把它当静态资源放行了，结果未登录也能看到工作台骨架。
  if (pathname === '/' || pathname === '/index.html') return false;
  // 其余是前端静态资源（app.js / styles.css / 图片）。
  // 它们必须公开，否则登录页自己都加载不出来。
  return true;
}

/** 从 Authorization header 里取 token。 */
export function bearerToken(req) {
  const h = req?.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

/**
 * 解析请求身份。
 *
 * 顺序：**Bearer token → 会话 cookie**。
 * - Bearer 是给程序用的（CLI / 集成），无状态、每次带
 * - cookie 是给人用的（浏览器登录后自动带），有状态、能立刻踢人
 *
 * 两者最终都归约成同一份 `{tenantId, userId, role}` —— 不是两套权限系统。
 *
 * @returns {{ok:true, ctx:object|null, mode:string} | {ok:false, status:number, error:string, message:string}}
 */
export function resolveAuth(req, pathname) {
  // 本地模式：单用户，直接以 default 租户的最高权限运行
  if (!authRequired()) {
    return {
      ok: true,
      mode: 'local',
      ctx: { tenantId: DEFAULT_TENANT, userId: 'local', role: 'approver' },
    };
  }

  // 公开路径不要求 token
  if (isPublicPath(pathname)) {
    return { ok: true, mode: 'public', ctx: null };
  }

  // ① Bearer token（程序调用）
  const raw = bearerToken(req);
  if (raw) {
    const info = verifyToken(raw);
    if (!info) {
      return { ok: false, status: 401, error: 'BAD_TOKEN', message: 'token 无效、已撤销，或所属租户已停用' };
    }
    return {
      ok: true,
      mode: 'token',
      ctx: { tenantId: info.tenantId, userId: info.userId, role: info.role, tokenId: info.tokenId },
    };
  }

  // ② 会话 cookie（浏览器登录后）
  const sid = parseCookies(req)[SESSION_COOKIE];
  const sess = getSession(sid);
  if (sess) {
    return {
      ok: true,
      mode: 'session',
      ctx: { tenantId: sess.tenantId, userId: sess.username, role: sess.role, isAdmin: sess.isAdmin, sid },
    };
  }

  return {
    ok: false,
    status: 401,
    error: 'UNAUTHORIZED',
    message: '未登录（或会话已过期）。请先登录，或用 Authorization: Bearer <token>',
  };
}

/**
 * 要求至少某个角色。用于写操作（只有 approver 能批准等）。
 * @returns {{ok:true}|{ok:false, status:403, error:string, message:string}}
 */
export function requireRole(ctx, need) {
  // 本地模式下 ctx.role 是 approver，天然通过
  if (ctx && roleAtLeast(ctx.role, need)) return { ok: true };
  return {
    ok: false,
    status: 403,
    error: 'FORBIDDEN',
    message: `该操作需要 ${need} 角色，当前是 ${ctx?.role || '未知'}`,
  };
}
