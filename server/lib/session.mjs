/**
 * 会话（登录后发给浏览器的 cookie）。
 *
 * ## 为什么 cookie 里只放一个随机 sessionId，不放 token / 用户信息
 *
 * cookie 是**客户端保存**的。如果直接放 token 或 `{tenantId, role}`：
 * - 用户改一下 cookie 就能改角色（哪怕 HttpOnly 也挡不住本机工具/中间人）
 * - 一旦泄露就等于泄露长期凭据
 *
 * 所以 cookie 里只有一个**无意义的随机串**，真正的身份在服务端内存里。
 * 这也是"有状态会话"相对 JWT 的优势：**能立刻踢人**（删 session 就登出了）。
 *
 * ## 为什么放内存而不是落盘
 *
 * 会话是分钟~小时级的东西，重启后重新登录即可。
 * 落盘反而引入"session 文件泄露"和"过期清理"两个新问题。
 * 代价：多实例部署时不能共享会话 —— 本地工具不需要，写在这里备查。
 *
 * ## 安全属性
 *
 * - `HttpOnly`：JS 读不到（防 XSS 偷会话）
 * - `SameSite=Lax`：防 CSRF（跨站 POST 不带 cookie）
 * - `Path=/`
 * - 生产环境走 HTTPS 时应加 `Secure`（本地 HTTP 加不了，否则 cookie 发不出去）
 */
import crypto from 'node:crypto';

/** 会话有效期：12 小时。够一个工作日，又不会长期有效。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'wb_sid';

/** sessionId → 会话记录。key 是随机串，不是用户 id。 */
const sessions = new Map();

/**
 * 登录成功时创建会话。
 * @param {{id:string, username:string, tenantId:string, role:string, isAdmin?:boolean}} user
 */
export function createSession(user) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const rec = {
    sid,
    userId: user.id,
    username: user.username,
    tenantId: user.tenantId,
    role: user.role,
    isAdmin: !!user.isAdmin,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + SESSION_TTL_MS,
    lastSeenAt: now,
  };
  sessions.set(sid, rec);
  prune();
  return { sid, record: publicSession(rec) };
}

/** 查会话。过期即删并返回 null。 */
export function getSession(sid) {
  if (typeof sid !== 'string' || !sid) return null;
  const rec = sessions.get(sid);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  rec.lastSeenAt = Date.now();
  return publicSession(rec);
}

export function destroySession(sid) {
  return sessions.delete(sid);
}

/** 踢掉某个用户的全部会话（停用账号 / 改密码时用）。返回踢掉几个。 */
export function destroyUserSessions(userId) {
  let n = 0;
  for (const [sid, rec] of sessions) {
    if (rec.userId === userId) { sessions.delete(sid); n++; }
  }
  return n;
}

export function listSessions() {
  prune();
  return [...sessions.values()].map(publicSession);
}

/** 对外形态：**不返回 sid 本身**（列表接口不该泄露可用凭据）。 */
function publicSession(rec) {
  return {
    userId: rec.userId,
    username: rec.username,
    tenantId: rec.tenantId,
    role: rec.role,
    isAdmin: rec.isAdmin,
    createdAt: rec.createdAt,
    expiresAt: new Date(rec.expiresAt).toISOString(),
  };
}

/** 清掉过期会话，避免内存无限增长。每次创建会话时顺手清一次。 */
function prune() {
  const now = Date.now();
  for (const [sid, rec] of sessions) {
    if (rec.expiresAt <= now) sessions.delete(sid);
  }
}

/* ------------------------------------------------------------------ *
 * cookie 工具
 * ------------------------------------------------------------------ */

/** 解析 Cookie 头 → 对象。 */
export function parseCookies(req) {
  const raw = req?.headers?.cookie;
  if (!raw) return {};
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** 组装 Set-Cookie。`maxAge` 单位秒；传 0 表示立刻过期（登出用）。 */
export function buildSessionCookie(sid, maxAgeSec = SESSION_TTL_MS / 1000) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  return parts.join('; ');
}

/** 测试用：清空所有会话。 */
export function _resetSessionsForTest() {
  sessions.clear();
}
