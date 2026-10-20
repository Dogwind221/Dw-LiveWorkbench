# 写操作工具 + 权限确认（契约 v1）

> 这一章的核心问题：**LLM 不应该直接执行有副作用的操作。**
> 读工具出错只浪费一次调用；写工具出错会污染数据，而且往往是不可逆的。

## 0. 为什么要单独做一层，而不是"给工具加个确认参数"

如果由**模型**决定要不要确认，那等于没有权限控制 —— 它可以在参数里写 `confirmed: true`。
权限判断必须是**代码做的、模型无法伪造的**。

所以设计成两阶段提交：

```
第 1 次调用   模型 → save_faq(...)        → 代码【不执行】，生成 pending 动作 + actionId
                                         → 把"需要确认"和确切影响回传给模型
用户看界面   看到确切要写什么（diff）→ 点确认
第 2 次调用   带 approvals:[actionId] → 代码校验 actionId 是由同一份参数算出来的
                                     → 执行，写盘，记审计日志
```

**关键点：actionId 是由「工具名 + 规范化参数」算出的确定性哈希。**
- 模型在第二次调用时如果**改了参数**，actionId 就变了 → 不匹配 → 不给执行
- 所以"批准"批准的是**那一份确切内容**，不是"批准这个工具"

## 1. 文件所有权

| 归属 | 文件 |
| --- | --- |
| lead | `server/lib/agent/permissions.mjs`、`server/lib/agent/tools-write.mjs`、`server/lib/agent/loop.mjs`、`server/lib/agent/tools.mjs`（只加 export）、`server/lib/handler.mjs`、`web/app.js`、`scripts/agent-smoke.mjs`、`README-agent.md` |
| agent-eval | `data/eval/agent-scenarios.json`（加幻觉诱导场景 + 写操作场景）、`scripts/agent-eval.mjs` |

## 2. 权限模型

```js
/** 每个工具必须声明权限级别 */
tool.permission = 'read' | 'write'

/**
 * 一次运行的权限策略。
 * @typedef {object} PermissionPolicy
 * @property {string[]} [approvals]  已批准的动作 id 列表
 * @property {boolean} [allowWrites] 是否允许写（默认 true；false 时写工具一律拒绝）
 */
```

规则（严格按优先级）：

1. `allowWrites === false` → 写工具**一律拒绝**，返回 `{ok:false, error:'写入已被策略禁用'}`
2. 写工具的 `actionId` 在 `approvals` 里 → **执行**
3. 否则 → **不执行**，登记待确认动作，返回 `{ok:false, needsApproval:true, pending:{actionId, tool, args, impact}}`

## 3. `permissions.mjs`

```js
/** 由工具名 + 规范化参数算出确定性 id。同一份内容永远同一个 id。 */
export function actionIdOf(toolName: string, args: object): string

/**
 * 判断一个工具调用该怎么处理。
 * @returns {{decision:'execute'|'deny'|'confirm', reason?:string, actionId?:string}}
 */
export function decide({ tool, args, policy }): Decision

/** 登记一个待确认动作（内存 Map + 审计日志） */
export function registerPending(entry): void
export function listPending(): PendingAction[]
export function clearPending(actionId): void

/** 审计：每次权限判定都要留痕，无论执行还是拒绝 */
export function audit(record): void
export function listAudit(limit?: number): AuditRecord[]
```

要求：
- `actionIdOf` 必须**对参数做规范化排序**（keys 排序后再 hash），否则同一份内容 key 顺序不同会算出不同 id
- `actionIdOf` 用 `node:crypto` 的 `createHash('sha256')`，取前 16 位十六进制
- 审计日志写 `data/agent-audit.jsonl`（**JSONL 追加**，不覆盖历史）
- 审计记录**不含**任何敏感内容截断问题：要记完整参数，因为审计的意义就是事后能还原

## 4. `tools-write.mjs` —— 2 个写工具

### ① `save_faq` —— 把一条问答存进问答库

```
parameters: { question: string(必填), answer: string(必填), tags?: string[] }
权限:       write
写入目标:   data/faq.json（数组，追加）
```

**校验（全部在 execute 里做，不通过就 `{ok:false, error}`）：**
- `question` 长度 2–200 字；`answer` 长度 2–1000 字
- **去重**：与已有条目的 `q` 归一化后相同（去空格/标点/大小写）→ 拒绝，提示"已存在"
- 结构必须与现有 `faq.json` 条目一致（现有形状：`{id, q, a, enabled, tags}`）

**`impact`（给用户看的确认文案）必须包含：**
- "将向问答库**新增** 1 条"
- 问题原文 + 回答原文（截断到 200 字给确认面板看够）
- 当前条数 → 写入后条数
- ⚠️ 如果 `answer` 里含**合规风险词**（调 `checkText`），必须显式警告：
  `impact.warnings: ["回答里含违禁表述：「降三高」，上播前请改写"]` —— **这是这个工具最重要的防护**

### ② `update_deck` —— 修改已生成方案的一个字段

```
parameters: { deckId: string(必填), field: string(必填, 枚举), value: string(必填) }
权限:       write
写入目标:   data/decks/<deckId>.json
```

**只允许改白名单字段**，`field` ∈ `['title', 'durationMin']`：
- `title`：1–60 字
- `durationMin`：15–240 的整数

**严禁**允许改 `slides` / `script` / `sections` / `input` 等结构字段 ——
模型对结构的理解不可靠，改结构会把方案改坏，而且 `slides` 和 `script` 是**联动**的，
改一个不改另一个会让导出的 PPT 和稿子对不上。

**`impact` 必须包含：**
- 改动前后对比（`改前: "老班章专场"  →  改后: "老班章新品首发"`）
- 目标文件名
- 若 `deckId` 不存在 → 拒绝，并列出最近 3 个可用 id（帮模型自己改）

## 5. `loop.mjs` 的改动

```js
runAgent(task, { ..., policy: { approvals: [], allowWrites: true } })
```

返回结构新增：

```js
@typedef {object} AgentRun
@property {PendingAction[]} pending    本次运行中等待确认的动作（空数组表示没有）
```

循环里的顺序：
1. 取 `getTool(call.name)`
2. `const d = decide({ tool, args, policy })`
3. `execute` → 正常执行
4. `deny` → 回传 `{ok:false, error:'写入已被策略禁用'}`（模型应该改口说不做）
5. `confirm` → 回传 `{ok:false, needsApproval:true, actionId, impact}`，
   同时把 pending 收集进 `AgentRun.pending`
   **注意**：模型收到这个结果后应该停手，并在最终答案里请用户确认。
   如果模型还在继续调同一个写工具，循环层照常处理（每次都会是 confirm），
   但 `maxToolCalls` 会兜住。
6. 有 `pending` 时，即使模型给了最终答案，`AgentRun.pending` 也要带上 —— 前端靠它渲染确认卡片

**`ActionRun` 增加 `hasWrites` 字段**：本次运行是否涉及写工具（便于前端区分"只是查"和"要动手"）。

## 6. HTTP 层

```
POST /api/agent/run
  body: { task, maxSteps?, approvals?: string[], allowWrites?: boolean }
  → 200 { answer, steps, stopped, stopReason, artifacts, pending, meta }
  → 400 { error: 'BAD_TASK' }
  → 503 { error: 'NO_LLM' }

GET /api/agent/pending     → 当前所有待确认动作
GET /api/agent/audit?limit=50 → 最近的权限审计记录
```

**`/api/agent/tools` 要新增 `permission` 字段**，前端据此区分读写。

## 7. 前端

模块 4 增加：
- 工具列表每条带权限徽标：`读` / `写`
- 执行结果里，若有 `pending`，渲染**确认卡片**：
  - 显示 `impact` 里的所有内容（包括 `warnings` 用红色）
  - 一个"确认执行"按钮 → 带着 `approvals:[actionId]` **重新调用同一个 task**
  - 一个"取消"按钮 → 只清卡片
- **必须显著提示**："这个操作会改数据，确认前请核对内容"

## 8. 安全要求（这一节的每一条都要有测试）

| 要求 | 测试方式 |
| --- | --- |
| 未批准时**绝不能**写 | 断言 `data/faq.json` 文件内容在 confirm 后被调用前后**完全相同** |
| 批准**只对那一份内容**生效 | 批准 A 参数，然后拿 B 参数执行 → 必须仍然 confirm |
| `allowWrites:false` 时一律拒绝 | 断言返回 `deny` 且文件未变 |
| 同一动作重复批准要**幂等** | 同一 actionId 执行两次，数据只增加 1 条（或第二次返回"已存在"） |
| 审计必须留痕 | 每次 decide 后 `listAudit()` 都能查到 |
| `save_faq` 含违禁词要**警告** | 传"降三高"的回答，断言 `impact.warnings` 非空 |
| `update_deck` 改结构字段要**拒绝** | `field:'script'` → `{ok:false}` |
| 参数注入 | `deckId` 传 `"../../etc/passwd"` → 拒绝，不能路径穿越 |

## 9. 完成标准

- `node scripts/agent-smoke.mjs` 退出码 0（新增权限与写工具断言）
- `node scripts/agent-eval.mjs --offline` 退出码 0
- `node scripts/rag-smoke.mjs`、`rag-eval.mjs --offline`、`smoke.mjs` **不得回归**
- 上面 §8 的 8 条安全测试**全部要有对应断言**
- 零新增依赖
