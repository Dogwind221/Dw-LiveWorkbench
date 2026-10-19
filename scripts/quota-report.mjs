/**
 * 成本报表：所有租户的用量与成本估算。
 *
 * 企业采购一定会问："这个功能一个月要花多少钱？"
 * 这个脚本给出的是**基于真实用量的账**，不是拍脑袋的估算。
 *
 * 用法：
 *   node scripts/quota-report.mjs
 *   COST_IN_PER_MTOK=1 COST_OUT_PER_MTOK=2 node scripts/quota-report.mjs
 *
 * 口径说明：
 *   - 调用次数：`/api/kb/ask` 和 `/api/agent/run` 各算 1 次（只有这两个调模型）
 *   - token：按模型返回的真实 usage 记账（prompt / completion 分开）
 *   - 成本：输入/输出分别乘单价。**输出单价默认值是假设值**，请按官方价格页校正。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_ROOT } from '../server/lib/paths.mjs';
import { listTenants } from '../server/lib/tenants.mjs';
import { DEFAULT_PRICE } from '../server/lib/quota.mjs';

const DEFAULT_QUOTA = { dailyCalls: 2000, monthlyTokens: 2_000_000 };
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const yuan = (n) => `¥${Number(n).toFixed(4)}`;

function numOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 读某租户的用量文件（直接读盘，不依赖 AsyncLocalStorage 上下文）。 */
function readUsage(tenantId) {
  const p = path.join(DATA_ROOT, 'tenants', tenantId, 'quota-usage.json');
  try {
    const u = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      day: u.day || '-',
      calls: numOr(u.calls, 0),
      month: u.month || '-',
      tokensIn: numOr(u.tokensIn, 0),
      tokensOut: numOr(u.tokensOut, 0),
    };
  } catch {
    return { day: '-', calls: 0, month: '-', tokensIn: 0, tokensOut: 0 };
  }
}

const tenants = listTenants();
if (!tenants.length) {
  console.log('租户注册表是空的。先跑一次 server/index.mjs 或迁移脚本。');
  process.exit(0);
}

console.log('');
console.log('=== 多租户用量与成本报表 ===');
console.log(`单价假设：输入 ¥${DEFAULT_PRICE.inPerMTok}/百万 token，输出 ¥${DEFAULT_PRICE.outPerMTok}/百万 token`);
console.log('  ⚠ 输出单价是假设值（官方价格页请自行校正），输入价有实测依据');
console.log('');

const rows = tenants.map((t) => {
  const u = readUsage(t.id);
  const q = t.quota || {};
  const tokens = u.tokensIn + u.tokensOut;
  const costIn = (u.tokensIn / 1_000_000) * DEFAULT_PRICE.inPerMTok;
  const costOut = (u.tokensOut / 1_000_000) * DEFAULT_PRICE.outPerMTok;
  return {
    tenantId: t.id,
    status: t.status || 'active',
    calls: u.calls,
    tokens,
    tokensIn: u.tokensIn,
    tokensOut: u.tokensOut,
    cost: costIn + costOut,
    perCall: u.calls > 0 ? (costIn + costOut) / u.calls : 0,
    dailyLimit: numOr(q.dailyCalls, DEFAULT_QUOTA.dailyCalls),
    monthlyLimit: numOr(q.monthlyTokens, DEFAULT_QUOTA.monthlyTokens),
    day: u.day,
  };
});

console.log(`${pad('租户', 14)}${pad('状态', 9)}${padL('今日调用', 14)}${padL('本月 token', 20)}${padL('本月成本', 12)}${padL('单次成本', 12)}`);
console.log('─'.repeat(82));
for (const r of rows) {
  console.log(
    pad(r.tenantId, 14) + pad(r.status, 9) + padL(`${r.calls} / ${r.dailyLimit}`, 14) +
    padL(`${r.tokens} / ${r.monthlyLimit}`, 20) + padL(yuan(r.cost), 12) + padL(yuan(r.perCall), 12)
  );
}

const totalCost = rows.reduce((a, r) => a + r.cost, 0);
const totalCalls = rows.reduce((a, r) => a + r.calls, 0);
const totalTokens = rows.reduce((a, r) => a + r.tokens, 0);

console.log('─'.repeat(82));
console.log(`${pad('合计', 14)}${pad('', 9)}${padL(`${totalCalls} 次`, 14)}${padL(`${totalTokens} token`, 20)}${padL(yuan(totalCost), 12)}`);

console.log('');
console.log('=== 月度外推（按今天的用量 × 30）===');
if (totalCalls === 0) {
  console.log('  今天还没有调用记录，没法外推。先跑几次 /api/kb/ask 或 /api/agent/run。');
} else {
  console.log(`  若每天都是今天的量：${totalCalls * 30} 次调用 / ${totalTokens * 30} token / ${yuan(totalCost * 30)}/月`);
  console.log(`  单次调用约 ${yuan(totalCost / totalCalls)}`);
}
console.log('');
console.log('=== 怎么用这些数字 ===');
console.log('  · 对客户：按租户报"包月额度 + 超额单价"，比按 token 原价转嫁更容易被接受');
console.log('  · 对自己：`单次成本` 决定免费额度能做多大');
console.log('  · 对运维：`今日调用/上限` 接近 1 时就该看是不是有人在滥用');
console.log('');
