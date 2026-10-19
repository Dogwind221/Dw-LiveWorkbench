# Agent + Function Calling 接口契约（冻结版 v1）

> 与 [`RAG-INTERFACE.md`](RAG-INTERFACE.md) 同等效力。任何一方不得单方面修改下列签名。
> 需要变更先在会话里提出，由 Lead 更新本文件并通知所有写入方。

## 0. 项目硬约束（继承 RAG 阶段）

- Node ≥ 20，ESM（`.mjs`），**零新增依赖**（`package.json` 的 `dependencies` 保持 `{}`）
- 中文注释，只写"为什么"
- 现有代码风格：`server/lib/*.mjs` 导出纯函数

## 1. 文件所有权（写入作用域，禁止越界）

| 归属 | 文件 |
| --- | --- |
| rag-core | `server/lib/llm.mjs`（**仅新增** tools 支持）、`server/lib/agent/tools.mjs` |
| eval | `scripts/agent-eval.mjs`、`data/eval/agent-scenarios.json` |
| lead | `server/lib/agent/loop.mjs`、`server/lib/handler.mjs`（只加路由）、`web/app.js`（只加面板）、`scripts/agent-smoke.mjs`、`README-agent.md`、本契约 |
| **只读** | `server/lib/rag/*`、`data/*.json`、`server/lib/deck/*`、`server/lib/compliance.mjs` |

## 2. 已实测的协议事实（探针证据，2026-10-17）

**不要重新验证这些，直接按此实现：**

| 事实 | 实测结果 |
| --- | --- |
| 通道 | `deepseek-flash`，base `https://api.deepseek.com/v1`，key 在 `providers.json` 的 `kind==="vision"` 条目 |
| 请求形状 | `POST /v1/chat/completions`，body 加 `tools:[...]`、`tool_choice:"auto"`、`thinking:{type:"disabled"}` |
| 响应形状 | `choices[0].message.tool_calls[]`，每项 `{id, type:"function", function:{name, arguments}}` |
| **`arguments` 是 JSON 字符串** | 必须 `JSON.parse`，且模型可能给 `"{}"` 或带多余空格的串 |
| `finish_reason` | 有工具调用 = `"tool_calls"`；结束 = `"stop"` |
| **并行调用** | 实测一次返回 **2 个** `tool_calls`，必须逐个执行后**全部**回传 |
| 回传形状 | `{role:"tool", tool_call_id:<id>, content:<字符串>}` |
| **必须禁用思考模式** | 否则：① `tool_choice` 强制会 400；② tool 轮次必须回传 `reasoning_content`，复杂度大增 |
| 成本 | 实测两轮共 527 token（含缓存命中 256） |

## 3. `server/lib/llm.mjs` 新增（rag-core）

现有 `chat` / `chatJson` **行为不得改变**（RAG 在用）。只做加法：

```js
/**
 * 带工具的一轮对话。**不做循环** —— 只发一次请求、回一次结果。
 * 循环由 agent/loop.mjs 负责，这里保持"一次调用"的纯粹性。
 *
 * @param {object} req
 * @param {Array} req.messages  OpenAI 格式；支持 role:"tool" 的消息
 * @param {Array} req.tools     [{type:'function', function:{name, description, parameters}}]
 * @param {'auto'|'none'} [req.toolChoice='auto']
 * @param {number} [req.maxTokens=1024]
 * @returns {Promise<ToolChatResult>}
 *
 * @typedef {object} ToolChatResult
 * @property {string} text                  模型的自然语言内容，可能为空串
 * @property {ToolCall[]} toolCalls         空数组表示模型没要求调工具（= 结束）
 * @property {'tool_calls'|'stop'|string} finishReason
 * @property {object} rawMessage            原始 assistant 消息，**必须能原样塞回 messages**
 * @property {object} meta                  {provider, model, attempts:[{provider,model,ok,ms,error?}], usage}
 *
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} args                 已 JSON.parse 的参数；解析失败时给 {}
 * @property {string} argsRaw              原始字符串，排错用
 * @property {string} [argsError]          解析失败的原因
 */
export function createLlm(providers?): { chat, chatJson, chatWithTools, providers }
```

要求：
- **`rawMessage` 必须保留 `reasoning_content` 等一切字段**，因为要原样回传（虽已禁用思考模式，但将来若开启，回传缺字段会 400）
- `arguments` 解析失败**不要抛错**：给 `args = {}` + `argsError`，让循环层决定怎么办
- 沿用现有 failover：一个模型失败换下一个；`thinking:{type:"disabled"}` 固定加上
- **key 绝不进日志/错误信息**（沿用 `maskSecret`）
- `toolCalls` 为空且 `text` 为空的响应要视为异常（避免循环层死转）

## 4. `server/lib/agent/tools.mjs`（rag-core）

工具注册表。**工具是数据的描述，不是代码逻辑** —— 每个工具就是 `{定义, 执行函数}`。

```js
/** 全部工具的元数据（不含执行函数），喂给模型的就是这个数组的 definition 部分 */
export function listToolDefs(): ToolDef[]

/** 按名字取工具；不存在返回 null（不要让循环层抛错，模型幻觉工具名是常态） */
export function getTool(name: string): Tool | null

/** @typedef {{name, definition: {type:'function', function:{name,description,parameters}},
 *             execute: (args: object, ctx: object) => Promise<ToolResult>}} Tool */

/** @typedef {{ok: boolean, data?: any, error?: string, summary: string, meta?: object}} ToolResult */
```

`ctx` 由循环层注入，当前只需要 `{ kb }`（已 loadKB 的结果，避免每个工具重复读盘）。

### 必须实现的 5 个工具（v1 就这 5 个，不要自行增加）

**① `search_knowledge`** —— 检索知识库（RAG 检索，**不调模型**）
```
parameters: { query: string(必填), k: integer(可选, 默认 5, 1..10) }
execute: 用 server/lib/rag/search.mjs 的 searchKnowledge(ctx.kb, query, {k})
data:    { hits: [{id, title, type, sourceId, snippet, score}] }
summary: "在知识库里找到 N 条相关片段" + 前 2 条的标题
说明:    工具描述里要写明"只检索、不生成答案"，避免模型以为它能回答
```

**② `check_compliance`** —— 检查一段话术的合规风险
```
parameters: { text: string(必填, 描述: 要检查的直播话术原文) }
execute: 用 server/lib/compliance.mjs 的 loadCompliance + checkText + summarize
data:    { level, score, hits:[{word, category, suggest, note}], warnings:[...], cleaned }
summary: "风险等级 X，命中 N 个违禁项" + 前 3 个词及其替换建议
说明:    这是**最有价值的工具**。description 要写清"返回违规词和可直接替换的说法"
```

**③ `build_live_deck`** —— 生成直播大纲 + 逐字稿
```
parameters: { topic: string(必填, 直播主题),
              durationMin: integer(可选, 15..240, 默认 60),
              purpose: string(可选, 场次类型),
              mountainName: string(可选, 山头名),
              productName: string(可选, 产品名) }
execute: 用 server/lib/deck/build.mjs 的 buildDeck 和 listOptions
data:    { title, durationMin, slideCount, scriptMinutes, verbatimCoverage, sections:[{title, minutes}] }
summary: "生成《标题》，N 页，逐字稿覆盖 X%"
说明:    **不要返回整篇稿子**（几万字会撑爆上下文）。只回结构和统计，
         正文由 loop 层另存到 output/ 并把文件名告诉模型。这一点必须写在 description 里。
```

**④ `list_mountains`** —— 列出知识库里的山头
```
parameters: { keyword: string(可选, 按名称/别名过滤) }
execute: 读 ctx.kb.mountains，按 keyword 过滤
data:    { total, items:[{id, name, region, alias}] }（最多 20 条）
summary: "共 N 个山头" + 前几个名字
```

**⑤ `get_live_sessions`** —— 历史直播场次
```
parameters: {}（无参）
execute: 用 server/lib/review.mjs 的 listSessions
data:    { total, items:[{id, title, date}] }（最多 10 条）
summary: "共 N 场" + 最近一场
```

### 写 `description` 的硬要求

**`description` 就是模型选择工具的唯一依据。** 每条必须写清三件事：
1. **做什么**（一句话，动宾结构）
2. **什么时候用**（"当用户问…时用这个"）
3. **返回什么 / 不返回什么**（尤其 `build_live_deck` 不返回全文这条）

反例（禁止）：`"查询知识库"`
正例：`"在普洱茶知识库里检索山头、茶品、合规知识片段。当用户询问某个山头的特征、产地、价格、冲泡方式，或需要为直播找素材时使用。只返回检索到的原文片段和出处，不会生成新内容。"`

### `execute` 的硬要求

- **参数缺失/类型错误要返回 `{ok:false, error:"..."}` 而不是抛异常** —— 模型会传错参数，循环层需要把错误喂回模型让它自己纠正
- 未知参数**忽略**，不要报错
- `data` 必须可 `JSON.stringify`（不能含循环引用、函数、undefined）
- 数值类参数要 clamp 到合法范围（如 `k` 超范围就夹到边界，而不是报错）
- **不许修改任何业务数据**（v1 全部工具都是只读或纯计算）：
  `build_live_deck` 只调 `buildDeck`（纯函数，不写盘）。**写盘由 loop 层做，不归工具。**

## 5. `server/lib/agent/loop.mjs`（lead）

```js
/**
 * ReAct 循环：模型决定调哪个工具 → 执行 → 回传 → 直到模型不再调工具
 *
 * @param {string} task  用户的自然语言任务
 * @param {object} [opts]
 * @param {number} [opts.maxSteps=8]      最大循环轮数（硬上限，防死循环烧钱）
 * @param {number} [opts.maxToolCalls=12] 单次运行的工具调用总数上限
 * @param {object} [opts.llm]             注入用（测试传 stub）
 * @param {object} [opts.ctx]             注入用（测试传假 kb）
 * @returns {Promise<AgentRun>}
 *
 * @typedef {object} AgentRun
 * @property {string} answer                最终自然语言答案
 * @property {Step[]} steps                 完整轨迹（可观测性）
 * @property {boolean} stopped              是否因达到上限而中止
 * @property {string} [stopReason]
 * @property {object} meta                  {steps, toolCalls, totalMs, usage, attempts}
 *
 * @typedef {object} Step
 * @property {number} n
 * @property {string} thought               模型的 text（可能为空）
 * @property {{name,args,ok,summary,ms,error}[]} toolCalls
 * @property {string} [note]
 */
export function runAgent(task: string, opts?): Promise<AgentRun>
```

要求：
- 系统提示词要写清：**能调工具就先调工具，不要凭记忆回答**；任务完成就停，不要无限调
- `maxSteps` / `maxToolCalls` 任一超限 → `stopped: true` + 明确的 `stopReason`，**不能静默截断**
- 工具不存在（模型幻觉函数名）→ 把错误喂回模型，**不算失败**，让它自己纠正
- 工具执行抛异常 → 捕获，同样喂回模型
- 每步记录 `ms`，`meta` 汇总 `usage`
- **并行 tool_calls 逐个执行**（v1 不做真并发，保持确定性；顺序执行便于复现和排错）
- 循环结束条件：`toolCalls.length === 0`（模型不再要工具）

## 6. HTTP 路由（lead，加在 `server/lib/handler.mjs`）

```
POST /api/agent/run    body: {task: string, maxSteps?: number}
  → 200 {answer, steps, stopped, stopReason, meta}
  → 400 {error:'BAD_TASK'}    task 非字符串或空
  → 503 {error:'NO_LLM'}      无可用模型通道
```

沿用 RAG 阶段定的约定：**返回对象带 `status` 字段即 HTTP 状态码**，dispatch 已支持。

## 7. 评测（eval）

`scripts/agent-eval.mjs` + `data/eval/agent-scenarios.json`。

**Agent 的测试方式和 RAG 完全不同 —— 不能测"答案像不像"，要测"行为对不对"。**

场景格式：
```json
{
  "version": 1,
  "scenarios": [
    { "id": "a01",
      "task": "帮我查一下倚邦的山场特征，然后看看'古六大茶山之一，汤水细腻'这句话能不能在直播间说",
      "expectTools": ["search_knowledge", "check_compliance"],
      "forbidTools": [],
      "maxSteps": 6,
      "expectAnswerContains": ["倚邦"],
      "note": "典型两步任务：先查资料再查合规" }
  ]
}
```

指标：
| 指标 | 定义 |
| --- | --- |
| `toolSelectionAccuracy` | `expectTools` 是否全部被调用（缺一个算失败） |
| `forbidViolations` | 调用了 `forbidTools` 里的工具的次数（**必须为 0**） |
| `stepEfficiency` | 实际轮数 / `maxSteps`，反映是否绕远路 |
| `stopCorrectness` | 是否在 `maxSteps` 内自然停止（`stopped:false`） |
| `answerPresent` | 最终是否有非空自然语言答案 |
| `crashRate` | 工具报错未被模型吸收导致运行失败的比例 |

要求：
- **≥ 12 个场景**，覆盖：单工具任务、多工具串行任务、不该调工具的任务（纯闲聊，`expectTools: []`）、
  参数缺失需模型自行补全的任务、模型可能幻觉工具名的任务
- `--offline` 模式：用 **stub llm**（脚本内自己造一个假的 `chatWithTools`，按场景返回预设的 tool_calls）
  验证**循环层和工具层**的正确性，**不烧 token、不需要网络**。这是主用法。
- 在线模式（不加 `--offline`）：真实调模型，报上面 6 个指标
- 退出码：`toolSelectionAccuracy ≥ 0.75` 且 `forbidViolations === 0` 才 0
- 遇到 agent 模块正在被编辑（import 失败）→ 退出码 3 并提示"等它稳定后重跑"

## 8. 完成标准（所有人）

- `node scripts/agent-smoke.mjs` 退出码 0（结构 + 循环 + 工具，用 stub，不调模型）
- `node scripts/agent-smoke.mjs --llm` 退出码 0（真实两轮工具闭环）
- `node scripts/agent-eval.mjs --offline` 退出码 0
- `node scripts/rag-smoke.mjs` / `rag-eval.mjs --offline` **不得回归**
- 不新增任何 npm 依赖
- 自己改的文件自己跑过再说完成
