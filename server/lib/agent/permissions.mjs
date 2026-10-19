/**
 * Agent 写操作的权限层。
 *
 * ## 这一层存在的理由
 *
 * 读工具出错只浪费一次调用；**写工具出错会污染数据，而且往往不可逆**。
 * 更危险的是：模型提议的写入是**基于它自己读到的内容**，而它可能读错了、
 * 也可能被用户的话诱导了。所以不能让模型直接执行有副作用的操作。
 *
 * ## 为什么不能"给工具加个确认参数"
 *
 * 如果由**模型**决定要不要确认，那等于没有权限控制 —— 它可以在参数里写
 * `confirmed: true` 绕过。**权限判断必须是代码做的、模型无法伪造的。**
 *
 * ## 两阶段提交
 *
 * ```
 * 第 1 次调用   模型 → save_faq(...)     → 代码【不执行】，生成 actionId
 * 用户确认       看到确切影响（diff）→ 点确认
 * 第 2 次调用   带 approvals:[actionId] → 代码校验 → 执行
 * ```
 *
 * **actionId 是由「工具名 + 规范化参数」算出的确定性哈希**，这是整个机制的关键：
 * - 模型第二次调用时如果**改了参数**，actionId 就变了 → 不匹配 → 不给执行
 * - 所以"批准"批准的是**那一份确切内容**，不是"批准这个工具"
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { agentAuditFile, dataDir } from '../paths.mjs';
import { currentTenantId, tenantContext, DEFAULT_TENANT } from '../tenant.mjs';
import { applySaveFaq, applyUpdateDeck } from './tools-write.mjs';

/**
 * 写工具名 → 落盘实现。
 *
 * 放在权限层而不是循环层，是为了让"确认执行"这条路径只依赖权限层：
 * 循环层和 HTTP 的 confirm 接口都用这一份映射，不会两处各写一遍而悄悄分叉。
 */
export const WRITE_APPLIERS = {
  save_faq: applySaveFaq,
  update_deck: applyUpdateDeck,
};
const AUDIT_KEEP = 2000;

/** 能发起写操作的角色。viewer 只能读。 */
const WRITE_ROLES = ['editor', 'approver'];

/**
 * 待确认动作表。
 *
 * **key 必须带租户前缀**，否则两个租户提出**参数完全相同**的写操作时会算出
 * 同一个 actionId，互相覆盖 —— 更糟的是 B 能确认 A 的动作。
 * （actionId 只是"工具名+参数"的哈希，不含租户，所以必须在这边补上隔离。）
 */
const pending = new Map();
const pendingKey = (tenantId, actionId) => `${tenantId}:${actionId}`;

/** 当前生效的租户（无上下文 = 本地模式 = default）。 */
const activeTenant = () => currentTenantId() || DEFAULT_TENANT;

/**
 * 当前角色。无上下文时返回 null（本地/CLI 场景，视为不受限）。
 *
 * 注意 `null` 和 `viewer` 必须区分：前者是"没有身份系统"（单用户本地），
 * 后者是"有身份但权限低"。混在一起会让本地模式被误拦。
 */
function currentRole(explicit) {
  return explicit ?? tenantContext()?.role ?? null;
}

/**
 * 把参数规范化成可比较的稳定形式。
 *
 * 必须做三件事，缺一个都会导致"同一份内容算出不同 id"：
 *   1. 对象 key 排序（`{a:1,b:2}` 和 `{b:2,a:1}` 必须同 id）
 *   2. 去掉 undefined（JSON.stringify 会直接丢，但显式处理更可预测）
 *   3. 数组保持顺序（顺序在语义上有意义，不能排序）
 */
function stable(o) {
  if (Array.isArray(o)) return o.map(stable);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) out[k] = stable(o[k]);
    }
    return out;
  }
  return o;
}

/**
 * 由工具名 + 规范化参数算出确定性 actionId。
 *
 * 取 16 位十六进制：足够避免碰撞，又短到能放进 UI 和日志。
 * 加 `agent-action-v1:` 前缀是为了将来改算法时能区分新旧 id。
 *
 * @param {string} toolName
 * @param {object} args
 */
export function actionIdOf(toolName, args) {
  const payload = `agent-action-v1:${toolName}:${JSON.stringify(stable(args || {}))}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 判断一次工具调用该怎么处理。
 *
 * 优先级严格固定，不要调换：
 *   1. 角色不够 → deny（viewer 连提议都不行）
 *   2. 策略禁用写入 → deny
 *   3. 已批准 → execute
 *   4. 其余写工具 → confirm
 *
 * @param {object} p
 * @param {object} p.tool   来自 getTool()
 * @param {object} p.args
 * @param {{approvals?: string[], allowWrites?: boolean, role?: string}} [p.policy]
 * @returns {{decision:'execute'|'deny'|'confirm', reason?:string, actionId?:string}}
 */
export function decide({ tool, args, policy = {} }) {
  const isWrite = tool?.permission === 'write';
  const actionId = isWrite ? actionIdOf(tool.name, args) : undefined;

  if (!isWrite) return { decision: 'execute' };

  // 角色检查放在最前面：viewer 连"发起提议"都不该有，否则会出现一个
  // 他能看见、但永远点不了确认的卡片 —— 那是误导。
  const role = currentRole(policy.role);
  if (role && !WRITE_ROLES.includes(role)) {
    return {
      decision: 'deny',
      actionId,
      reason: `当前角色 ${role} 不能发起写操作（需要 ${WRITE_ROLES.join(' 或 ')}）`,
    };
  }

  if (policy.allowWrites === false) {
    return { decision: 'deny', actionId, reason: '本次运行已禁用写入（allowWrites: false）' };
  }

  const approved = Array.isArray(policy.approvals) ? policy.approvals : [];
  if (actionId && approved.includes(actionId)) {
    return { decision: 'execute', actionId, reason: '已获批准' };
  }

  return { decision: 'confirm', actionId, reason: '写操作需要用户确认' };
}

/**
 * 登记待确认动作。同一个租户、同一个 actionId 重复登记时保留第一次的 impact。
 *
 * 注意这里显式记录 `tenantId`：后面 list/get/confirm 全靠它做隔离。
 */
export function registerPending(entry) {
  if (!entry?.actionId) return;
  const tenantId = activeTenant();
  const k = pendingKey(tenantId, entry.actionId);
  if (!pending.has(k)) {
    pending.set(k, { ...entry, tenantId, createdAt: new Date().toISOString() });
  }
}

/** 当前租户的待确认动作。**绝不返回别的租户的**。 */
export function listPending() {
  const tenantId = activeTenant();
  return [...pending.values()]
    .filter((p) => p.tenantId === tenantId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 按 actionId 取当前租户的待确认动作。跨租户拿不到。 */
export function getPending(actionId) {
  return pending.get(pendingKey(activeTenant(), actionId)) || null;
}

export function clearPending(actionId) {
  return pending.delete(pendingKey(activeTenant(), actionId));
}

/**
 * **执行一个已确认的动作。**
 *
 * 为什么是这个函数在做执行、而不是"带 actionId 重跑一遍 agent"：
 *
 * 实测发现模型对同一句话的两次生成**不完全一样** —— 一次问句带问号、一次不带，
 * 算出来的 actionId 就不同，于是"用户点了确认，但什么都没发生"。
 * 这个 bug 真实用户会 100% 撞上，而且极难解释。
 *
 * 根本原因是把"确认"实现成了"让模型重新提议一次"。正确做法是：
 * **确认时直接执行第一次已经校验过、并且给用户看过的那份参数。**
 * 这样用户批准的内容和执行的内容**在字节层面完全相同**，
 * 也不再有"模型这次参数不一样"的可能。
 *
 * @param {string} actionId
 * @param {Object<string, Function>} appliers  工具名 → 落盘实现
 * @param {{role?: string}} [opts]             角色（默认取当前上下文）
 */
export function confirmPending(actionId, appliers = WRITE_APPLIERS, opts = {}) {
  // 角色检查：只有 approver 能点确认。
  // editor 能"发起提议"但批不了 —— 这个分工让"提建议的人"和"拍板的人"分开。
  const role = currentRole(opts.role);
  if (role && role !== 'approver') {
    return {
      ok: false,
      error: `只有 approver 角色可以批准写操作，当前是 ${role}`,
      code: 'FORBIDDEN_ROLE',
    };
  }

  // 注意用 getPending（按租户找）：别的租户的 actionId 在这里查不到 → 404。
  // 这样"猜 actionId"跨租户也打不进来。
  const entry = getPending(actionId);
  if (!entry) {
    return { ok: false, error: '这个动作不存在或已过期，请重新发起请求', code: 'NO_PENDING' };
  }
  const apply = appliers[entry.tool];
  if (!apply) {
    return { ok: false, error: `写工具 ${entry.tool} 没有可用的落盘实现`, code: 'NO_APPLIER' };
  }

  let result;
  try {
    result = apply(entry.applyArgs || {});
  } catch (err) {
    audit({ kind: 'execute', tool: entry.tool, actionId, args: entry.applyArgs, ok: false, error: err.message });
    return { ok: false, error: `写入失败：${err.message}`, code: 'APPLY_FAILED' };
  }

  audit({
    kind: 'execute',
    tool: entry.tool,
    actionId,
    args: entry.applyArgs,
    ok: result?.ok !== false,
    error: result?.ok === false ? result.error : undefined,
  });
  if (result?.ok !== false) clearPending(actionId);
  return result?.ok === false
    ? { ok: false, error: result.error, code: 'APPLY_REJECTED' }
    : { ok: true, tool: entry.tool, actionId, result };
}

/* ------------------------------------------------------------------ *
 * 审计
 * ------------------------------------------------------------------ */

/**
 * 记一条审计。
 *
 * **每次权限判定都要留痕，无论最终执行还是拒绝。** 理由：追查"为什么数据被改坏了"
 * 时，只有成功写盘的记录是不够的 —— 你还需要知道"谁批准了、批的是哪份参数、
 * 有没有被拒过"。审计记录**不截断参数**，它的意义就是事后能完整还原。
 *
 * 多租户之后，审计还必须回答"**谁**"：`tenantId` / `actor` / `role` 三个字段
 * 由上下文自动补齐，**不接受调用方传入**（放在展开之后，防止被伪造）。
 * 企业追责问的是"谁批的"，不是"哪个租户批的"。
 */
export function audit(record) {
  const ctx = tenantContext();
  const line = {
    at: new Date().toISOString(),
    ...record,
    tenantId: ctx?.tenantId || DEFAULT_TENANT,
    actor: ctx?.userId || 'local',
    role: ctx?.role || 'unknown',
  };
  try {
    const file = agentAuditFile();
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    pruneAudit();
  } catch {
    // 审计失败不该阻断业务流程，但要尽力而为
  }
  return line;
}

/** 审计日志不能无限增长。保留最近 AUDIT_KEEP 行。 */
function pruneAudit() {
  try {
    const file = agentAuditFile();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= AUDIT_KEEP) return;
    fs.writeFileSync(file, `${lines.slice(-AUDIT_KEEP).join('\n')}\n`, 'utf8');
  } catch {
    /* 清理是尽力而为 */
  }
}

/** 读最近的审计记录（新的在前）。 */
export function listAudit(limit = 50) {
  try {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const lines = fs.readFileSync(agentAuditFile(), 'utf8').split('\n').filter(Boolean).slice(-n);
    return lines
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/** 测试用：清空待确认与审计文件 */
export function _resetForTest() {
  pending.clear();
  try { fs.unlinkSync(agentAuditFile()); } catch { /* 文件不存在 */ }
}
