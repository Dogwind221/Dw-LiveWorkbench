# DeepSeek API 通道能力实测报告

- **侦察日期**：2026-10-16（Asia/Hong_Kong）
- **被测通道**：`F:\dsh\直播工作台` 项目引用的 DeepSeek 通道
  - base：`https://api.deepseek.com/v1`
  - model：`deepseek-flash`
  - key 来源：`~/.dsh/dsh-vision-config/providers.json` 中 `kind === "vision"` 且 `base` 含 `api.deepseek.com` 的条目
- **方法**：全部结论来自本机真实 HTTP 请求（curl，原始响应落盘）+ DeepSeek 官方文档交叉核对
- **脱敏声明**：本报告及所有落盘证据中的 API key 一律记为 `sk-***`。报告中不含完整 key。
  文中的可复现命令统一用 `${DEEPSEEK_API_KEY}` 占位，由读者自己从配置文件注入。

---

## 0. TL;DR

| # | 问题 | 结论 | 证据类型 |
| --- | --- | --- | --- |
| 1 | key 还能用吗 | **能用**。`POST /v1/chat/completions` → **HTTP 200**，返回 `content: "OK"` | 实测 |
| 2 | `deepseek-flash` 有效吗 | **有效**。`GET /v1/models` → **HTTP 200**，可用模型仅 **2 个**：`deepseek-flash`、`deepseek-v4-pro` | 实测 |
| 3 | 官方有 embeddings 接口吗 | **不支持**。`POST /v1/embeddings` → **HTTP 404，响应体 0 字节**（不是 400/401，是路由不存在） | 实测 + 官方文档 |
| 4 | 支持 Function Calling 吗 | **支持**。返回标准 `tool_calls` 结构，`finish_reason: "tool_calls"`，可完成两轮工具回传闭环 | 实测 + 官方文档 |
| 5 | 支持 JSON 结构化输出吗 | **支持**。`response_format:{"type":"json_object"}` → 合法 JSON，`finish_reason: "stop"` | 实测 + 官方文档 |
| 6 | 替代方案 | **推荐 DashScope `text-embedding-v4`**（OpenAI 兼容，¥0.5/百万 token，北京地域**免费 100 万 token**）；零依赖 n-gram 方案在本项目语料上**实测术语查询 top-1 准确、口语化改写全库 0 分**（见 §6），建议作为**默认**、外部 embedding 作为**可选增强**。⚠️ 公开数据显示中文纯词法检索的 Recall@100 仅 **0.560**（dense 0.944），不要高估它的能力上限 | 实测原型 + 公开基准数据 + 官方文档 |

**对本项目最关键的三条**：

1. **官方无 embeddings ⇒ 项目契约里"向量通道"只能靠自研。** `RAG-INTERFACE.md` §3 要求的零依赖本地向量化不是权宜之计，而是当前唯一不破坏"零依赖"约束的路径。
2. **DeepSeek 通道对 RAG 生成端（`chatJson`）完全够用**：JSON 模式 + 工具调用都实测通过，且 `deepseek-flash` 输入低至 ¥1/百万 token（空闲时段），把整个知识库塞进 prompt 的成本可以忽略（¥0.05 量级）。
3. **⚠️ 但零依赖检索的能力上限比预期低，且"两路同源"会让 RRF 近乎无效。**
   公开数据：中文 BM25 的 nDCG@10 = 0.180 vs dense 0.512（**2.8 倍差距**），
   Recall@100 = 0.560 vs 0.944（§5.1）。
   本项目语料小且术语化，表现会明显更好，但**口语化查询会全库 0 分**（实测）。
   另：本项目 BM25 与向量两路都源自同一个字符 n-gram，**高度相关**，
   而真正互补的 BM25+dense 在中文上融合也仅涨 0.014 nDCG（§5.3）
   ⇒ **建议先验证 RRF 是否真有增益，再决定是否保留双通道。**

---

## 1. 复现环境与命令模板

所有命令在 Windows + PowerShell 7 下执行。先一次性把 key 注入环境变量（后续命令都用它，避免把 key 写进历史命令）：

```powershell
# 从 providers.json 读取 vision 通道的 key（不打印 key 本身）
$cfg = [System.IO.File]::ReadAllText("$env:USERPROFILE\.dsh\dsh-vision-config\providers.json", [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$p   = $cfg | Where-Object { $_.kind -eq 'vision' -and $_.base -like '*api.deepseek.com*' } | Select-Object -First 1
$env:DEEPSEEK_API_KEY = $p.apiKey
$env:DEEPSEEK_BASE    = $p.base      # https://api.deepseek.com/v1
"$($p.base) / $($p.model) / keylen=$($p.apiKey.Length)"
```

> **踩坑记录（会影响本项目实现）**：PowerShell 5.1 的 `Get-Content -Raw` 在本机默认代码页下会把
> `providers.json` 的中文读成乱码，导致 `ConvertFrom-Json` 直接抛
> `传入的对象无效，应为":"或"}"`。必须显式指定 UTF-8：
> `[System.IO.File]::ReadAllText(path, [System.Text.Encoding]::UTF8)` 或 `Get-Content -Raw -Encoding UTF8`。
> **`server/lib/llm.mjs` 读取该 providers.json 时必须显式 UTF-8**，否则会读失败。

---

## 2. 逐条实测记录

### 2.1 问题 1 —— key 是否有效

**请求**：

```powershell
$body = '{"model":"deepseek-flash","messages":[{"role":"user","content":"Reply with exactly OK"}],"max_tokens":64,"stream":false}'
curl.exe -s -w "`nHTTP=%{http_code}`n" -X POST "$env:DEEPSEEK_BASE/chat/completions" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" --data-binary $body
```

**结果**：`HTTP 200`

**响应片段（脱敏，原样截取）**：

```json
{"id":"9a674d64-c61c-4683-9a54-2880def25f3b","object":"chat.completion","created":1792149396,
 "model":"deepseek-flash",
 "choices":[{"index":0,"message":{"role":"assistant","content":"OK",
   "reasoning_content":"The user wants me to reply with exactly \"OK\". Simple."},
   "logprobs":null,"finish_reason":"stop"}],
 "usage":{"prompt_tokens":34,"completion_tokens":15,"total_tokens":49,
   "prompt_tokens_details":{"cached_tokens":0},
   "completion_tokens_details":{"reasoning_tokens":13},
   "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":34},
 "system_fingerprint":"aeb56401ca74e127821c4f9126dcb669"}
```

**结论**：**key 有效且可用**（HTTP 200，`content` 正是 `OK`）。请求头里的 key 未出现在响应里。

**同时确认的错误形态**（用于实现错误分支）：

| 场景 | 命令要点 | 状态码 | 响应 |
| --- | --- | --- | --- |
| 无效 key | `-H "Authorization: Bearer sk-invalid000..."` | **401** | `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid (request_id: ...)","type":"authentication_error","param":null,"code":"invalid_request_error"}}` |
| 不存在的模型名 | `"model":"nope-does-not-exist"` | **400** | `{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed nope-does-not-exist. (request_id: ...)","type":"invalid_request_error",...}}` |

> 注意：服务端的 401 只回显 key 的**后 4 位**（`****0000`），本身已脱敏。

**★ 一个必须注意的坑（实测）**：`deepseek-flash` **默认开启思考模式**（`reasoning_effort` 默认 `high`）。
第一次用 `max_tokens:16` 请求"只回复 OK"时，16 个 token 全被 `reasoning_content` 吃掉，
`content` 返回**空字符串**且 `finish_reason: "length"`：

```json
{"choices":[{"index":0,"message":{"role":"assistant","content":"",
  "reasoning_content":"We need answer user. User says \"??? OK\". Need infer context? There"},
  "finish_reason":"length"}],"usage":{"completion_tokens":16,"completion_tokens_details":{"reasoning_tokens":16}}}
```

⇒ **本项目 `llm.mjs` 若把 `maxTokens` 设得过小（如 <64），会拿到空 `content`**。
建议：要么把默认 `maxTokens` 提到 512+，要么在只需要短输出时显式
`"thinking":{"type":"disabled"}`（见 §5.3）。

---

### 2.2 问题 2 —— `deepseek-flash` 是否有效 / 可用模型列表

**请求**：

```powershell
curl.exe -s -w "`nHTTP=%{http_code}`n" "$env:DEEPSEEK_BASE/models" -H "Authorization: Bearer $env:DEEPSEEK_API_KEY"
```

**结果**：`HTTP 200`，完整响应（这是**该 key 实际可用的全部模型**）：

```json
{"object":"list","data":[
 {"id":"deepseek-flash","object":"model","owned_by":"deepseek","name":"DeepSeek-V4.1-Flash",
  "context_window":1048576,"max_output_tokens":393216,
  "input_modalities":["text","image"],"output_modalities":["text"],
  "effort":{"supported_levels":["low","high","max"],"default_level":"high"},
  "api_capabilities":{"anthropic_messages":{"system_prompt_update":"in-history"}}},
 {"id":"deepseek-v4-pro","object":"model","owned_by":"deepseek","name":"DeepSeek-V4-Pro",
  "context_window":1048576,"max_output_tokens":393216,
  "input_modalities":["text"],"output_modalities":["text"],
  "effort":{"supported_levels":["low","high","max"],"default_level":"high"},
  "api_capabilities":{"anthropic_messages":{"system_prompt_update":"leading-only"}}}
]}
```

**可用模型列表（实测，共 2 个）**：

| model id | 显示名 | 上下文 | 最大输出 | 输入模态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1,048,576 | 393,216 | text + **image** | 唯一支持图像理解的模型 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1,048,576 | 393,216 | text | 更强、更贵 |

**结论**：`deepseek-flash` **有效**，是官方当前推荐模型名。
官方文档 [首次调用 API](https://api-docs.deepseek.com/zh-cn/) 明确：
「模型名请使用 `deepseek-flash`。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，
但对应模型已下线，请求将由 DeepSeek-V4.1-Flash 模型提供服务，并按 Flash 价格计费。」

⇒ 列表里**没有** embedding 类模型，这是问题 3 的第一条旁证。

---

### 2.3 问题 3 —— 官方是否提供 embeddings 接口（关键项）

**请求（三组，覆盖所有可能的路径/参数写法）**：

```powershell
# A. 标准 OpenAI 路径
curl.exe -s -D hdr.txt -o body.bin -w "HTTP=%{http_code} size=%{size_download}`n" `
  -X POST "$env:DEEPSEEK_BASE/embeddings" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" `
  -d '{"model":"deepseek-embedding","input":"hello world"}'

# B. 不带 /v1 前缀
curl.exe -s -o NUL -w "HTTP=%{http_code} size=%{size_download}`n" -X POST "https://api.deepseek.com/embeddings" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" `
  -d '{"model":"deepseek-embedding","input":"hello world"}'

# C. 换模型名 / 加参数，排除"参数不对"的可能
curl.exe -s -o NUL -w "HTTP=%{http_code} size=%{size_download}`n" -X POST "$env:DEEPSEEK_BASE/embeddings" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" `
  -d '{"model":"deepseek-embedding-v1","input":["a","b"],"encoding_format":"float","dimensions":1024}'
```

**结果：全部 `HTTP 404`，且响应体 `size=0`（0 字节）。**

| 请求 | 状态码 | 响应体大小 |
| --- | --- | --- |
| `POST /v1/embeddings`（`deepseek-embedding`） | **404** | 0 字节 |
| `POST /v1/embeddings`（`deepseek-flash` 当 embedding 用） | **404** | 0 字节 |
| `POST /embeddings`（无 `/v1`） | **404** | 0 字节 |
| `POST /beta/embeddings` | **404** | 0 字节 |
| `POST /v1/embeddings` + `encoding_format/dimensions` | **404** | 0 字节 |
| `POST /v1/rerank` | **404** | 0 字节 |
| `GET /v1/embeddings` | **404** | 0 字节 |
| `POST /v1/nonexistent-path-xyz`（对照） | **404** | 0 字节 |

**原始响应头（证明是网关层路由缺失，而非业务层报错）**：

```
HTTP/1.1 404 Not Found
Server: openresty
vary: origin, access-control-request-method, access-control-request-headers
access-control-allow-credentials: true
x-ds-trace-id: c2b996795f68e2a28fb1e88bfa5fd494
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Content-Length: 0
Connection: keep-alive
Date: Fri, 16 Oct 2026 11:16:49 GMT
EO-Cache-Status: MISS
```

**为什么这个 404 是有力证据**：同一通道下，**模型名错误**返回的是 **400 + 结构化 JSON 错误**
（`The supported API model names are deepseek-flash, deepseek-v4-pro...`），
**key 错误**返回的是 **401 + 结构化 JSON**。
而 `/v1/embeddings` 返回的是 **404 + 0 字节**，与访问任意不存在的路径
（`/v1/nonexistent-path-xyz`）**完全一致** —— 说明 `/embeddings` 路由**根本没有注册**，
而不是"参数不对""模型不存在""没权限"。这是"接口不存在"的判定，不是猜测。

**官方文档交叉核对（五重证据）**：

1. 官方文档侧边栏**没有任何 embeddings / 向量页面**：
   完整页面清单为 [首次调用 API](https://api-docs.deepseek.com/zh-cn/) /
   [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) / Token 用量计算 /
   限速与隔离 / 错误码 / 图像理解 / [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) /
   多轮对话 / 对话前缀续写 / FIM 补全 / [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode) /
   [Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) / Files API /
   上下文硬盘缓存 / Responses API / Anthropic API。
2. **官方 sitemap 里零条 embedding 路径**：
   [英文 sitemap](https://api-docs.deepseek.com/sitemap.xml) 与
   [中文 sitemap](https://api-docs.deepseek.com/zh-cn/sitemap.xml) 均无 embedding 相关条目。
3. **API 参考侧栏只有对话类端点**：
   [create-chat-completion](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion) 侧栏仅
   Chat Completions、Responses、FIM Completion (Beta)、Lists Models、Get User Balance、Files。
   直接访问 `/zh-cn/api/create-embeddings` 会**回落到《首次调用 API》**，即该文档页不存在。
4. [模型 & 价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 的功能对照表只列
   对话模型的两列（`deepseek-flash`、`deepseek-v4-pro`），**没有 embeddings 产品行**，
   全文也无 embedding/向量相关字样；`GET /v1/models` 的 `output_modalities` 只允许 `text`。
5. 社区同结论：GitHub 上 DeepSeek 官方仓库 issue
   [「there is no dedicated embedding for any of the deep seek models」](https://github.com/deepseek-ai/DeepSeek-V3/issues/806)。

> **结论：DeepSeek 官方通道不提供 embeddings 接口。实测返回 404（Content-Length: 0），
> 文档侧栏 / sitemap / API 参考 / 模型列表 / 社区 五方一致。本项目不能把向量化寄托在 DeepSeek 通道上。**
> 网络上出现的「DeepSeek embedding 插件/包」均为第三方自行封装（多为本地小模型或转发其他厂商），
> **不应作为官方能力依赖**。

**顺带实测到的其他真实能力边界**（供 `llm.mjs` 参考）：

| 端点 | 状态码 | 含义 |
| --- | --- | --- |
| `GET /v1/files` | **200** | Files API 存在，本机 key 下已有大量 `user_data` 文件 |
| `POST /v1/files`（`purpose=batch`） | **400** | `The 'batch' purpose is not supported. Supported purposes: ["user_data"]` ⇒ 只支持 `user_data`，不支持 batch |
| `GET /v1/batches` | **404** | 无 Batch API |
| `GET /beta/chat/completions` | **405** | `/beta` 前缀存在但只接受 POST（`strict` 模式走这里） |

---

### 2.4 问题 4 —— Function Calling / tool calls

**请求（定义 `get_time` 工具，让模型调用）**：

```powershell
$tools = '{"model":"deepseek-flash",
 "messages":[{"role":"user","content":"What is the current time in Asia/Shanghai? Use the tool."}],
 "tools":[{"type":"function","function":{"name":"get_time",
   "description":"Get current time for a timezone",
   "parameters":{"type":"object",
     "properties":{"timezone":{"type":"string","description":"IANA timezone"},
                   "format":{"type":"string","enum":["iso8601","human"]}},
     "required":["timezone"]}}}],
 "tool_choice":"auto","max_tokens":256,"stream":false}'
curl.exe -s -w "`nHTTP=%{http_code}`n" -X POST "$env:DEEPSEEK_BASE/chat/completions" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" --data-binary $tools
```

**结果**：`HTTP 200`，返回标准 `tool_calls` 结构，**并且一次返回了两个并行调用**：

```json
{"model":"deepseek-flash",
 "choices":[{"index":0,"message":{
   "role":"assistant",
   "content":"I'll check the current time in Asia/Shanghai for you.",
   "reasoning_content":"The user wants the current time in Asia/Shanghai. I should call the get_time tool...",
   "tool_calls":[
     {"index":0,"id":"call_00_huNKqt1ydBfdkWUNErNq3153","type":"function",
      "function":{"name":"get_time","arguments":"{\"timezone\": \"Asia/Shanghai\", \"format\": \"human\"}"}},
     {"index":1,"id":"call_01_HPIldVtcqp0cqQrn9OJq0314","type":"function",
      "function":{"name":"get_time","arguments":"{\"timezone\": \"Asia/Shanghai\", \"format\": \"iso8601\"}"}}]},
   "finish_reason":"tool_calls"}],
 "usage":{"prompt_tokens":335,"completion_tokens":213,"total_tokens":548}}
```

**结构确认**：`message.tool_calls[]` 含 `id` / `type: "function"` / `function.name` /
`function.arguments`（JSON **字符串**，需自行 `JSON.parse`），`finish_reason` 为 `"tool_calls"`。
**支持并行工具调用**（同一条消息里 2 个 `tool_calls`）。

**★ 闭环实测（真正的 agent loop）—— 两个必须知道的坑**：

**(a) 默认思考模式下，工具轮次的 `reasoning_content` 必须回传，否则 400。**

把 `tool` 结果回传、但 assistant 消息里不带 `reasoning_content` 时：

```
HTTP 400
{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 6e5f4e87-...)"}}
```

思考模式下也不支持强制指定工具：

```
HTTP 400
{"error":{"message":"Thinking mode does not support this tool_choice (request_id: 980832e9-...)"}}
```

**(b) 显式关闭思考模式后，标准两轮闭环完全跑通（HTTP 200）。**

`"thinking":{"type":"disabled"}` + 强制 `tool_choice` → 正确产出 `tool_calls`：

```json
{"choices":[{"index":0,"message":{"role":"assistant","content":"",
  "tool_calls":[{"index":0,"id":"call_00_Q3rNJ2Vqrk7zOOMgwJ3f1364","type":"function",
    "function":{"name":"get_time","arguments":"{\"timezone\": \"Asia/Shanghai\"}"}}]},
  "finish_reason":"tool_calls"}]}
```

再把 `{"role":"tool","tool_call_id":"call_01...","content":"2026-10-16T11:20:00+08:00"}` 追加进去
→ **HTTP 200**，模型给出自然语言答案：

```json
{"choices":[{"index":0,"message":{"role":"assistant",
  "content":"The current time in Asia/Shanghai is **2026-10-16 11:20:00 (UTC+8)**."},
  "finish_reason":"stop"}],
 "usage":{"prompt_tokens":350,"completion_tokens":28,"total_tokens":378,
   "prompt_cache_hit_tokens":128,"prompt_cache_miss_tokens":222}}
```

**结论：支持 Function Calling，且支持并行工具调用与完整多轮闭环。**
官方文档 [Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) 确认，
并额外说明：**`strict` 模式（Beta）** 可让模型严格遵循 JSON Schema，需用
`base_url="https://api.deepseek.com/beta"` 且每个 function 设 `"strict": true`。

**对本项目的直接影响**：

- `llm.mjs` 的 `chatJson` 走 `response_format` 就够（§2.5），**不必用 tool calls**；
  若将来要做"让模型自己决定检索还是直答"，用 tool calls 时**建议显式关闭思考模式**
  （`thinking:{type:"disabled"}`），否则要完整回传 `reasoning_content`，实现复杂度显著上升。
- 思考模式下的 `temperature` / `presence_penalty` / `frequency_penalty` **不生效**
  （[思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)：设置不报错但不生效）。
  `RAG-INTERFACE.md` §6 里 `ChatRequest.temperature` 默认 `0.2` 在默认思考模式下**无效**。
  RAG 场景要稳定输出，应关闭思考模式或改用 `top_p`（思考模式仅支持 0.95–1.0）。

---

### 2.5 问题 5 —— JSON 结构化输出

**请求**：

```powershell
$j = '{"model":"deepseek-flash",
 "messages":[{"role":"user","content":"Return a JSON object with keys name and age for a person named Ada aged 36. Output JSON only."}],
 "response_format":{"type":"json_object"},"max_tokens":512,"stream":false}'
curl.exe -s -w "`nHTTP=%{http_code}`n" -X POST "$env:DEEPSEEK_BASE/chat/completions" `
  -H "Authorization: Bearer $env:DEEPSEEK_API_KEY" -H "Content-Type: application/json" --data-binary $j
```

**结果**：`HTTP 200`，`content` 是合法 JSON（可被 `JSON.parse`）：

```json
{"model":"deepseek-flash",
 "choices":[{"index":0,"message":{"role":"assistant",
   "content":"{\"name\":\"Ada\",\"age\":36}",
   "reasoning_content":"We need answer only JSON. Need comply. Keys name and age..."},
   "finish_reason":"stop"}],
 "usage":{"prompt_tokens":74,"completion_tokens":45,"total_tokens":119,
   "completion_tokens_details":{"reasoning_tokens":35}}}
```

**结论：支持 `response_format: {"type":"json_object"}`**，
官方文档 [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode) 确认。

**文档给出的两条硬性注意（对本项目 `chatJson` 实现是 must-fix）**：

1. **prompt 里必须出现 `json` 字样**，并给出期望的 JSON 样例。
   ⇒ `llm.mjs` 的 `chatJson` **必须在 system prompt 里带上 "JSON" 和 schema 样例**，
   否则模型没有被约束。`RAG-INTERFACE.md` §6「解析失败要重试一次，并提示"只输出 JSON"」
   正好符合官方建议。
2. **官方明确警告**：「在使用 JSON Output 功能时，API 有概率会返回空的 content」。
   ⇒ 重试逻辑不能省，且**重试前必须判空**，不能只 catch `JSON.parse` 异常
   （空字符串会让 `JSON.parse` 抛错，所以 catch 能覆盖，但错误信息要能区分"空 content"）。

**`strict` 模式**（额外发现，可选）：若想要 schema 级强约束，可用
`base_url="https://api.deepseek.com/beta"` + tool 定义里 `"strict": true`
（官方 [Tool Calls 文档](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) §strict 模式）。
注意 `strict` 会校验 JSON Schema，且**所有 object 属性都必须 `required` 且
`additionalProperties: false`**。本项目零依赖、只要 JSON 对象，用
`json_object` 模式已足够，**不建议**为了 strict 引入 beta base 的额外复杂度。

---

## 3. 本项目语料的实测基线（用于判断"够不够用"）

为了让 §6 的建议有据可依，先量了本项目自己的语料（只读，未修改任何数据文件）：

| 文件 | 大小 | 结构 |
| --- | --- | --- |
| `data/knowledge.json` | 88,609 字符 | `regions` 4 条、`mountains` **44** 条、`products` **38** 条、`tags` 16、`topics` 4 |
| `data/compliance.json` | 45,902 字符 | `categories` **12** 条（含 `words` 违禁词数组）、`patterns` 17（regex）、`contextRules` 10 |
| 合计 | ≈ **134 KB / 约 6.8 万汉字** | 按 `buildChunks` 粒度切分后约 **90–150 个 passage** |

**这个规模非常小**：134 KB ≈ 约 5 万 token。
- 全部塞进 `deepseek-flash` 单次 prompt 的成本（输入 ¥1/百万，空闲时段）≈ **¥0.05**。
- 用外部 embedding 建一次索引（94 个 passage × 各约 236 字）≈ 1.5 万 token
  ≈ **¥0.0075**，且可完全落在百炼的 100 万 token 免费额度内（≈ **¥0**）。

⇒ 本项目**不存在"向量库太大必须上专业 embedding"的成本压力**，
选型可以纯粹按"复杂度 / 零依赖约束 / 质量"来定。
⇒ 另外由于语料只有 ~5 万 token，**"用 LLM 做 rerank 或 query 改写"这种以 LLM 换语义的方案
在本项目成本极低**（单次查询成本在 ¥0.0001 量级），这是当前约束下最值得尝试的语义增强方向（见 §6.3 第 6 条）。

---

## 4. 替代方案对比表

### 4.1 总览

| 方案 | 需要新 key | 需要新依赖 | 中文检索质量 | 成本（本项目 ~1.5 万 token 建索引） | 离线可用 | 推荐度 |
| --- | --- | --- | --- | --- | --- | --- |
| **本地字符 n-gram + TF-IDF/BM25**（`RAG-INTERFACE.md` 既定方案） | 否 | 否（纯 JS） | 词面命中好，**语义改写弱**（实测见 §6） | **¥0** | ✅ | ⭐⭐⭐⭐⭐ 作为默认 |
| **DashScope `text-embedding-v3`**（OpenAI 兼容） | 需阿里云百炼 key | 否（`fetch` 即可） | 强 | ≈ **¥0.0075**，且**首 100 万 token 免费**（90 天，仅北京地域） | ❌ | ⭐⭐⭐⭐ 作为可选增强 |
| **DashScope `text-embedding-v4`**（Qwen3-Embedding） | 需阿里云百炼 key | 否 | 更强，100+ 语种，维度 64–2048 | ≈ ¥0.0075（¥0.5/百万），**首 100 万 token 免费** | ❌ | ⭐⭐⭐⭐⭐ 首选 |
| **智谱 `embedding-3`** | 需智谱 key | 否 | 强，维度 256–2048 可自定义，**单次最多 64 条** | ≈ **¥0.0075**（¥0.5/百万） | ❌ | ⭐⭐⭐⭐ 备选 |
| **硅基流动 BAAI/bge-m3 等** | 需 SiliconFlow key | 否 | 强（多语种） | 价格/免费额度**未查证到** | ❌ | ⭐⭐⭐ 备选 |
| **transformers.js / `@xenova/transformers` 本地模型** | 否 | **是**（违反硬约束） | 强 | ¥0（但首次下载模型 ~100MB+） | ✅ | ❌ 仅在放开依赖约束时可选 |

### 4.2 阿里云百炼 DashScope

来源：[OpenAI Embedding 接口兼容（官方文档，页面更新于 2026-10-11）](https://www.alibabacloud.com/help/zh/model-studio/embedding-interfaces-compatible-with-openai)

**OpenAI 兼容 base_url**（注意官方已推行业务空间专属域名）：

| 地域 | 推荐 base_url | 旧域名（仍可用） |
| --- | --- | --- |
| 新加坡 | `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| 华北2（北京） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 中国香港 | `https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/compatible-mode/v1` | `https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1` |

> `{WorkspaceId}` 在百炼控制台「业务空间详情」里取。**没有业务空间 ID 时，用旧域名
> `https://dashscope.aliyuncs.com/compatible-mode/v1` 仍然可用**（官方原文："现有域名仍可正常使用"）。
> 这一点对本项目很重要：**旧域名是固定字符串，不需要额外配置项**。

**接口**：`POST {base_url}/embeddings`，`Authorization: Bearer $DASHSCOPE_API_KEY`，body：

```json
{"model":"text-embedding-v4","input":"待向量化文本","encoding_format":"float","dimensions":1024}
```
> 本项目 passage 只有 236 字左右，`dimensions` 压到 512 或 256 即可省一半以上存储，
> 且对 94 个 passage 这种小库，降维带来的召回损失可以忽略。

**说明**：若采用 DashScope，**推荐 `text-embedding-v4` 而不是 v3**（同价、更强、维度范围更宽）。
下表把 v3 一并列出是为了让读者知道它仍在售且同价。

**模型参数与价格（中国内地 / 华北2（北京）地域）**：

| 模型 | 向量维度 | 单次最大行数 | 单行最大 token | 单价（每千输入 token） | 免费额度（北京） |
| --- | --- | --- | --- | --- | --- |
| `text-embedding-v4`（Qwen3-Embedding 系列） | 2048 / 1536 / 1024（默认）/ 768 / 512 / 256 / 128 / 64 | **10** | 8,192 | **¥0.0005**（Batch ¥0.00025） | **100 万 token**，90 天 |
| `text-embedding-v3` | 1024（默认）/ 768 / 512 / 256 / 128 / 64 | **10** | 8,192 | **¥0.0005**（Batch ¥0.00025） | **100 万 token**，90 天 |
| `qwen3.7-text-embedding` | 2560 / 2048 / 1536 / 1024（默认）/ 768 / 512 / 256 | **20** | **128,000** | ¥0.0005 | 100 万 token |
| `qwen3.7-text-embedding-flash` | 1024 / 768 / 512 / 256 | 20 | — | **¥0.000125**（Batch ¥0.000063） | 100 万 token |
| `text-embedding-v2` | 1536 | 25 | 2,048 | ¥0.0007 | 50 万 token |

- **`text-embedding-v4` 确实存在**，属 Qwen3-Embedding 系列，支持 100+ 语种，
  维度可选范围最宽（64–2048），**价格与 v3 相同**（¥0.5/百万）。
  ⇒ 本项目若要用，**直接选 v4**，没有理由选 v3。
- **免费额度更正**：官方[新人免费额度页](https://help.aliyun.com/zh/model-studio/new-free-quota)
  明确「每个模型均有独立的免费额度（通常为 **100 万 Token**）」，且
  **仅华北2（北京）地域享有免费额度，其他地域无**。
  ⇒ v3 与 v4 **各自** 100 万 token（不是共用的 50 万）。本项目约 1.5 万 token 建索引，
  **用免费额度即可覆盖，实际花费为 0**。
- **免费额度的三个陷阱**：① **Batch 调用不抵扣免费额度**；
  ② 有效期 90 天，**不补发、不延期**；③ 未实名用户额度耗尽后无法继续调用
  （返回 HTTP 403 `AllocationQuota.FreeTierOnly`），已实名用户会自动转按量付费。
- **额度单位抄写提醒**：中国内地表头单位是**「每千输入 Token」0.0005 元**（= ¥0.5/百万）；
  新加坡/北京/香港英文页表头单位是**「每百万输入 Token」$0.07 / $0.072**。数值一致，别读错量级。

**★ 一个对 RAG 质量有实质影响的差异（OpenAI 兼容接口做不到）**：
- **OpenAI 兼容接口只支持 `model` / `input` / `dimensions` / `encoding_format`**，
  **不支持 `text_type` 和 `instruct`**。
- **原生 DashScope 接口额外支持 `text_type`（`query` / `document`）与 `instruct`（自定义指令）**，
  官方建议**检索类非对称任务区分 query/document**。
  ⇒ 对 RAG 而言，"把 query 和 document 用不同方式编码"是标准且有效的做法。
  **如果本项目将来要接 DashScope 并追求检索质量，值得考虑走原生 DashScope 接口
  （`POST .../api/v1/services/embeddings/text-embedding/text-embedding`，
  body 为 `input.texts[]` + `parameters{}`）而不是 OpenAI 兼容接口**，
  代价是实现多一层适配（但仍是纯 `fetch`，不新增依赖）。
- **稀疏向量只能用原生接口**：OpenAI 兼容接口传 `output_type=sparse`
  会**返回 HTTP 200 但 embedding 为空**（静默失败，需在实现里做维度/非空校验兜底）。
- 限流（北京）：RPM 1800 / TPM 1,200,000。

**优点**：
- 真 OpenAI 兼容，本项目只要有个 `fetch` 就能调，**零 npm 依赖**。
- **有免费额度**（北京地域 v3/v4 各 100 万 token，90 天），本项目约 1.5 万 token 建索引
  ⇒ **实际花费几乎是 0**。
- 价格极低（¥0.5/百万），且 v4 质量强、100+ 语种；追求极致低成本还有
  `qwen3.7-text-embedding-flash`（¥0.125/百万）。

**缺点 / 风险**：
- **需要新 key**（阿里云百炼 API Key）和新账号开通，**违反"不新增外部依赖"的精神**（虽不违反 npm 约束）。
- **单次最多 10 行输入** ⇒ 94 个 passage 需要**至少 10 次请求**（本项目需实现分批，不要一次传 94 条）。
  （智谱 `embedding-3` 单次上限 64 条，这一点上比 DashScope 友好。）
- **离线不可用**，且引入网络失败分支（而当前设计是纯本地索引）。
- **免费额度只有北京地域有**；若用新加坡/香港地域，则无免费额度（但单价仍极低）。
- **`text_type`（query/document 非对称编码）在 OpenAI 兼容接口上不可用**，见上。

**是否需要新依赖**：不需要。
**是否需要新 key**：**需要**（这是主要代价）。

### 4.3 智谱 GLM（`embedding-3`）

来源：[Embedding-3 官方文档](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)

| 项 | 值 |
| --- | --- |
| 模型 id | `embedding-3`（前代 `embedding-2` 仍可用，维度固定 1024、单条 ≤512 token） |
| 价格 | **0.5 元 / 百万 Tokens**（Batch API 折半 **0.25 元/百万**） |
| 上下文窗口 | **8K**（`embedding-3` 单条 ≤3072 token） |
| 向量维度 | `embedding-3` 默认 **2048**；官方 OpenAPI enum 为 **2048 / 1024 / 512 / 256** |
| 批量上限 | **数组最多 64 条**（比 DashScope 的 10 条宽松很多） |
| endpoint | `POST https://open.bigmodel.cn/api/paas/v4/embeddings`，`Authorization: Bearer <API Key>` |
| OpenAI 兼容 | **是**。base_url **`https://open.bigmodel.cn/api/paas/v4/`**，embeddings 的请求/响应 schema 与 OpenAI 一致（`object:"list"`、`data[].object:"embedding"`） |
| 输入类型/指令 | **不支持** `text_type`、**不支持** `instruct` |
| 并发限制（在途请求） | V0 50 / V1 100 / V2 300 / V3 500 |

来源：[Embedding-3 官方文档](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)、
[OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)、
[文本嵌入 API 参考](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E5%B5%8C%E5%85%A5)。

**优点**：价格与 DashScope 同级（¥0.5/百万）；**base_url 是固定字符串，不需要业务空间 ID**
（比 DashScope 的新域名省一个配置项）；**单次 64 条上限**，94 个 passage 只需 2 次请求；
维度可自定义；中文语义质量属第一梯队；智谱另有
[知识库服务](https://docs.bigmodel.cn/cn/guide/tools/knowledge/price)可作托管方案。

**缺点 / 风险**：
- **需要新 key**（智谱开放平台 API Key）。
- **不支持 `text_type`（query/document 非对称编码）**，RAG 检索质量上不如 DashScope 原生接口。
- **官方文档内部不一致**：模型页写维度「256–2048 可自定义」，但 OpenAPI enum 只列
  `2048/1024/512/256`，Java 示例却用了 `768`。
  ⇒ **实现时只传 enum 内的 4 个值**（2048/1024/512/256），不要用 768 等未确认值。
- 本次**未查证到**其免费额度情况（不像 DashScope 有明确的新人免费额度页）。

**是否需要新依赖**：不需要。
**是否需要新 key**：**需要**。

### 4.4 纯本地零依赖方案（字符 n-gram 哈希向量 + TF-IDF）

这就是 `RAG-INTERFACE.md` §3 已冻结的方案。我**用真实语料做了原型实测**，结论如下（详见 §6）：
**bi-gram（2-gram）+ IDF 加权 + 余弦，在本项目语料上对"词面可对齐"的问题是够用的；
对"纯语义改写"的问题会直接归零。**

**能做到什么程度（实测数据，见 §6 表格）**：
- 山头/产品名、风味词、茶气/苦涩/回甘等**术语命中**：top-3 全部正确。例如
  `老班章 苦涩 化得快吗` → `mountain:laobanzhang` 以 78.8 分稳居第一（第二名 29.7）。
- 违禁词/合规类**关键词命中**：`减肥 降脂 功效` → `compliance:medical` 第一。
- **完全失败**：不复用原文词汇的口语化提问。例如
  `这茶喝了能瘦吗`（想命中"医疗功效"合规类）→ **全库得分 0**；
  `最便宜 包邮 全网最低` → **全库得分 0**（因为"全网最低"在 `compliance.json` 里
  以 `patterns[].regex` 形式存在，而非 `categories[].words` 的自然词）。

**业界怎么看"无 embedding 模型的中文混合检索"**：见 §5 的调研结论 ——
普遍共识是 **BM25/词法检索（中文用字符 n-gram 替代分词）是可靠的召回基线，
但单靠词法无法处理同义改写；标准做法是 BM25 + dense 混合并用 RRF 融合**。
本项目的困境正是"dense 这一路拿不到"：官方无 embeddings、又不许装依赖。
所以务实的定位是：**把 n-gram 方案当作"高质量的 BM25 基线"来交付，
不要宣称它是语义检索**，并用评测集（`scripts/rag-eval.mjs`）如实量化它的上限。

**是否需要新依赖**：**不需要**。**是否需要新 key**：**不需要**。**离线**：✅。

### 4.5 其他 OpenAI 兼容服务（简要记录，均需新 key）

**硅基流动 SiliconFlow** —— 规格已核实，**价格未查证到**
来源：[Embeddings API 文档](https://api-docs.siliconflow.cn/docs/api/embeddings-post)

| 项 | 值 |
| --- | --- |
| base_url | `https://api.siliconflow.cn/v1`，`POST /v1/embeddings` |
| 鉴权 | `Authorization: Bearer $SILICONFLOW_API_KEY` |
| 常用模型（max input tokens，官方原文） | `BAAI/bge-m3`、`Pro/BAAI/bge-m3` = **8192**；`BAAI/bge-large-zh-v1.5`、`netease-youdao/bce-embedding-base_v1` = 512；`Qwen/Qwen3-Embedding-8B/4B/0.6B` = **32768** |
| 可配置维度 | 仅 Qwen3 系列：8B `[64…4096]`、4B `[64…2560]`、0.6B `[64…1024]` |
| 价格 / 免费额度 / 批量上限 | **未查证到**（官方 API 文档不标价，价格页正文未列 embedding 模型） |

- 优点：模型选择多（含 `bge-m3` 这类中文强模型）、上下文长（Qwen3-Embedding 达 32768）。
- 缺点：**需要新 key**；**价格与免费额度未查证到**，无法做成本对比。

**Voyage AI（MongoDB）** —— 官方为美元计价，人民币价未公布

| 模型 | 价格（官方） | 免费额度（每账号） |
| --- | --- | --- |
| `voyage-4-large` / `voyage-context-4` / `voyage-code-4` | $0.12 / 1M | 200M token |
| `voyage-4` | $0.06 / 1M | 200M token |
| `voyage-4-lite` | $0.02 / 1M | 200M token |
| `voyage-multilingual-2` / `finance-2` / `law-2` / `code-2` | $0.12 / 1M | 50M token |

来源：[Voyage Pricing](https://docs.voyageai.com/docs/pricing)（页面标注 Updated 17 days ago）。
Batch API 便宜 33% 且**不消耗**免费额度。端点属 OpenAI 风格 `POST /v1/embeddings`。
- 优点：**免费额度巨大**（200M token），单价最低至 $0.02/1M。
- 缺点：**需要新 key**（海外服务，本项目中文场景下网络可达性需自行验证）；
  官方以美元计价、人民币价未公布；**维度与批量上限未查证到**。

**其他**：讯飞开放平台有 embedding 服务但**非 OpenAI 兼容**（HMAC 签名 URL 鉴权、
自定义 JSON 协议），且其文档疑为 6 个月以上旧版，接入成本高，**不推荐**。
百度千帆、Jina AI 的规格本次**未查证到**（页面 JS 渲染 / 抓取失败），不做推荐。

### 4.6 transformers.js 类本地模型（仅记录）

`@xenova/transformers` / `transformers.js` 可在 Node 内本地跑
`bge-small-zh` / `m3e-small` 等中文 embedding 模型，**离线、免费、质量好**，
但**必须新增 npm 依赖**，且首次运行要下载模型权重（几十到几百 MB）。
⇒ 按项目硬约束（`package.json` 的 `dependencies` 必须保持 `{}`），
**本次不可选**；仅在将来放开依赖约束时作为首选项记录在此。

---

## 5. 调研补充：零依赖中文检索的业界共识与公开基准数据

> 本节数据来自公开论文/官方文档，已逐条标注来源。**标注"未查证到"的部分请勿当作确证使用。**
> 这些数据解释了 §6 里实测到的失败模式**不是本项目实现得不好，而是中文词法检索的固有上限**。

### 5.1 ★ 两组关键公开数字：中文是词法检索最吃亏的语言之一

**(a) MIRACL（多语言检索基准，18 语言，人工标注）官方基线** — 来源
[MIRACL 论文](https://arxiv.org/abs/2210.09984) Table 2：

| 语言 | BM25 nDCG@10 | dense(mDPR) nDCG@10 | Hybrid nDCG@10 | **BM25 R@100** | **dense R@100** |
| --- | --- | --- | --- | --- | --- |
| **中文 zh** | **0.180** | **0.512** | 0.526 | **0.560** | **0.944** |
| 韩语 ko | 0.419 | 0.419 | 0.609 | 0.783 | 0.737 |
| 日语 ja | 0.369 | 0.439 | 0.576 | 0.805 | 0.825 |
| 泰语 th | 0.484 | 0.358 | 0.599 | 0.887 | 0.678 |
| 英语 en | 0.351 | 0.394 | 0.549 | 0.819 | 0.768 |
| 平均 | 0.393 | 0.415 | 0.578 | 0.787 | — |

**三个可直接用于本项目决策的读数**：
1. **中文是这张表里 BM25 最弱的一档（0.180），甚至低于英语（0.351）**，
   而 dense 在中文上是 0.512 —— **差距 2.8 倍**。
   ⇒ "中文 RAG 用纯词法检索够用"这个假设是最站不住的。
2. **召回率比排序更致命**：中文 BM25 的 **Recall@100 只有 0.560**，dense 是 **0.944**。
   ⇒ RAG 的 context recall 瓶颈在中文场景几乎必然是纯词法的死因 ——
   而且注意这是 **Recall@100**，不是 recall@5；**提高 k 也救不回来**（top-100 里就只有 56% 的正确文档）。
3. **Hybrid 的增益主要来自 dense**：中文 0.512 → 0.526 只涨 0.014。
   ⇒ 印证 §5.3 的警告：**如果 dense 那一路很弱或不存在，RRF 融合的收益非常有限。**

**(b) MTEB 官方 BM25 基线的中文 tokenizer 消融** — 来源
[MTEB BM25 基线文档](https://raw.githubusercontent.com/embeddings-benchmark/mteb/refs/heads/main/docs/get_started/advanced_usage/bm25.md)
（数据集 LeCaRDv2 中文法律检索，3,795 docs / 159 queries）：

| tokenizer | nDCG@10 |
| --- | --- |
| 空白切分（mteb ≤ 2.13.5 的旧默认） | 0.359 |
| **字符级切分**（mteb > 2.13.5 的新默认） | **0.567** |
| Qwen3-0.6B 子词 | 0.631 |
| 自定义 jieba 分词 | **0.641** |

**这是本次调研中支持"零依赖字符 n-gram 方案"最权威的一组数字**：
- 中文用空白切分 BM25 几乎废掉（0.359）；
- **改成字符级切分一步到 0.567（相对 +58%）**，
  即**零依赖字符切分能拿到成熟分词器（jieba 0.641）约 88% 的效果**；
- jieba 相对字符切分只再多 +0.074（约 +11% 相对）。
  ⇒ **换用自研/无依赖分词器的边际收益，远小于"先确保不要按空白切分"。**
  这与 `RAG-INTERFACE.md` §4「中文用字符 n-gram 分词器」的决策**方向正确**。

> **重要纠偏**：C-MTEB / C-Pack（[BGE 论文](https://arxiv.org/abs/2309.07597)）是**中文 embedding 模型
> 的评测榜单**（6 类任务、35 个数据集），**榜单中没有 BM25 基线行**。
> 因此**"C-MTEB 上 BM25 vs dense 差多少"这个问法本身不成立**，
> 中文 BM25 vs dense 的量化对比应引用上表的 **MIRACL-zh** 与 **MTEB BM25 消融**。
> （本节初稿曾误引 C-MTEB 作为"中文榜单显示 dense 领先"的依据，已更正。）

### 5.2 ★ 对 BEIR 结论的重要限定（常见误读）

[BEIR 论文](https://arxiv.org/abs/2104.08663) 的原文结论是
「BM25 remains a strong baseline for **zero-shot** text retrieval」，
即**未做域内训练的 dense 模型在跨域零样本下常打不过 BM25**。

**但这个结论不能反推"中文场景不需要 embedding"**：
MIRACL 里的 mDPR 同样是零样本（mBERT 初始化 + MS MARCO 微调，未在中文上训练），
在中文上却是 **0.512 vs BM25 0.180**。
⇒ 语言/语料特性（中文无空格、分词困难、同义改写多）的影响**远大于**"零样本 vs 域内"这一维度。

BEIR 另定义了本项目最核心的失败模式**并给它命了名 —— "lexical gap"**：
词法方法"只能召回包含 query 中已出现关键词的文档"，且"把 query 和 document 当词袋，不考虑词序"。
⇒ **这正是 §6 实测里 `这茶喝了能瘦吗` 全库 0 分的原因，属该模式的标准表现。**

### 5.3 标准增强是 hybrid + RRF 融合

- **Elasticsearch 官方**明确推荐 RRF 做 hybrid：
  公式 `score = Σ 1/(k + rank)`，默认 `rank_constant = 60`，**只融合排名而不加原始分数**，
  理由正是"dense 分（0.87）与 BM25 分（3.84）量纲不可比"
  （[官方文档](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)、
  [hybrid search](https://www.elastic.co/docs/solutions/search/hybrid-search)）。
- `RAG-INTERFACE.md` §4 采用 **RRF（k=60）**，与业界标准一致，**选型正确**。
- ⚠️ **但对本项目的关键警告**：RRF 的价值来自"两路排名互补"。
  **本项目两路都源自同一个字符 n-gram**（BM25 一路 + 哈希向量一路），
  **两路高度相关**，而 §5.1(a) 显示：连"真正互补的 BM25 + dense"在中文上融合也只涨 0.014。
  ⇒ **本项目的 RRF 收益很可能接近于零，甚至因为引入第二路噪声而略降。**
  建议在评测里**分别输出** `search()` / `searchBM25()` / `searchVector()` 的 recall，
  用数据决定是否保留双通道。**如果向量通道没有独立贡献，保留它只增加复杂度和不确定性。**

### 5.4 只有 BM25 一路时，零依赖还能加什么（按性价比排序）

| 优先级 | 手段 | 依据 | 是否零依赖 |
| --- | --- | --- | --- |
| 1 | **bigram + unigram 并用** | Lucene `CJKBigramFilter` 官方设计：默认 bigram，可用 `outputUnigrams` 同时输出单字；非 CJK 输入原样透传。Haystack 实测：纯 bigram 能修精度但**单字查询 0 命中**（韩文实测，原文声明未测中文），加 unigram 后两者都修好 | ✅ 零依赖 |
| 2 | **标题/正文分字段加权（BM25F / per-field boost）** | Weaviate hybrid 用 BM25**F**；BEIR 的 BM25 实现也是"title 与 passage 作为独立字段索引"。中文标题的信息密度通常远高于正文 | ✅ 零依赖 |
| 3 | **同义词表 / 查询端扩展**（手工维护领域词典） | Elasticsearch 有官方 synonym set 支持可作参照 | ✅ 零依赖 |
| 4 | **静态质量分 / 时间衰减叠加** | Elasticsearch 有 `static-scoring-signals` 官方专页 | ✅ 零依赖 |
| 5 | **LLM query expansion**（非零依赖但在本项目成本极低） | 见 §5.5 | ❌ 需 LLM |

> ⚠️ **经典 PRF（伪相关反馈）不推荐**：
> [Jagerman et al. 2023](https://arxiv.org/abs/2305.03653) 在 MS MARCO 上的实测显示，
> 经典 PRF（Bo1/Bo2/KL）**能提高 Recall@1K，但会拉低 top-heavy 指标**：
> BM25 的 NDCG@10 = 23.44 → PRF 后降到 22.30~22.48。
> ⇒ 若下游是用 top-k 当 RAG 上下文，这个代价要付，**不要用经典 PRF**。

### 5.5 ★ 用 LLM 替代 embedding 做检索增强（本次调研最强的公开证据）

在有 LLM、无 embedding 的约束下，**LLM query expansion 是有公开数据支撑的最强手段** ——
[Jagerman et al. 2023 (Google Research)](https://arxiv.org/abs/2305.03653)：

| 方法 | Recall@1K | MRR@10 | NDCG@10 |
| --- | --- | --- | --- |
| BM25（基线） | 87.82 | 18.77 | **23.44** |
| BM25 + 经典 PRF（Bo1） | 88.68 | 17.75 | 22.48（↓） |
| **BM25 + CoT/PRF（LLM, Flan-UL2 20B）** | 89.30 | 22.62 | **26.89（↑）** |
| **BM25 + Q2D/PRF（LLM）** | 89.28 | 21.42 | 26.43（↑） |

**关键**：LLM 扩展**同时改善 recall 和 top-heavy 指标**（+3.45 nDCG@10），
这恰恰是经典 PRF 做不到的。BEIR 平均 Recall@1K 也从 72.43 提升到 75.23。
论文测试的模型规模从 **60M（Flan-T5-Small）到 20B**，
⇒ **不必用大模型就能拿到收益** —— 对本项目意味着**用 `deepseek-flash` 做 query 改写是合理选择**。
论文给的工程细节：把原 query 重复 5 次拼接以提升原词权重；CoT prompt 效果最好（输出啰嗦、带出更多可用关键词）。

**但要注意偏科**：该方法的收益在不同数据集上差异大
（QA 型数据集收益大；某些领域学术数据集上经典 PRF 反而更好，如 nfcorpus 上 Bo1 57.30 vs Q2D 55.34）。
⇒ 本项目应在自己的 golden set 上验证，不要假定一定涨。

**LLM rerank**：把 BM25 top-20 交给 `deepseek-flash` 排序或打分。
BEIR 已证明 reranking 类方法平均最强，但**代价是每 (query, doc) 一次前向**。
> **诚实声明**：本次**未找到**公开的、严格的"LLM rerank / LLM query expansion 的 token 成本与
> 端到端延迟 vs embedding 模型"对比基准，故不给延迟对比数字。
> 只能给出结构性判断：embedding 是**索引期一次性**成本（向量可预计算），查询期很轻；
> cross-encoder rerank 是每 (query,doc) 一次；listwise LLM rerank 调用次数与候选数成正比，
> **延迟与成本量级上都更差**。LLM query expansion 是**每 query 一次**，成本远低于 rerank，
> 且它增强的正是已有的 BM25 那一路 —— **这使它在"一次 LLM 调用"的预算下性价比最高。**

对 `RAG-INTERFACE.md` §9 的兼容提示：query expansion / rerank 会引入"检索依赖网络"，
而 §9 要求 `node scripts/rag-eval.mjs --offline` 在不调 LLM 时也能跑
⇒ **必须把这两步设计成可开关的增强层（离线时自动降级为原始 query），不能写死在检索主路径里。**

### 5.6 判断标准（结合本项目规模）

| 场景 | 零依赖 n-gram 是否够用 | 依据 |
| --- | --- | --- |
| 用户用**库内术语**提问（"老班章""冰岛""苦涩""减肥功效"） | ✅ 够用，实测 top-1 准确 | §6 实测（本项目语料） |
| 查询是**关键词/专名/型号/编号**类 | ✅ 优先用词法 | Qdrant 实测：`Pegasus 40` 场景 sparse 能精确区分 `40` vs `41`，dense 做不到 |
| 语料 **万级 chunk 及以下** | ✅ 词法衰减不突出 | MTEB 在 3,795 docs 规模上字符级 BM25 拿到 0.641 nDCG@10 |
| 用户用**口语/同义改写**提问（"那茶喝了能瘦吗""最甜的像冰糖的山头"） | ❌ 不够，实测**全库 0 分**，会直接触发拒答 | §6 实测 + MIRACL zh（0.180 vs 0.512） |
| **RAG 且回答质量受 context recall 限制** | ❌ 中文下是纯词法的死因 | MIRACL zh：BM25 Recall@100 = 0.560 vs dense 0.944 |
| 需要**跨语言**检索 | ❌ 完全不行 | MIRACL 为单语设计，跨语言需多语 embedding 或翻译双路 |

**可执行门槛建议**（取代拍脑袋）：先建 50~100 条带标注的中文 query，量三个数：
1. **Recall@50**：≥ 0.85 ⇒ 零依赖 BM25 大概率够用；< 0.7 ⇒ 直接上 embedding
   （中文 BM25 的 Recall@100 只有 0.560，这个门槛能很快暴露它）。
2. **失败归因**：若 top-50 未命中里 **>30% 属"词表不匹配"**（同义、缩写、跨语言、口语化）
   ⇒ 调 tokenizer 和字段权重救不回来，必须上 embedding 或 LLM query expansion。
3. **查询类型分布**：自然语言问句占比 > 30% ⇒ 按 MIRACL 数据，纯词法会系统性掉队。

### 5.7 落地顺序建议（综合本节数据）

1. 字符 **bigram + unigram** 倒排（照抄 Lucene 设计），**标题/正文分字段加权**
   ⇒ 这一步就能拿到"字符级 BM25"的实力（§5.1(b) 的 0.567 量级）。
2. 加**同义词表**（手工/领域词典）+ 静态分（时效、权威性）。
3. 若还不够：**先上 LLM query expansion**（每 query 一次调用，成本最低，
   且增强的正是已有的 BM25；参考 NDCG@10 23.44 → 26.89 的公开增益）。
4. 仍然不够（尤其 recall 上不去，或查询以自然语言为主）
   ⇒ **引入 embedding + RRF**，这才是中文场景的终局。注意 RRF **只融合排名，不要把 BM25 分和 cosine 分相加**。

---

## 6. 实测原型：零依赖 n-gram 检索在本项目语料上的真实表现

> 原型在项目外的临时目录运行，**未修改 `直播工作台` 下任何文件**。
> 逻辑：把 `mountains`/`products`/`compliance.categories` 各拼成一个 passage
> （共 **94** 个 passage，平均 **236** 字），字符 n-gram 计数向量 + IDF 加权 + 点积排序。

**词表规模实测**：bi-gram 词表仅 **4,902** 个（94 passage）⇒
**`RAG-INTERFACE.md` 里 `DIM = 512` 偏小**：
4,902 个 bigram 哈希到 512 维，平均每维要挤 ~9.6 个 bigram，**碰撞严重**。
建议 `DIM` 提到 **4096 或 8192**（内存与耗时在该规模下完全无压力：512 维 × 94 passage ≈ 48K float，
8192 维 ≈ 770K float ≈ 3 MB，可接受）。

### 6.1 不同 n-gram 阶数的对比（同一语料、同一批查询）

| 查询 | n=2（bigram） | n=3 | n=4 |
| --- | --- | --- | --- |
| `减肥 降脂 功效` | ✅ `compliance:medical`=7.9 | ❌ 全 0 | ❌ 全 0 |
| `最便宜 包邮 全网最低` | ❌ 全 0 | ❌ 全 0 | ❌ 全 0 |
| `那个很甜的 像冰糖一样的 山头` | ⚠️ `mountain:laobanzhang`=17（**错**） | ⚠️ `mountain:jingmai`=4.3 | ❌ 全 0 |
| `这茶喝了能瘦吗` | ❌ 全 0 | ❌ 全 0 | ❌ 全 0 |
| `苦涩 回甘 茶气足` | ✅ `mountain:laobanzhang`=6.4 | ❌ 全 0 | ❌ 全 0 |
| 词表大小 | 4,902 | 7,410 | 8,790 |

**结论（重要，可直接影响 `embed.mjs` 实现）**：
- **必须以 2-gram 为主体。3-gram/4-gram 在本语料上几乎全部退化为 0 分**（精确共现太稀疏）。
- `RAG-INTERFACE.md` §3 建议的「2-gram + 3-gram」中，
  **3-gram 只能作为低权重补充（如权重 0.2–0.3），绝不能等权**，否则会把 2-gram 的有效信号稀释掉。
  => 建议实测对比「纯 2-gram」vs「2-gram + 0.25×3-gram」的 recall 后再定。

### 6.2 成功与失败的典型样例（同一 n=2 配置）

**成功（词面可对齐）**：

```
Q: 老班章 苦涩 化得快吗   -> mountain:laobanzhang=78.8 | mountain:xinbanzhang=29.7 | mountain:banpen=18.1
Q: 冰岛 甜柔 冰糖韵       -> mountain:bingdao-nanpo=20.7 | mountain:bingdao-bawai=20.7 | mountain:bingdao=17.4
Q: 易武 弯弓 口感 怎么样   -> mountain:wangong=23.8 | mountain:yiwuzhengshan=18.7 | mountain:fenghuangwo=15.8
Q: 古树 和 台地 区别       -> product:taidi-cha=9.5 | product:shengshu-qubie=8.6
Q: 减肥 降脂 功效         -> compliance:medical=8.9 | compliance:superstition=4.5
```

**失败（语义改写，全库 0 分 → 会触发拒答）**：

```
Q: 这茶喝了能瘦吗           -> 全 0
Q: 最便宜 包邮 全网最低      -> 全 0
```

**失败原因分析（对实现有指导价值）**：
1. **`最便宜 包邮 全网最低` 归零是数据结构问题，不是算法问题**：
   实测 `compliance.json` 的 `categories[].words` 里**没有**"最低"字样，
   绝对化用语是以 `id: "absolute"`、`name: "绝对化用语"`、
   `risk: "…禁用「国家级」「最高级」「最佳」等极限用语"` 的形式存储的。
   ⇒ **`buildChunks` 必须把 `categories[].name`、`risk`、`advice`、`patterns[].regex`
   一起拼进 passage 正文**，否则合规类 passage 的词汇量与查询完全对不上。
   这是**最高优先级**的实现建议（不改算法就能救回一大类查询）。
2. **`这茶喝了能瘦吗` 归零是 n-gram 的本质局限**：
   查询里没有任何一个 bigram 出现在库内（"能瘦"vs 库里的"减肥/降脂"是不同字符组合）。
   零依赖词法检索**无法**跨越这个鸿沟。

### 6.3 由实测得到的落地建议

> 每条都标注了依据来源：【实测】= 本次在本项目语料上跑出来的；
> 【公开数据】= §5 引用的论文/官方文档。

1. **`buildChunks` 要把结构化字段全部展开成自然语言**
   （`name`/`risk`/`advice`/`regex` 都要进 `text`）【实测】
   —— 这是零成本的最大召回提升，直接救回 `最便宜 包邮 全网最低` 这类查询。
2. **分词用「重叠字符 bigram + unigram 并用」，不要纯 bigram**【公开数据】+【实测】：
   - 【实测】纯 3-gram/4-gram 在本语料上几乎全库 0 分，**必须以 2-gram 为主体**。
   - 【公开数据】Lucene `CJKBigramFilter` 的设计就是 bigram 为主 + `outputUnigrams`
     兜住单字/短查询；Haystack 实测纯 bigram 会让**单字查询 0 命中**。
   - ⇒ 建议 **bigram 为主 + unigram 补充**（而非 `RAG-INTERFACE.md` 原写的 3-gram）。
     若坚持用 3-gram，**只能给低权重（0.2–0.3）**，绝不能与 2-gram 等权。
3. **`DIM` 从 512 提到 8192（= 2^13，2 的幂）**【实测】+【公开数据】：
   - 【实测】本项目语料 bi-gram 词表仅 **4,902**，哈希到 512 维时平均每维挤 ~9.6 个 bigram。
   - 【公开数据】scikit-learn `FeatureHasher` 官方建议 **`n_features` 取 2 的幂**，
     否则特征不能均匀映射；并用**带符号哈希**让碰撞正负相消（对 `n_features < 10000` 尤其有用）。
   - 【公开数据】碰撞对数 ≈ V²/(2D)。V=4,902 时 D=512 → ~23k 碰撞对；
     **D=8192 → ~1.5k**，已足够。本项目规模下 8192 维很轻量（8192 × 94 passage ≈ 770K float ≈ 3 MB）。
   - ⚠️ **但不要用哈希倒排替代倒排索引**：哈希只是"省内存"技巧，不是"语义"技巧。
     若只追求召回质量，直接建 n-gram 倒排（不做哈希）质量只会更好。本项目 94 个 passage，
     **完全没必要为省内存而哈希** —— 这一点值得重新审视 `RAG-INTERFACE.md` §3 的"哈希向量"设计。
4. **标题/正文分字段加权（BM25F 思路）**【公开数据】：
   Weaviate 的 hybrid 用 BM25**F**，BEIR 的 BM25 实现也是"title 与 passage 作为独立字段索引"。
   本项目 `Passage` 已有 `title` 与 `text` 两个字段，**把 `title` 单独加权索引是零依赖下最被低估的一招**
   （中文标题的信息密度远高于正文）。
5. **专有名词/违禁词做"精确词"通道**【实测】：
   对 `mountains[].name`、`products[].name`、`compliance.categories[].words` 里的词做
   **子串精确匹配并给高分**，可救回 n-gram 因跨词边界而漏掉的查询
   （"老班章"被切成"老班/班章"，而查询若写作"老班章茶"则 bigram 变为"老班/班章/章茶"，仍能命中）。
6. **诚实地设置拒答阈值**【实测】+【公开数据】：
   既然存在"全库 0 分"的真实情况，`RAG-INTERFACE.md` §7 的拒答机制是**必要且正确**的。
   【公开数据】MIRACL 显示中文词法检索的 **Recall@100 只有 0.560**（dense 0.944），
   即**提高 k 也救不回来**。不要为了提升"回答率"而降低阈值 —— 那会把"检索不到"变成"编答案"。
7. **可选增强（不破坏零依赖）：LLM query 改写，而不是经典 PRF**【公开数据】：
   - 用现有 DeepSeek 通道把口语问题转成库内术语（"这茶喝了能瘦吗"→"减肥 功效 医疗"），
     失败/离线时自动降级为原始查询。
   - 依据：LLM query expansion 在 MS MARCO 上把 BM25 的 NDCG@10 从 **23.44 提到 26.89**，
     且**同时改善 recall 与 top-heavy 指标**（§5.5）。
   - ⚠️ **不要用经典 PRF（Bo1/Bo2/KL）**：实测数据表明它**提 recall 但拉低 NDCG@10**
     （23.44 → 22.30~22.48），下游取 top-k 当上下文时要付这个代价。
   - 注意 `RAG-INTERFACE.md` §9 要求 `--offline` 可跑，故这一步必须做成**可开关的增强层**。

### 6.4 实测预期校准（避免对验收标准产生错误预期）

本项目验收要求 `rag-eval.mjs --offline` 的 **recall@5 ≥ 0.7**。结合 §5.1 的公开数据与 §6.2 实测：

- 如果 golden set 以**术语型查询**为主（"老班章 苦涩"），**recall@5 ≥ 0.7 应当能轻松达到**，
  因为这类查询在实测中 top-1 就命中。
- 但**这不代表检索质量好** —— 公开数据显示中文纯词法检索的 Recall@100 仅 0.560。
  本项目语料小（94 passage）、术语化强，表现会明显好于 MIRACL 的维基百科场景，
  但**能力边界仍然存在**：口语化改写查询会全库 0 分。
- ⇒ **强烈建议 golden set 里自然语言/口语化查询占比不低于 30%**，
  否则 recall@5 ≥ 0.7 只能证明"术语查询能命中"，证明不了"RAG 可用"。
  这与 §5.6 提出的"可执行门槛"一致：主要盯 **Recall@50**，而不是只看 recall@5 一个数。

---

## 7. 对本项目的建议

### 7.1 立即可做（零成本、不破坏约束）

1. **接受"官方无 embeddings"这个事实，把 `embed.mjs` 定位为"高质量词法检索"而非语义检索。**
   在 README/注释里如实描述能力边界，避免后续被误认为语义检索。
2. **`buildChunks` 展开全部结构化字段**（§6.3 第 1 条），这是召回提升最大的一步。
3. **`DIM` 提到 8192（2 的幂）**，并考虑**直接用 n-gram 倒排而非哈希**
   （§6.3 第 3 条：本项目仅 94 个 passage，哈希省内存的意义很小，
   而哈希会损失可解释性和召回精度）。
4. **`llm.mjs` 的默认 `maxTokens` ≥ 512**，并在 RAG 场景显式
   `"thinking":{"type":"disabled"}`（§2.1、§2.4：思考模式会吃 token、让 temperature 失效、
   且工具回传要求更复杂）。
5. **`chatJson` 的 system prompt 必须带 "JSON" 字样 + schema 样例**，
   并**把"空 content"当作一种独立的失败**来重试（官方明确警告 JSON 模式可能返回空 content）。
6. **读取 `providers.json` 必须显式 UTF-8**（§1 踩坑记录），否则本机直接解析失败。
7. **分词改为「重叠字符 bigram + unigram」，并把 `Passage.title` 单独加权索引**
   （§6.3 第 2、4 条；公开数据显示字符级切分相对分词器能拿到 ~88% 的效果，
   而 bigram+unigram 是 Lucene 的成熟设计）。
8. **`rag-eval.mjs` 除 recall@5 外必须输出 Recall@50**
   （§5.6：中文词法检索的瓶颈在召回而非排序，只报 recall@5 会掩盖问题；
   且 recall@5 ≥ 0.7 这个验收线在术语型 golden set 上会被轻松满足，见 §6.4）。

### 7.2 中期（需要决策）

7. **是否引入外部 embedding 通道，做成"可选插件式"**：
   - 本项目的 `RAG-INTERFACE.md` §6 已经设计了 `Provider[]` 多通道 + failover 范式，
     **天然适合把 DashScope embeddings 作为一个可选 provider 挂进去**。
   - 建议：**默认走本地 n-gram（离线可用、零 key）**；
     若用户配置了 `DASHSCOPE_API_KEY`，则**自动启用 dense 通道并与 BM25 做 RRF 融合**。
     这样既守住硬约束，又给"要更好效果"的用户留了出口。
   - 代价：需要新 key + 实现分批（DashScope 单次最多 10 行输入）+ 网络失败降级。
8. **优先验证 RRF 在本项目是否真有增益（这是最可能"白做"的一块）**。
   由于两路都源自同一个字符 n-gram（§5.3），**RRF 的收益可能远小于预期** ——
   公开数据显示连"真正互补的 BM25 + dense"在中文上融合也只涨 0.014 nDCG（§5.1(a)）。
   建议 `scripts/rag-eval.mjs` 分别输出 `search()` / `searchBM25()` / `searchVector()`
   **三路的 Recall@5 与 Recall@50**，用数据决定是否保留双通道
   （如果向量通道没有独立贡献，保留它只增加复杂度和不确定性）。
9. **评测集要专门包含"口语化改写"用例**（如"这茶喝了能瘦吗"→ 期望 `compliance:medical`）。
   实测已证明这类查询会全库 0 分；把它们放进 golden set 才能如实反映 recall，
   也才能验证第 7 条的可选 dense 通道是否真的解决了问题。
   ⚠️ 如果 golden set 只包含术语型查询（如"老班章 苦涩"），
   **recall@5 ≥ 0.7 这个验收标准会被轻松满足，但会掩盖真实的能力缺口**。

### 7.3 不推荐

10. **不要为 `strict` 模式引入 `/beta` base**：`json_object` 已实测满足需求（§2.5）。
11. **不要在本项目里引入 transformers.js 等 npm 包**：直接违反 `dependencies: {}` 硬约束；
    仅记录为"放开约束时的首选"。
12. **不要试图用 `deepseek-flash` 当 embedding 模型**（如取 logprobs 或隐藏层）：
    接口没有暴露该能力，实测 `/v1/embeddings` 404，这条路不通。

---

## 8. 附录：本次全部实测端点与状态码汇总

| # | 方法 | 端点 | 关键参数 | 状态码 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/v1/chat/completions` | `deepseek-flash`, max_tokens=64 | **200** | key 有效，`content:"OK"` |
| 2 | POST | `/v1/chat/completions` | max_tokens=16 | **200** | `content:""`, `finish_reason:"length"`（思考模式吃光 token） |
| 3 | GET | `/v1/models` | — | **200** | 仅 `deepseek-flash`、`deepseek-v4-pro` |
| 4 | POST | `/v1/chat/completions` | `model:"nope-does-not-exist"` | **400** | 结构化错误，列出支持的模型名 |
| 5 | POST | `/v1/chat/completions` | 无效 key | **401** | `authentication_error`，仅回显末 4 位 |
| 6 | POST | `/v1/embeddings` | `deepseek-embedding` | **404** | **0 字节，路由不存在** |
| 7 | POST | `/v1/embeddings` | `deepseek-flash` | **404** | 0 字节 |
| 8 | POST | `/embeddings` | 无 `/v1` | **404** | 0 字节 |
| 9 | POST | `/beta/embeddings` | — | **404** | 0 字节 |
| 10 | POST | `/v1/embeddings` | `encoding_format`,`dimensions` | **404** | 0 字节 |
| 11 | GET | `/v1/embeddings` | — | **404** | 0 字节 |
| 12 | POST | `/v1/rerank` | — | **404** | 0 字节 |
| 13 | POST | `/v1/nonexistent-path-xyz` | 对照 | **404** | 0 字节（与 6–12 完全一致 ⇒ 路由缺失） |
| 14 | POST | `/v1/chat/completions` | `tools:[get_time]`, `tool_choice:"auto"` | **200** | `tool_calls` 2 个并行调用，`finish_reason:"tool_calls"` |
| 15 | POST | `/v1/chat/completions` | 思考模式 + 强制 `tool_choice` | **400** | `Thinking mode does not support this tool_choice` |
| 16 | POST | `/v1/chat/completions` | 思考模式 + tool 结果回传但缺 `reasoning_content` | **400** | 必须回传 `reasoning_content` |
| 17 | POST | `/v1/chat/completions` | `thinking:disabled` + 强制 `tool_choice` | **200** | 正确产出 `tool_calls` |
| 18 | POST | `/v1/chat/completions` | `thinking:disabled` + tool 结果闭环 | **200** | `"…is 2026-10-16 11:20:00 (UTC+8)."` |
| 19 | POST | `/v1/chat/completions` | `response_format:{"type":"json_object"}` | **200** | `content:"{\"name\":\"Ada\",\"age\":36}"` |
| 20 | GET | `/v1/files` | — | **200** | Files API 存在 |
| 21 | POST | `/v1/files` | `purpose=batch` | **400** | 仅支持 `user_data` |
| 22 | GET | `/v1/batches` | — | **404** | 无 Batch API |
| 23 | GET | `/beta/chat/completions` | — | **405** | `/beta` 前缀存在，仅 POST |

---

## 9. 参考链接

**DeepSeek 官方**
- [首次调用 API](https://api-docs.deepseek.com/zh-cn/) —— 模型名 `deepseek-flash`、OpenAI/Anthropic 兼容 base_url
- [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) —— 功能对照表（**无 embeddings 行**）、1M 上下文、价格
- [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode) —— `response_format`、prompt 必须含 json、可能返回空 content
- [Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls) —— tool_calls 格式、`strict` 模式（Beta）
- [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode) —— `thinking`/`reasoning_effort`、`reasoning_content` 回传要求、temperature 失效
- [DeepSeek-V3 issue #806：no dedicated embedding for any deepseek models](https://github.com/deepseek-ai/DeepSeek-V3/issues/806)

**替代方案官方文档**
- [阿里云百炼：OpenAI Embedding 接口兼容](https://www.alibabacloud.com/help/zh/model-studio/embedding-interfaces-compatible-with-openai) —— base_url、模型维度/批次/价格/免费额度
- [阿里云百炼：文本与多模态向量化](https://help.aliyun.com/zh/model-studio/embedding) —— 原生 DashScope 接口（支持 `text_type`/`instruct`/稀疏向量）
- [阿里云百炼：新人免费额度](https://help.aliyun.com/zh/model-studio/new-free-quota) —— 100 万 token/模型、90 天、仅北京、Batch 不抵扣
- [智谱 Embedding-3](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3) —— 价格 ¥0.5/百万、维度 256–2048、8K 上下文
- [智谱：OpenAI API 兼容](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) —— base_url `https://open.bigmodel.cn/api/paas/v4/`
- [智谱：文本嵌入 API 参考](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E5%B5%8C%E5%85%A5)
- [硅基流动 Embeddings API](https://api-docs.siliconflow.cn/docs/api/embeddings-post) —— 模型与 max input tokens（价格未标）
- [Voyage AI Pricing](https://docs.voyageai.com/docs/pricing) —— 美元价与免费额度
- [Qwen3-Embedding 发布说明](https://qwenlm.github.io/zh/blog/qwen3-embedding/)

**中文检索质量与检索方法的公开基准（§5、§6.4 的数据来源）**
- [MIRACL 论文](https://arxiv.org/abs/2210.09984)（[全文](https://arxiv.org/html/2210.09984v1)）—— **中文 BM25 nDCG@10 0.180 vs dense 0.512；Recall@100 0.560 vs 0.944**
- [MTEB 官方 BM25 基线文档](https://raw.githubusercontent.com/embeddings-benchmark/mteb/refs/heads/main/docs/get_started/advanced_usage/bm25.md) —— **中文字符级切分 0.567 vs 空白切分 0.359 vs jieba 0.641**
- [MTEB PR #4405](https://github.com/embeddings-benchmark/mteb/pull/4405) —— 默认基线改为对中文使用字符级切分
- [BEIR 论文](https://arxiv.org/abs/2104.08663)（[全文](https://ar5iv.labs.arxiv.org/html/2104.08663)）—— BM25 是强基线（**零样本跨域前提**）、lexical gap 的定义
- [LLM query expansion（Jagerman et al. 2023）](https://arxiv.org/abs/2305.03653)（[全文](https://ar5iv.labs.arxiv.org/html/2305.03653)）—— BM25 NDCG@10 **23.44 → 26.89**；经典 PRF 反而降到 22.3~22.5
- [C-Pack / C-MTEB](https://arxiv.org/abs/2309.07597) —— 注意：这是**中文 embedding 模型榜**，不含 BM25 基线
- [Lucene `CJKBigramFilter`](https://lucene.apache.org/core/9_9_0/analysis/common/org/apache/lucene/analysis/cjk/CJKBigramFilter.html) —— bigram 为主 + `outputUnigrams` 的官方设计
- [Haystack issue #12867](https://github.com/deepset-ai/haystack/issues/12867) —— CJK bigram vs unigram 实测（**原文声明仅测韩文，未测中文**）
- [scikit-learn 特征哈希](https://scikit-learn.org/stable/modules/feature_extraction.html#feature-hashing) —— 带符号 MurmurHash3、建议 `n_features` 取 2 的幂、TF-IDF 默认 L2 归一化
- [Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) / [hybrid search](https://www.elastic.co/docs/solutions/search/hybrid-search) —— k=60、只融合排名
- [Qdrant hybrid search](https://qdrant.tech/course/beginners/module-3/hybrid-search/) —— sparse 与 dense 的互补性实测
- [Weaviate hybrid](https://docs.weaviate.io/weaviate/search/hybrid) —— hybrid = vector + **BM25F**（字段加权）

---

## 10. 本次侦察的边界与未决事项

**已确证**（有实测或官方文档直接支撑）：问题 1–5 的全部结论；
DeepSeek 通道的 tool calls / JSON / thinking / Files 行为；
DeepSeek 无 embeddings（**五重证据**：实测 404、文档侧栏、sitemap、API 参考、社区 issue）；
DashScope v3/v4 的 base_url、维度、批次上限、价格、免费额度、`text_type` 差异；
智谱 `embedding-3` 的 OpenAI 兼容 base_url、价格、维度、批量与并发上限；
§5 引用的中文检索公开基准数字（MIRACL、MTEB BM25 消融、LLM query expansion、Lucene/Haystack CJK 分词）。

**未决 / 需后续核实**：
1. **硅基流动 embedding 的价格、免费额度与批量上限未查证到**（官方 API 文档不标价，
   价格页正文未列 embedding 模型）——若考虑采用，需登录控制台确认。
2. **百度千帆、Jina AI 的全部规格未查证到**（页面 JS 渲染 / 抓取失败），本报告不做推荐。
3. **`text-embedding-v4` 在旧域名 `dashscope.aliyuncs.com/compatible-mode/v1` 上是否可用**
   未实测（无阿里云 key）。官方称旧域名"仍可正常使用"，但示例已改用业务空间域名。
4. **智谱 `embedding-3` 是否提供新人免费额度未查证到**（DashScope 有明确的免费额度页，智谱未见对应说明）。
5. **RRF 双通道在本项目是否真有增益**未实测（需要 `scripts/rag-eval.mjs` 落地后用真实 recall 数据判断，见 §7.2 第 8 条）。
6. **★ 没有"中文 2-gram/3-gram 哈希向量 vs 真实 embedding"的直接公开对照实验。**
   本报告用 MTEB 字符级 BM25（0.567）与 MIRACL-zh 作为**替代证据**，
   但严格说，**"哈希 n-gram 向量算不算轻量语义"这个问题业界没有公开评测**。
   §6 的原型结果是**本项目语料上的实测**，外推到其他语料需谨慎。
7. **LLM rerank / LLM query expansion 的 token 成本与端到端延迟，未找到权威基准。**
   §5.5 只给出结构性判断（量级推理），**不是实测数字，请勿当作 benchmark 引用**。
8. **2^16 vs 2^18 的公开中文 n-gram 碰撞实测未查证到。**
   §6.3 第 3 条的碰撞估算是按生日界（V²/2D）推算，机制说明来自 scikit-learn 官方文档。
9. **BEIR 的具体平均数值表未取到**（HTML 表格截断、PDF 抓取不可用），
   只核实了定性结论与配置细节（Anserini，k=0.9、b=0.4，title/passage 分字段）。
10. **Haystack 的 CJK bigram vs unigram 实测仅覆盖韩文**，
    其原文明确声明"I have not measured Japanese or Chinese"，
    引用到中文场景属**合理推断而非实证**。
