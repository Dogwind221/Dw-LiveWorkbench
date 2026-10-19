/**
 * 配额与用量（第 10 周 Day 5）。
 *
 * ## 为什么多租户必须做这个
 *
 * AI 功能**按 token 计费**。20 个人乱用，一个月账单能吓死人。
 * 企业采购一定会问两个问题：
 *   1. 这个功能一个月要花多少钱？
 *   2. 有人滥用怎么办？
 * 这一层就是回答这两个问题的。
 *
 * ## 设计
 *
 * - **限额**来自租户注册表 `data/tenants.json` 的 `quota` 字段（平台级、管理员配）
 * - **用量**落在 `data/tenants/<id>/quota-usage.json`（租户级，隔离自动生效）
 * - 只统计**真正花钱的入口**：`/api/kb/ask` 和 `/api/agent/run`。
 *   `/api/kb/search` 不调模型，不计费 —— 记账口径要跟成本口径一致。
 *
 * ## 计数必须同步完成
 *
 * 读-改-写三个步骤之间**不能有 await**，否则并发请求会互相覆盖计数。
 * 所以 `consume()` 是同步函数，这是刻意的（Node 单进程内同步块是原子的）。
 *
 * ## 单价是可配置的，不是硬编码的
 *
 * 实测报告只核实了**输入**单价（deepseek-flash 空闲时段 ¥1/百万 token）。
 * 输出单价**没有实测到**，所以默认值明确标记为假设，用环境变量覆盖：
 *
 *   COST_IN_PER_MTOK=1    # 元 / 百万 输入 token
 *   COST_OUT_PER_MTOK=2   # 元 / 百万 输出 token（假设值，请按官方价格页校正）
 */
import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from './paths.mjs';
import { getTenant } from './tenants.mjs';
import { currentTenantId, DEFAULT_TENANT } from './tenant.mjs';

const USAGE_FILE = 'quota-usage.json';

/** 默认限额（注册表里没配时用这个）。 */
const DEFAULT_QUOTA = { dailyCalls: 2000, monthlyTokens: 2_000_000 };

/**
 * 默认单价（元 / 百万 token）。
 *
 * ⚠️ 输入价有实测依据（报告 §4：deepseek-flash 空闲时段 ¥1/百万）；
 * **输出价是按常见比例估的假设值**，不是官方核实数字。
 * 做真实成本核算前请到官方价格页确认并用环境变量覆盖。
 */
export const DEFAULT_PRICE = {
  inPerMTok: Number(process.env.COST_IN_PER_MTOK || 1),
  outPerMTok: Number(process.env.COST_OUT_PER_MTOK || 2),
};

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

const activeTenant = () => currentTenantId() || DEFAULT_TENANT;

function usagePath() {
  return path.join(dataDir(), USAGE_FILE);
}

/** 读用量；日期跨天/跨月时自动归零（不做定时任务，读的时候顺手重置）。 */
function readUsage() {
  const empty = { day: today(), calls: 0, month: thisMonth(), tokensIn: 0, tokensOut: 0, updatedAt: null };
  let u;
  try {
    u = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
  } catch {
    return empty;
  }
  if (!u || typeof u !== 'object') return empty;
  const out = {
    day: u.day || today(),
    calls: Number(u.calls) || 0,
    month: u.month || thisMonth(),
    tokensIn: Number(u.tokensIn) || 0,
    tokensOut: Number(u.tokensOut) || 0,
    updatedAt: u.updatedAt || null,
  };
  // 跨天：调用次数归零（token 是按月的，不跟着重置）
  if (out.day !== today()) {
    out.day = today();
    out.calls = 0;
  }
  // 跨月：token 归零
  if (out.month !== thisMonth()) {
    out.month = thisMonth();
    out.tokensIn = 0;
    out.tokensOut = 0;
  }
  return out;
}

function writeUsage(u) {
  const p = usagePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = { ...u, updatedAt: new Date().toISOString() };
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return data;
}

/**
 * 读一个数字配置，缺失才用默认值。
 *
 * **不能用 `Number(v) || fallback`** —— 那样 `0` 会被当成"没配"而回落到默认值。
 * 实测踩过：把租户配额设成 `dailyCalls: 0`（本意是"立刻拦下所有调用"），
 * 结果 `0 || 2000` 变成 2000，配额完全没生效，429 测试直接失败。
 * `0` 是一个合法的配额值（用于停服/演练），必须能表达。
 */
function numOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 当前租户的限额（来自注册表；租户不存在时用默认值）。 */
export function limits() {
  const t = getTenant(activeTenant());
  const q = t?.quota || {};
  return {
    dailyCalls: numOr(q.dailyCalls, DEFAULT_QUOTA.dailyCalls),
    monthlyTokens: numOr(q.monthlyTokens, DEFAULT_QUOTA.monthlyTokens),
  };
}

/** 当前租户的原始用量。 */
export function usage() {
  return readUsage();
}

/**
 * 预检：还能不能调。
 *
 * **在调用模型之前检查** —— 这样超配额时一分钱都不花（也方便测试 429 不需要真跑模型）。
 *
 * @returns {{ok:true, day:object, month:object, limits:object} | {ok:false, error:string, message:string, ...}}
 */
export function checkQuota() {
  const lim = limits();
  const u = readUsage();
  const monthTokens = u.tokensIn + u.tokensOut;

  if (u.calls >= lim.dailyCalls) {
    return {
      ok: false,
      error: 'DAILY_CALLS_EXCEEDED',
      message: `今日调用次数已达上限（${u.calls}/${lim.dailyCalls}）。明天 0 点重置，或联系管理员提高额度。`,
      limits: lim,
      usage: { calls: u.calls, monthTokens },
    };
  }
  if (monthTokens >= lim.monthlyTokens) {
    return {
      ok: false,
      error: 'MONTHLY_TOKENS_EXCEEDED',
      message: `本月 token 额度已用完（${monthTokens}/${lim.monthlyTokens}）。下月 1 号重置，或联系管理员提高额度。`,
      limits: lim,
      usage: { calls: u.calls, monthTokens },
    };
  }
  return {
    ok: true,
    limits: lim,
    day: { used: u.calls, limit: lim.dailyCalls, remaining: lim.dailyCalls - u.calls },
    month: { used: monthTokens, limit: lim.monthlyTokens, remaining: lim.monthlyTokens - monthTokens },
  };
}

/**
 * 记一次消费。**同步**完成读-改-写，中间不能有 await（见文件头注释）。
 *
 * @param {{calls?: number, tokensIn?: number, tokensOut?: number}} delta
 */
export function consume(delta = {}) {
  const u = readUsage();
  u.calls += Number(delta.calls) || 0;
  u.tokensIn += Number(delta.tokensIn) || 0;
  u.tokensOut += Number(delta.tokensOut) || 0;
  return writeUsage(u);
}

/**
 * 估算成本（元）。单价可配置，见文件头。
 *
 * @param {{tokensIn?: number, tokensOut?: number}} [u]
 * @param {{inPerMTok?: number, outPerMTok?: number}} [price]
 */
export function estimateCost(u = readUsage(), price = DEFAULT_PRICE) {
  const inTok = Number(u.tokensIn) || 0;
  const outTok = Number(u.tokensOut) || 0;
  return {
    tokensIn: inTok,
    tokensOut: outTok,
    costIn: (inTok / 1_000_000) * price.inPerMTok,
    costOut: (outTok / 1_000_000) * price.outPerMTok,
    total: (inTok / 1_000_000) * price.inPerMTok + (outTok / 1_000_000) * price.outPerMTok,
    price,
  };
}

/** 给界面/接口用的一份完整状态。 */
export function quotaStatus() {
  const u = readUsage();
  const lim = limits();
  const cost = estimateCost(u);
  return {
    tenantId: activeTenant(),
    day: u.day,
    month: u.month,
    calls: { used: u.calls, limit: lim.dailyCalls, remaining: Math.max(0, lim.dailyCalls - u.calls) },
    tokens: {
      used: u.tokensIn + u.tokensOut,
      limit: lim.monthlyTokens,
      remaining: Math.max(0, lim.monthlyTokens - (u.tokensIn + u.tokensOut)),
      in: u.tokensIn,
      out: u.tokensOut,
    },
    cost: {
      total: Number(cost.total.toFixed(6)),
      costIn: Number(cost.costIn.toFixed(6)),
      costOut: Number(cost.costOut.toFixed(6)),
      currency: 'CNY',
      pricePerMTok: cost.price,
      priceNote: '输出单价为假设值，请按官方价格页校正（环境变量 COST_OUT_PER_MTOK）',
    },
    updatedAt: u.updatedAt,
  };
}

/** 测试用：清空当前租户的用量。 */
export function _resetUsageForTest() {
  try { fs.unlinkSync(usagePath()); } catch { /* 不存在 */ }
}
