/**
 * 工作台 HTTP 处理器。
 *
 * 抽成独立模块的原因：工作台有两种挂载方式 ——
 *   1) 独立进程   `node server/index.mjs`        → basePath = ''
 *   2) DSH 插件   webServer.register 前缀路由    → basePath = '/live-workbench'
 * 两种方式共用同一份路由，不再维护两套。
 *
 * 注意：所有前端资源都必须是**相对 URL**，否则挂到子路径下会取错文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { WEB_DIR, decksDir, pptxOut, scriptOut, htmlOut, ensureAllDirs } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { resolveAuth, authRequired, bearerToken, verifyToken } from './auth.mjs';
import { runAsTenant, DEFAULT_TENANT } from './tenant.mjs';
import {
  createSession,
  destroySession,
  getSession as getAuthSession,
  parseCookies,
  buildSessionCookie,
  SESSION_COOKIE,
} from './session.mjs';
import { authenticate, getUserById, setPassword } from './users.mjs';
import { loadKB, saveKB, kbStats, searchKB, upsertMountain, upsertProduct } from './kb.mjs';
import {
  loadCompliance,
  complianceStats,
  checkText,
  summarize,
  getWhitelist,
  addWhitelist,
  removeWhitelist,
} from './compliance.mjs';
import { listOptions, buildDeck } from './deck/build.mjs';
import { renderStyledDeck, DECK_STYLES, DEFAULT_STYLE } from './deck/html/index.mjs';
import { exportStyledPptx, stylePptxStatus } from './pptxStyle.mjs';
import { kbFileStatus, previewKbImport, applyKbImport } from './kb-file.mjs';
import { exportPptx, exportScript, loadDeckSpec, deckJsonPath, pptStatus } from './ppt.mjs';
import {
  listIntel,
  intelStats,
  addIntel,
  updateIntel,
  removeIntel,
  listSources,
  upsertSource,
  removeSource,
  fetchAll,
  suggestTopics,
  autoTag,
} from './intel.mjs';
import { answerQuestion, answerBatch, listIntents } from './qa.mjs';

/**
 * RAG 问答（知识库检索 + 大模型带出处回答）。
 *
 * 用动态 import 而不是顶层静态 import，是刻意的：RAG 模块读环境变量和
 * providers.json，任何一处配置炸了都不该让整个工作台起不来 —— 工作台还有
 * 五个跟大模型无关的模块要照常能用。
 */
async function loadRag() {
  const [answer, llm] = await Promise.all([
    import('./rag/answer.mjs'),
    import('./llm.mjs'),
  ]);
  return { answerKnowledge: answer.answerKnowledge, createLlm: llm.createLlm };
}
import { listSessions, getSession, saveSession, removeSession, reviewSession } from './review.mjs';

ensureAllDirs();

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, data, status = 200, extraHeaders = null) {
  const body = JSON.stringify(data);
  const headers = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) };
  // 登录/登出要带 Set-Cookie。用 __headers 信封传递，避免每个路由都要拿到 res。
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, text, status = 200, type = 'text/plain; charset=utf-8', extra = null) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    ...(extra || {}),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ text: raw });
      }
    });
    req.on('error', reject);
  });
}

/** 防止路径穿越。 */
function safeJoin(baseDir, relPath) {
  const p = path.resolve(baseDir, relPath);
  const base = path.resolve(baseDir);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

function listDecks() {
  try {
    if (!fs.existsSync(decksDir())) return [];
    const files = fs.readdirSync(decksDir()).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(decksDir(), f), 'utf8'));
        out.push({
          id: d.id,
          title: d.meta?.title,
          createdAt: d.createdAt,
          durationMin: d.meta?.durationMin,
          purposeLabel: d.meta?.purposeLabel,
          productCount: d.meta?.productCount || 1,
          slideCount: d.meta?.stats?.slideCount,
          scriptMinutes: d.meta?.stats?.scriptMinutes,
          verbatimCoverage: d.meta?.stats?.verbatimCoverage,
          complianceLevel: d.compliance?.level,
          complianceTotal: d.compliance?.total,
          host: d.meta?.host,
        });
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, re, keys, handler });
};

/* --- 基础 --- */
route('GET', '/api/health', async () => ({
  ok: true,
  version: '0.1.0',
  python: pptStatus(),
  time: new Date().toISOString(),
}));

/* ------------------------------------------------------------------ *
 * 登录 / 登出 / 当前身份（第 11 周）
 *
 * cookie 里只放一个随机 sessionId，身份在服务端内存里（见 session.mjs）。
 * 这样用户改不了 cookie 里的角色，登出也能**立刻**生效。
 * ------------------------------------------------------------------ */

/**
 * 登录。成功返回 Set-Cookie，之后浏览器自动带上，页面里的 fetch 不用改任何代码
 * （同源请求默认携带 cookie）。
 */
route('POST', '/api/auth/login', async (_p, body) => {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password) {
    return { status: 400, error: 'BAD_CREDENTIALS_INPUT', message: '用户名和密码都不能为空' };
  }

  const r = authenticate(username, password);
  if (!r.ok) {
    // 登录失败不写审计文件（会刷爆），但保留状态码语义：
    // 凭据错 401、账号停用 403、输入不合法 400
    return {
      status: r.code === 'USER_DISABLED' ? 403 : 401,
      error: r.code,
      message: r.message,
    };
  }

  const { sid } = createSession(r.user);
  return {
    ok: true,
    user: r.user,
    __headers: { 'set-cookie': buildSessionCookie(sid) },
  };
});

/** 登出：删服务端会话 + 让浏览器立刻丢掉 cookie。幂等（没登录也返回 ok）。 */
route('POST', '/api/auth/logout', async (_p, _b, _q, req) => {
  const sid = parseCookies(req)[SESSION_COOKIE];
  const removed = destroySession(sid);
  return {
    ok: true,
    removed,
    __headers: { 'set-cookie': buildSessionCookie('', 0) },
  };
});

/**
 * 当前身份。登录页用它判断"是否已登录"，主界面用它显示"当前是谁"。
 *
 * 注意这个路由是**公开路径**（未登录时也要能访问），所以不能靠 req.tenantContext，
 * 必须自己解析 cookie / token。
 */
route('GET', '/api/auth/me', async (_p, _b, _q, req) => {
  if (!authRequired()) {
    return { authenticated: true, mode: 'local', tenantId: DEFAULT_TENANT, username: 'local', role: 'approver', isAdmin: true };
  }
  const sess = getAuthSession(parseCookies(req)[SESSION_COOKIE]);
  if (sess) return { authenticated: true, mode: 'session', ...sess };

  const raw = bearerToken(req);
  if (raw) {
    const info = verifyToken(raw);
    if (info) return { authenticated: true, mode: 'token', ...info };
  }
  return { authenticated: false };
});

/** 改自己的密码。要求已登录（会话或 token 都行）。 */
route('POST', '/api/auth/password', async (_p, body, _q, req) => {
  const sess = getAuthSession(parseCookies(req)[SESSION_COOKIE]);
  const raw = bearerToken(req);
  const tokenInfo = raw ? verifyToken(raw) : null;
  if (!sess && !tokenInfo) {
    return { status: 401, error: 'UNAUTHORIZED', message: '请先登录' };
  }
  const userId = sess?.userId || null;
  if (!userId) {
    return { status: 403, error: 'FORBIDDEN', message: 'token 调用不支持改密码，请登录后在界面里改' };
  }
  const oldPassword = typeof body?.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (!oldPassword || !newPassword) {
    return { status: 400, error: 'BAD_INPUT', message: 'oldPassword 和 newPassword 都不能为空' };
  }
  // 用旧密码再验一次：防止会话被劫持后直接改密码锁死账号
  const check = authenticate(sess.username, oldPassword);
  if (!check.ok) {
    return { status: 401, error: 'BAD_CREDENTIALS', message: '原密码不正确' };
  }
  setPassword(userId, newPassword);
  return { ok: true, message: '密码已更新' };
});

route('GET', '/api/settings', async () => readJson('settings.json', {}) || {});
route('POST', '/api/settings', async (_p, body) => {
  const cur = readJson('settings.json', {}) || {};
  const next = { ...cur, ...body };
  writeJson('settings.json', next);
  return next;
});

// 知识库：从素材库文件夹（一堆 .md）导入。
// 文件是内容源头，所以这是**覆盖式**操作 —— 预览接口先把差异交给界面，
// 用户确认后才落盘（落盘前自动备份当前 knowledge.json）。
route('GET', '/api/kb/file-status', async () => kbFileStatus());
route('POST', '/api/kb/import-preview', async () => {
  const p = previewKbImport();
  if (!p.ok) return p;
  const { next, ...rest } = p; // next 是整份新知识库，体积大，不给前端
  return rest;
});
route('POST', '/api/kb/import', async () => applyKbImport());

// 视觉风格是可插拔的渲染期选项，不进 DeckSpec，所以在这里并进 options 给前端用
route('GET', '/api/options', async () => ({
  ...listOptions(),
  deckStyles: DECK_STYLES,
  defaultDeckStyle: DEFAULT_STYLE,
}));

/* --- 模块 2：知识库 --- */
route('GET', '/api/kb', async () => loadKB());
route('GET', '/api/kb/stats', async () => kbStats(loadKB()));
route('GET', '/api/kb/search', async (_p, _b, q) => searchKB(loadKB(), q.get('q') || ''));
route('POST', '/api/kb/mountain', async (_p, body) => {
  const kb = loadKB();
  const item = { ...body };
  if (!item.id) item.id = `m_${Date.now().toString(36)}`;
  upsertMountain(kb, item);
  return { ok: true, item };
});
route('POST', '/api/kb/product', async (_p, body) => {
  const kb = loadKB();
  const item = { ...body };
  if (!item.id) item.id = `p_${Date.now().toString(36)}`;
  upsertProduct(kb, item);
  return { ok: true, item };
});
route('POST', '/api/kb/delete', async (_p, body) => {
  const kb = loadKB();
  if (body.type === 'mountain') kb.mountains = kb.mountains.filter((m) => m.id !== body.id);
  else kb.products = kb.products.filter((p) => p.id !== body.id);
  saveKB(kb);
  return { ok: true };
});
route('POST', '/api/kb/import', async (_p, body) => {
  const kb = loadKB();
  if (body.kb && typeof body.kb === 'object') {
    saveKB({ ...kb, ...body.kb });
    return { ok: true, stats: kbStats(loadKB()) };
  }
  return { ok: false, message: '缺少 kb 字段' };
});

/* --- 模块 3：方案生成与导出 --- */
route('GET', '/api/decks', async () => listDecks());
route('POST', '/api/decks/build', async (_p, body) => {
  const deck = buildDeck(body || {});
  writeJson(path.join('decks', `${deck.id}.json`), deck);
  return deck;
});
route('GET', '/api/decks/:id', async (p) => loadDeckSpec(p.id) || { error: 'NOT_FOUND' });
route('PUT', '/api/decks/:id', async (p, body) => {
  const cur = loadDeckSpec(p.id);
  if (!cur) return { error: 'NOT_FOUND' };
  const next = { ...cur, ...body, id: cur.id };
  writeJson(path.join('decks', `${cur.id}.json`), next);
  return { ok: true, deck: next };
});
route('DELETE', '/api/decks/:id', async (p) => {
  const f = deckJsonPath(p.id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return { ok: true };
});
route('POST', '/api/decks/:id/recheck', async (p) => {
  const deck = loadDeckSpec(p.id);
  if (!deck) return { error: 'NOT_FOUND' };
  const result = checkText(deck.script.fullText);
  deck.compliance = summarize(result);
  writeJson(path.join('decks', `${deck.id}.json`), deck);
  return result;
});
route('POST', '/api/decks/:id/export-html', async (p, body) => {
  const deck = body.deck || loadDeckSpec(p.id);
  if (!deck) return { error: 'NOT_FOUND' };
  const mode = body.mode === 'flat' ? 'flat' : 'present';
  let out;
  try {
    out = renderStyledDeck(deck, { style: body.style || DEFAULT_STYLE, mode });
  } catch (e) {
    return { ok: false, error: 'STYLE_FAILED', message: e.message };
  }
  // 文件名带风格 id 与模式，便于同时留多份对比；标题做文件名净化
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(deck.meta?.title || 'deck')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 40);
  const name = `${stamp}_${safe}_${out.style}${mode === 'flat' ? '-flat' : ''}.html`;
  fs.mkdirSync(htmlOut(), { recursive: true });
  fs.writeFileSync(path.join(htmlOut(), name), out.html, 'utf8');
  return {
    ok: true,
    style: out.style,
    styleLabel: out.label,
    mode,
    slides: (deck.slides || []).length,
    bytes: Buffer.byteLength(out.html),
    fileName: name,
    relativePath: `output/html/${name}`,
  };
});
route('GET', '/api/pptx-by-style/status', async () => stylePptxStatus());
route('POST', '/api/decks/:id/export-pptx-by-style', async (p, body) => {
  const deck = body.deck || loadDeckSpec(p.id);
  if (!deck) return { error: 'NOT_FOUND' };
  return exportStyledPptx(deck, { style: body.style || DEFAULT_STYLE });
});
route('POST', '/api/decks/:id/export', async (p, body) => {
  const deck = body.deck || loadDeckSpec(p.id);
  if (!deck) return { error: 'NOT_FOUND' };
  const what = body.format || 'both';
  const out = { ok: true };
  if (what === 'pptx' || what === 'both') out.pptx = await exportPptx(deck);
  if (what === 'script' || what === 'both') out.script = exportScript(deck);
  out.ok = (out.pptx ? out.pptx.ok : true) && (out.script ? out.script.ok : true);
  return out;
});
route('POST', '/api/decks/preview-script', async (_p, body) => {
  const deck = buildDeck(body || {});
  return { meta: deck.meta, script: deck.script, compliance: deck.compliance, slides: deck.slides };
});

/* ------------------------------------------------------------------ *
 * 模块 10 / 11：批量生成 + A/B 对比（第 12 周：内容生产效率）
 * ------------------------------------------------------------------ */

/** 批量生成可选的候选山头 —— 界面用它渲染勾选列表 */
route('GET', '/api/batch/choices', async () => {
  try {
    const { listMountainChoices } = await import('./batch.mjs');
    return { mountains: listMountainChoices() };
  } catch (err) {
    return { status: 503, error: 'BATCH_UNAVAILABLE', message: err.message };
  }
});

/**
 * 批量生成。
 *
 * 输入示例：
 *   { mountains: ["倚邦","冰岛"], template: { purpose:"knowledge", durationMin:45 } }
 * 或直接给 items：[{ mountainName:"倚邦", durationMin:30 }]
 *
 * `dryRun: true` 只算"会生成几份 / 跳过几份"，不真的生成 —— 界面上的预检用。
 */
route('POST', '/api/batch', async (_p, body) => {
  let mod;
  try {
    mod = await import('./batch.mjs');
  } catch (err) {
    return { status: 503, error: 'BATCH_UNAVAILABLE', message: err.message };
  }

  // 支持两种写法：mountains 简写 / items 完整写法
  const mountains = Array.isArray(body?.mountains) ? body.mountains : null;
  const items = mountains
    ? mountains.map((m) => (typeof m === 'string' ? { mountainName: m } : m))
    : Array.isArray(body?.items)
      ? body.items
      : [];

  if (!items.length) {
    return { status: 400, error: 'EMPTY_BATCH', message: '至少指定一个山头（mountains）或一项（items）' };
  }

  try {
    return await mod.runBatch({
      items,
      template: body?.template || {},
      force: body?.force === true,
      dryRun: body?.dryRun === true,
    });
  } catch (err) {
    if (err.code === 'BATCH_TOO_LARGE') return { status: 400, error: err.code, message: err.message };
    if (err.code === 'EMPTY_BATCH') return { status: 400, error: err.code, message: err.message };
    return { status: 500, error: 'BATCH_FAILED', message: err.message };
  }
});

/**
 * 生成一组 A/B 变体并给出对比。
 *
 * 输入示例：
 *   {
 *     base: { mountainName:"倚邦", durationMin:45 },
 *     variants: [
 *       { label:"知识科普", overrides:{ purpose:"knowledge", audience:"veteran" } },
 *       { label:"大促逼单", overrides:{ purpose:"promo",     audience:"regular" } }
 *     ]
 *   }
 *
 * 返回里 `factLocked` 是硬校验：变体改了价格/规格就为 false，并带 error 级警告。
 */
route('POST', '/api/variants', async (_p, body) => {
  let mod;
  try {
    mod = await import('./variant.mjs');
  } catch (err) {
    return { status: 503, error: 'VARIANT_UNAVAILABLE', message: err.message };
  }
  try {
    return mod.buildVariants({
      base: body?.base || {},
      variants: body?.variants || [],
      groupId: body?.groupId,
      persist: body?.persist !== false,
    });
  } catch (err) {
    if (err.code === 'NEED_TWO_VARIANTS' || err.code === 'TOO_MANY_VARIANTS') {
      return { status: 400, error: err.code, message: err.message };
    }
    return { status: 500, error: 'VARIANT_FAILED', message: err.message };
  }
});

/* --- 模块 5：合规 --- */
route('GET', '/api/compliance', async () => loadCompliance());
route('GET', '/api/compliance/stats', async () => ({ ...complianceStats(loadCompliance()), whitelist: getWhitelist() }));
route('POST', '/api/compliance/check', async (_p, body) => checkText(body.text || '', { whitelist: body.whitelist }));
route('POST', '/api/compliance/whitelist', async (_p, body) => ({ ok: true, whitelist: addWhitelist(body.word) }));
route('DELETE', '/api/compliance/whitelist', async (_p, body) => ({ ok: true, whitelist: removeWhitelist(body.word) }));

/* --- 模块 1：情报 --- */
route('GET', '/api/intel', async () => ({ items: listIntel(), stats: intelStats() }));
route('POST', '/api/intel', async (_p, body) => {
  const items = addIntel(body.items || body);
  return { ok: true, added: items.length, items };
});
route('PUT', '/api/intel/:id', async (p, body) => ({ ok: true, item: updateIntel(p.id, body) }));
route('DELETE', '/api/intel/:id', async (p) => ({ ok: removeIntel(p.id) }));
route('POST', '/api/intel/autotag', async (_p, body) => ({ tags: autoTag(body.text || '') }));
route('GET', '/api/intel/sources', async () => listSources());
route('POST', '/api/intel/sources', async (_p, body) => ({ ok: true, sources: upsertSource(body) }));
route('DELETE', '/api/intel/sources/:id', async (p) => {
  removeSource(p.id);
  return { ok: true, sources: listSources() };
});
route('POST', '/api/intel/fetch', async (_p, body) => fetchAll(body || {}));
route('GET', '/api/intel/topics', async (_p, _b, q) => suggestTopics(Number(q.get('limit')) || 8));

/* --- 模块 4：弹幕问答 --- */
route('GET', '/api/qa/intents', async () => listIntents());
route('POST', '/api/qa/answer', async (_p, body) => answerQuestion(body.question || body.text || ''));
route('POST', '/api/qa/batch', async (_p, body) => answerBatch(body.questions || []));
route('GET', '/api/qa/faq', async () => readJson('faq.json', []) || []);

/* --- 模块 7：知识库 RAG 问答（带引用溯源） --- */
// 错误用「返回一个带 status 的对象」表达，而不是自己去写 res ——
// 这样无论路由挂成 HTTP 还是被测试直接调用，错误分支都走得通。
const badQuestion = () => ({ status: 400, error: 'BAD_QUESTION', message: 'question 不能为空' });
const unavailable = (message) => ({ status: 503, error: 'RAG_UNAVAILABLE', message });

/** 只接受字符串问题。数字/对象被 String() 强转会变成"123"这种问题混进检索，不如直接拒掉。 */
function readQuestion(body) {
  const q = body?.question;
  if (typeof q !== 'string') return null;
  return q.trim() || null;
}

/* --- 配额（Day 5）--- */
/**
 * 预检：超配额直接 429，**在调用模型之前**。
 * 这样超限时一分钱都不花，也让 429 的测试不需要真跑模型。
 * @returns {object|null} 有值 = 要拦下
 */
async function quotaGate() {
  try {
    const { checkQuota } = await import('./quota.mjs');
    const q = checkQuota();
    if (q.ok) return null;
    return { status: 429, error: q.error, message: q.message, limits: q.limits, usage: q.usage };
  } catch {
    // 配额模块异常时**放行**：宁可少记一次账，也不能让整个功能挂掉
    return null;
  }
}

/**
 * 记一次消费。按**真实 usage** 记账，不是按"调了一次"估。
 * 记账失败只打日志、不影响响应 —— 用户的需求已经完成了。
 */
async function chargeQuota(result) {
  try {
    const { consume } = await import('./quota.mjs');
    const u = result?.meta?.usage || {};
    consume({
      calls: 1,
      tokensIn: Number(u.prompt_tokens) || 0,
      tokensOut: Number(u.completion_tokens) || 0,
    });
  } catch (err) {
    console.error('[quota] 记账失败：', err.message);
  }
}

// 只看检索、不调模型：排错和调参时用，不需要任何 API key
route('POST', '/api/kb/search', async (_p, body) => {
  const question = readQuestion(body);
  if (!question) return badQuestion();
  try {
    const { searchKnowledge } = await import('./rag/search.mjs');
    return searchKnowledge(loadKB(), question, { k: body?.k });
  } catch (err) {
    return unavailable(err.message);
  }
});

route('POST', '/api/kb/ask', async (_p, body) => {
  const question = readQuestion(body);
  if (!question) return badQuestion();
  let rag;
  try {
    rag = await loadRag();
  } catch (err) {
    return unavailable(err.message);
  }
  // 没有可用模型通道时直接 503，而不是让调用方等到超时
  let providers = [];
  try {
    providers = (rag.createLlm().providers?.() || []).filter((p) => p.configured);
  } catch {
    providers = [];
  }
  if (!providers.length) {
    return { status: 503, error: 'NO_LLM', message: '未配置任何对话模型通道（LLM_API_KEY / providers.json）' };
  }

  // 配额预检放在真正调用模型之前：超限时一分钱都不花
  const blocked = await quotaGate();
  if (blocked) return blocked;

  const result = await rag.answerKnowledge(loadKB(), question, { k: body?.k });
  await chargeQuota(result);
  // status 是路由层的信封字段，不该漏给前端
  const { status: _ignored, ...rest } = result;
  return rest;
});

/* --- 模块 8：Agent 编排（模型自主决定调用哪些工具） --- */
// 与模块 7 的区别：模块 7 的流程由代码固定（检索→生成），
// 模块 8 的流程由模型决定（调哪个工具、调几次、什么顺序）。
route('POST', '/api/agent/run', async (_p, body, _query, req) => {
  const task = typeof body?.task === 'string' ? body.task.trim() : '';
  if (!task) return { status: 400, error: 'BAD_TASK', message: 'task 必须是非空字符串' };

  let mod;
  try {
    mod = await import('./agent/loop.mjs');
    // 同时把两个模块加载出来，避免"循环能跑但工具没注册"这种半残状态
    await import('./agent/tools.mjs');
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }

  // 没有可用模型通道就直接 503，别让调用方等到超时
  try {
    const { createLlm } = await import('./llm.mjs');
    const ready = (createLlm().providers?.() || []).some((p) => p.configured);
    if (!ready) {
      return { status: 503, error: 'NO_LLM', message: '未配置任何对话模型通道（LLM_API_KEY / providers.json）' };
    }
  } catch {
    return { status: 503, error: 'NO_LLM', message: '未配置任何对话模型通道（LLM_API_KEY / providers.json）' };
  }

  /**
   * 审批参数由**调用方**传，不来自模型。
   * 模型哪怕在对话里说"用户已经同意了"，也影响不到这里 —— 这是信任边界所在。
   *
   * 但"调用方"也分角色：**只有 approver 能通过 approvals 直接批准**。
   * 否则 editor 可以在自己的 /run 请求里把 approvals 塞进来，绕过确认这一步 ——
   * 那两阶段提交就形同虚设。没有角色（本地模式）时不受此限。
   */
  const role = req?.tenantContext?.role;
  const canApprove = !role || role === 'approver';
  const approvals = canApprove && Array.isArray(body?.approvals) ? body.approvals : [];

  // 配额预检放在真正调用模型之前：超限时一分钱都不花
  const blocked = await quotaGate();
  if (blocked) return blocked;

  const run = await mod.runAgent(task, {
    maxSteps: body?.maxSteps,
    approvals,
    allowWrites: body?.allowWrites !== false,
    role,
  });
  await chargeQuota(run);
  const { status: _envelope, ...payload } = run;
  return payload;
});

/** 列出可用工具 —— 前端要展示"Agent 能干什么"、以及哪些会改数据 */
route('GET', '/api/agent/tools', async () => {
  try {
    const { listToolMeta } = await import('./agent/tools.mjs');
    return { tools: listToolMeta() };
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }
});

/** 当前等待用户确认的写操作 —— 界面刷新后据此恢复确认卡片 */
route('GET', '/api/agent/pending', async () => {
  try {
    const { listPending } = await import('./agent/permissions.mjs');
    return { pending: listPending() };
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }
});

/**
 * 当前租户的配额与成本。
 *
 * 企业最关心两个问题："这个功能一个月花多少钱？""有人滥用怎么办？"
 * 这个接口就是回答它们的 —— 用量按真实 token 记账，成本单价可配置。
 */
route('GET', '/api/quota', async () => {
  try {
    const { quotaStatus } = await import('./quota.mjs');
    return quotaStatus();
  } catch (err) {
    return { status: 503, error: 'QUOTA_UNAVAILABLE', message: err.message };
  }
});

/**
 * 确认并执行一个待确认的写操作。
 *
 * 注意它**不重跑 agent**：直接执行第一次已校验过、并且给用户看过的那份参数。
 * 这一点很关键 —— 实测模型对同一句话的两次生成不完全一样（问号有没有、标点差异），
 * 如果"确认"实现成"重跑一次让模型再提议"，算出的 actionId 会对不上，
 * 用户就会遇到"我点了确认但什么都没发生"。
 */
route('POST', '/api/agent/confirm', async (_p, body, _query, req) => {
  const actionId = typeof body?.actionId === 'string' ? body.actionId.trim() : '';
  if (!actionId) return { status: 400, error: 'BAD_ACTION_ID', message: 'actionId 必须是非空字符串' };
  try {
    const { confirmPending } = await import('./agent/permissions.mjs');
    // 角色从租户上下文取（= token），不接受请求体传入。
    // 只有 approver 能批准；editor 提可以，批不行。
    const r = confirmPending(actionId, undefined, { role: req?.tenantContext?.role });
    if (r.code === 'FORBIDDEN_ROLE') {
      return { status: 403, error: 'FORBIDDEN', message: r.error };
    }
    if (r.code === 'NO_PENDING') {
      return { status: 404, error: 'NO_PENDING', message: r.error };
    }
    if (r.ok === false) {
      return { status: 409, error: r.code || 'APPLY_FAILED', message: r.error };
    }
    return r;
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }
});

/** 取消一个待确认的写操作（什么都不执行） */
route('POST', '/api/agent/cancel', async (_p, body) => {
  const actionId = typeof body?.actionId === 'string' ? body.actionId.trim() : '';
  if (!actionId) return { status: 400, error: 'BAD_ACTION_ID', message: 'actionId 必须是非空字符串' };
  try {
    const { clearPending } = await import('./agent/permissions.mjs');
    return { ok: true, removed: clearPending(actionId) };
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }
});

/** 权限审计：每次写操作判定都会留痕，用来追查"谁批准了什么" */
route('GET', '/api/agent/audit', async (_p, _body, query) => {
  try {
    const { listAudit } = await import('./agent/permissions.mjs');
    return { audit: listAudit(query?.get('limit')) };
  } catch (err) {
    return { status: 503, error: 'AGENT_UNAVAILABLE', message: err.message };
  }
});

route('POST', '/api/qa/faq', async (_p, body) => {
  // 校验：空问答写进去会变成一条"永远命中但什么也没说"的脏数据，
  // 直播时被调出来就是一句空话。宁可 400 也不要写脏。
  const q = typeof body?.q === 'string' ? body.q.trim() : '';
  const a = typeof body?.a === 'string' ? body.a.trim() : '';
  if (!q || !a) return { status: 400, error: 'BAD_FAQ', message: 'q（问题）和 a（回答）都必须是非空字符串' };

  const list = readJson('faq.json', []) || [];
  const item = { id: body.id || `faq_${Date.now().toString(36)}`, q, a, enabled: body.enabled !== false, tags: Array.isArray(body.tags) ? body.tags : [] };
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  writeJson('faq.json', list);
  return { ok: true, item };
});
route('DELETE', '/api/qa/faq/:id', async (p) => {
  writeJson('faq.json', (readJson('faq.json', []) || []).filter((x) => x.id !== p.id));
  return { ok: true };
});

/* --- 模块 6：复盘 --- */
route('GET', '/api/sessions', async () => listSessions());
route('GET', '/api/sessions/:id', async (p) => getSession(p.id) || { error: 'NOT_FOUND' });
route('POST', '/api/sessions', async (_p, body) => saveSession(body || {}));
route('POST', '/api/sessions/:id/analyze', async (p, body) => {
  const s = body.session || getSession(p.id);
  if (!s) return { error: 'NOT_FOUND' };
  const review = reviewSession(s);
  if (body.persist !== false) saveSession({ ...s, review });
  return review;
});
route('DELETE', '/api/sessions/:id', async (p) => ({ ok: removeSession(p.id) }));

/* ------------------------------------------------------------------ *
 * 静态与产物
 * ------------------------------------------------------------------ */

/**
 * 静态资源的缓存策略。
 *
 * 踩过的坑：原来只发 `content-type`，**没有任何缓存头**。
 * 浏览器对这种响应会走"启发式缓存"——改完 `web/app.js` 刷新页面，
 * 拿到的还是旧 JS，侧边栏顺序没变，看上去像"服务没改好"。
 *
 * 策略：
 *   - HTML        → no-cache（每次都问服务器，拿到新的版本号）
 *   - JS / CSS    → no-cache + ETag（内容没变就 304，几乎零成本）
 *   - 其他（图片等）→ 短缓存 60s + ETag
 *
 * ETag 用 `mtime-size`，不用读文件内容，便宜且足够区分版本。
 */
function staticHeaders(file, ext) {
  const st = fs.statSync(file);
  const etag = `W/"${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`;
  const isCode = ext === '.js' || ext === '.css' || ext === '.mjs';
  const isHtml = ext === '.html';
  return {
    etag,
    'cache-control': isHtml || isCode ? 'no-cache, must-revalidate' : 'public, max-age=60',
  };
}

function serveStatic(res, urlPath, req) {
  // 必须以相对路径 join，否则 path.resolve 会把 "/app.js" 当成磁盘根目录
  const rel = urlPath.replace(/^\/+/, '') || 'index.html';
  const file = safeJoin(WEB_DIR, rel);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      const extra = staticHeaders(idx, '.html');
      return sendText(res, fs.readFileSync(idx, 'utf8'), 200, MIME['.html'], extra);
    }
    return sendText(res, 'Not Found', 404);
  }
  const ext = path.extname(file).toLowerCase();
  const extra = staticHeaders(file, ext);
  // 条件请求：浏览器带着上次的 ETag 来，内容没变直接 304，省带宽
  const inm = req && req.headers && req.headers['if-none-match'];
  if (inm && inm === extra.etag) {
    res.writeHead(304, { etag: extra.etag, 'cache-control': extra['cache-control'] });
    return res.end();
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', ...extra });
  fs.createReadStream(file).pipe(res);
}

function serveArtifact(res, kind, name, opts = {}) {
  const base = kind === 'pptx' ? pptxOut() : kind === 'html' ? htmlOut() : scriptOut();
  const file = safeJoin(base, name);
  if (!file || !fs.existsSync(file)) return sendText(res, '文件不存在', 404);
  const ext = path.extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  // HTML 幻灯片默认**内联**打开（新标签页里直接看），其余导出物走下载
  if (opts.inline) headers['content-disposition'] = 'inline';
  else headers['content-disposition'] = `attachment; filename="${encodeURIComponent(name)}"`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * @param {{basePath?: string}} options
 *   basePath —— 挂载前缀。独立进程用 ''；DSH 插件挂在 '/live-workbench'。
 * @returns {(req, res) => Promise<void>}
 */
export function createWorkbenchHandler(options = {}) {
  const basePath = (options.basePath || '').replace(/\/+$/, '');

  return async function handle(req, res) {
    let url;
    let pathname;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, { error: 'BAD_URL', message: 'Invalid request URL' }, 400);
    }

    if (basePath) {
      if (pathname === basePath) {
        // 补上尾部斜杠，否则页面里的相对 URL 会解析到站点根
        res.writeHead(302, { location: `${basePath}/` });
        return res.end();
      }
      if (!pathname.startsWith(basePath + '/')) return sendText(res, 'Not Found', 404);
      pathname = pathname.slice(basePath.length);
    }

    // 去掉末尾斜杠，避免 /api/sessions/ 匹配不到 /api/sessions
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
    if (pathname === '') pathname = '/';

    // ── 认证与租户上下文（Day 2）──
    // 身份只能来自 token 或会话 cookie（见 auth.mjs），解析失败直接拒绝，不进入任何业务逻辑。
    // 这一步必须在**读任何数据之前**，否则一次未授权请求已经碰到磁盘了。
    const auth = resolveAuth(req, pathname);
    if (!auth.ok) {
      // 浏览器在地址栏打开页面时，给一个跳转到登录页的体验；
      // API 请求仍然返回 401 JSON —— 两者不能混（前端 fetch 拿到 302 会很难处理）。
      const wantsHtml = pathname === '/' || pathname.endsWith('.html');
      if (wantsHtml && !res.headersSent) {
        res.writeHead(302, { location: `${basePath}/login` });
        return res.end();
      }
      if (!res.headersSent) sendJson(res, { error: auth.error, message: auth.message }, auth.status);
      return;
    }
    // 挂到 req 上，后续路由（比如角色校验）可以直接用，不用重复解析 token
    if (auth.ctx) req.tenantContext = auth.ctx;

    const dispatch = async () => {
    try {
      // 登录页：单独处理，不能靠静态文件（`/login` 没有扩展名）
      if (pathname === '/login' || pathname === '/login.html') {
        const file = path.join(WEB_DIR, 'login.html');
        if (!fs.existsSync(file)) return sendText(res, '登录页缺失', 500);
        return sendText(res, fs.readFileSync(file, 'utf8'), 200, 'text/html; charset=utf-8');
      }

      if (pathname.startsWith('/files/pptx/')) return serveArtifact(res, 'pptx', pathname.replace('/files/pptx/', ''));
      if (pathname.startsWith('/files/scripts/')) return serveArtifact(res, 'script', pathname.replace('/files/scripts/', ''));
      if (pathname.startsWith('/files/html/')) return serveArtifact(res, 'html', pathname.replace('/files/html/', ''), { inline: true });

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        const data = await r.handler(params, body, url.searchParams, req);
        // 约定：handler 返回的对象若带 status，就是 HTTP 状态码；
        // 带 `__headers` 就是额外的响应头（登录/登出要用它带 Set-Cookie）。
        //
        // ⚠️ **数组不能走展开语法**：`{...[]}` 会变成 `{0:...}`，
        // 把所有"直接返回数组"的接口（sources / faq / sessions / decks）悄悄改坏，
        // 前端表现为 `xxx.filter is not a function`。所以先判断是不是普通对象。
        if (data !== undefined && !res.headersSent) {
          const isPlainObject = data !== null && typeof data === 'object' && !Array.isArray(data);
          if (!isPlainObject) return sendJson(res, data, 200);

          const { __headers: extraHeaders, ...rest } = data;
          const code = Number(rest?.status);
          if (Number.isFinite(code) && code >= 400) {
            const { status: _envelope, ...payload } = rest;
            return sendJson(res, payload, code, extraHeaders);
          }
          // 成功分支保留 status（现有的 /api/health 等路由会带它），错误分支剥掉
          return sendJson(res, rest, 200, extraHeaders);
        }
        return;
      }

      if (pathname.startsWith('/api/')) return sendJson(res, { error: 'NOT_FOUND', path: pathname }, 404);
      return serveStatic(res, pathname, req);
    } catch (err) {
      console.error(`[workbench] ${req.method} ${pathname} 失败：`, err);
      if (!res.headersSent) sendJson(res, { error: 'INTERNAL', message: err.message }, 500);
    }
    };

    // **整个请求处理都跑在租户上下文里** —— 这是全部数据隔离的入口。
    // paths.mjs / store.mjs 读的就是这个上下文，所以从这里开始，读写都会落到
    // 当前 token 所属租户的目录。公开路径（健康检查 / 静态资源）不需要上下文。
    return auth.ctx ? runAsTenant(auth.ctx, dispatch) : dispatch();
  };
}

export { listDecks, MIME };
