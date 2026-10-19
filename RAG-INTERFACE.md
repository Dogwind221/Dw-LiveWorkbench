# RAG 接口契约（冻结版 v1）

> 本文件是并行开发的**唯一接口约定**。任何一方不得单方面修改下列签名；
> 需要变更时先在会话里提出，由 Lead 更新本文件并通知所有写入方。

## 0. 项目硬约束

- Node ≥ 20，**ESM**（`import`/`export`，文件后缀 `.mjs`）
- **零运行时依赖**：`package.json` 的 `dependencies` 必须保持 `{}`。
  不允许引入 `chromadb`/`langchain`/`@xenova/transformers` 等任何包。
- 现有代码风格：`server/lib/*.mjs` 导出纯函数；HTTP 路由用
  `server/lib/handler.mjs` 里的 `routes.push({method, re, keys, handler})` 注册。
- 中文注释，注释只写"为什么"，不写"这行在干嘛"。

## 1. 文件所有权（写入作用域，禁止越界）

| 归属 | 文件 |
| --- | --- |
| rag-core | `server/lib/rag/chunk.mjs`、`server/lib/rag/embed.mjs`、`server/lib/rag/retrieve.mjs`、`server/lib/rag/index.mjs`、`server/lib/llm.mjs` |
| eval | `scripts/rag-eval.mjs`、`data/eval/kb-golden.json` |
| lead | `server/lib/rag/answer.mjs`、`server/lib/handler.mjs`（只加路由）、`scripts/rag-smoke.mjs`、`README-rag.md`、本契约文件 |
| scout | `docs/research/deepseek-capability.md` |

`data/knowledge.json`、`data/compliance.json` **只读**，不得修改。

## 2. `server/lib/rag/chunk.mjs`

把知识库对象转成可检索的 passage 列表。

```js
/**
 * @param {object} kb   loadKB() 的返回值
 * @returns {Passage[]}
 */
export function buildChunks(kb): Passage[]

/**
 * @typedef {object} Passage
 * @property {string} id        稳定唯一 id，格式 `<type>:<sourceId>#<n>`
 *                              type ∈ mountain|product|region|compliance|topic
 * @property {string} type
 * @property {string} sourceId  对应 mountains[].id / products[].id 等
 * @property {string} title     可读标题，如 "倚邦 · 山场特征"
 * @property {string} text      用于检索与喂给模型的正文（含字段名，便于模型引用）
 * @property {string[]} tags    结构化标签，如 ["西双版纳","勐腊县","甜柔"]
 * @property {object} meta      其余溯源信息（confidence 等），原样带出
 */
```

要求：
- 一个山头的不同字段组要拆成多个 passage（山场/品鉴/价格/避坑/卖点各自成块），
  不要整条塞成一个块——检索精度取决于粒度。
- `text` 必须自带字段名（如 `山场特征：...`），否则模型无法引用。
- 单块 `text` 控制在 100–400 字；超长的 `terroir`/`summary` 要按句切分。
- 空值、空数组字段不产生 passage。
- 同一输入必须产出**完全一致**的输出顺序（可复现）。

## 3. `server/lib/rag/embed.mjs`

零依赖的本地向量化。**这是"向量检索"的真实实现，不是关键词匹配的包装。**

```js
export const DIM = 512;

/** 把文本编码成 L2 归一化后的稠密向量（Float32Array，长度 DIM） */
export function embed(text: string): Float32Array

/** 余弦相似度；两边都假定已 L2 归一化，直接点积即可 */
export function cosine(a: Float32Array, b: Float32Array): number
```

实现要求：
- 字符 n-gram（建议 2-gram + 3-gram）哈希到 DIM 维，带 TF-IDF 式权重；
  中文没有空格分词，用 n-gram 是正确做法。
- 哈希必须是**确定性**的（不要用 `Math.random`、不要用对象插入序）。
- 必须在模块内做 LRU 或 Map 缓存，同文本重复编码不重算。
- 顶层不能有依赖文件 IO 的副作用。

## 4. `server/lib/rag/retrieve.mjs`

```js
/**
 * @param {Passage[]} chunks
 * @param {object} [opts]
 * @returns {Retriever}
 */
export function createRetriever(chunks, opts?): Retriever

/**
 * @typedef {object} Retriever
 * @property {(query: string, k?: number) => Hit[]} search
 * @property {(query: string, k?: number) => Hit[]} searchBM25   仅词法通道
 * @property {(query: string, k?: number) => Hit[]} searchVector 仅向量通道
 * @property {() => object} stats
 */

/**
 * @typedef {object} Hit
 * @property {Passage} chunk
 * @property {number} score     融合后的最终分（越大越相关）
 * @property {object} scores    各通道明细 {bm25, vector, rrf}
 * @property {string[]} reasons 人类可读的命中原因，如 ["BM25 #2","向量 #5"]
 */
```

要求：
- BM25 通道：自实现（k1=1.2, b=0.75），中文用与 `embed.mjs` 同源的字符 n-gram 分词器。
- 向量通道：`embed` 点积。
- 融合：RRF（`1/(60+rank)`）同时融合**两路排名**，不要直接加权原始分（量纲不同）。
- `search(q)` 默认 `k=8`；分数相同必须稳定（同分按 `chunk.id` 字典序）。
- `stats()` 返回 `{chunks, dim, avgTokens, buildMs}`。

## 5. `server/lib/rag/index.mjs`

```js
/** 从 kb 构建完整 RAG 索引（chunk + embed + retriever），并缓存 */
export function buildIndex(kb: object, opts?: object): RagIndex

/** 进程内单例：kb 未变则复用，kb 变了（按 updatedAt + 条目数）自动重建 */
export function getIndex(kb?: object): RagIndex

/** @typedef {{chunks: Passage[], retriever: Retriever, builtAt: string, signature: string}} RagIndex */
```

## 6. `server/lib/llm.mjs`

OpenAI 兼容的对话客户端，**复用 `dsh-vision-skill/scripts/vision.js` 已验证的
failover 范式**（多供应商 → 逐模型降级 → JSON 修复重试 → `meta.attempts`）。

```js
export function createLlm(providers?: Provider[]): Llm

/**
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} base   OpenAI 兼容 base，如 https://api.deepseek.com/v1
 * @property {string} key
 * @property {string[]} models  按优先级排列
 */

/**
 * @typedef {object} Llm
 * @property {(req: ChatRequest) => Promise<ChatResult>} chat
 * @property {(req: ChatRequest) => Promise<object>} chatJson  强制 JSON 输出并校验
 * @property {() => ProviderStatus[]} providers
 */

/**
 * @typedef {object} ChatRequest
 * @property {string|object[]} messages  字符串=用户单轮；数组=标准 messages
 * @property {number} [temperature=0.2]
 * @property {number} [maxTokens]
 * @property {number} [jsonSchema]       传入则走 chatJson 路径
 */

/**
 * @typedef {object} ChatResult
 * @property {string} text
 * @property {object} meta  {provider, model, attempts:[{provider,model,ok,ms,error?}], usage}
 */
```

要求：
- 从环境变量读通道：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（逗号分隔优先级），
  兼容 `DEEPSEEK_API_KEY`；再读 `<USERPROFILE>/.dsh/dsh-vision-config/providers.json`
  中 `kind === "vision"` 的条目作为补充通道（该文件已有可用 key）。
- **不把 key 写进代码、日志或错误信息**（错误里 key 一律脱敏为 `sk-***`）。
- 超时 60s（`AbortSignal.timeout`）。
- `chatJson` 解析失败要重试一次，并提示"只输出 JSON"。
- 普通 `chat` 失败要换下一个模型；全部失败才抛错，错误里带上 attempts。

## 7. `server/lib/rag/answer.mjs`（lead 实现）

```js
/** 检索 → 组装带编号引用的 prompt → 调 LLM → 回传答案与出处 */
export function answerKnowledge(kb: object, question: string, opts?: object): Promise<{
  answer: string,
  citations: {n: number, chunkId: string, title: string, sourceId: string, score: number}[],
  hits: Hit[],
  meta: object,
  refused: boolean,
}>
```

要求：
- 检索不到足够证据（top1 分低于阈值）时**拒答**，`refused: true`，不许编。
- 答案里必须出现 `[1]` 形式的引用编号，且编号必须能在 `citations` 里找到。
- 合规相关问答要走 `compliance` 类 passage。

## 8. HTTP 路由（lead 实现，加在 `server/lib/handler.mjs`）

```
POST /api/kb/ask    body: {question: string, k?: number}
  → 200 {answer, citations, hits:[{id,title,score,type}], meta, refused}
  → 400 {error:'BAD_QUESTION'}    question 为空或非字符串
  → 503 {error:'NO_LLM'}          没有任何可用模型通道
```

## 9. 评测指标（eval 负责）

`scripts/rag-eval.mjs` 必须输出机器可读 JSON + 人读摘要：

| 指标 | 定义 |
| --- | --- |
| `recall@k` | golden 问题的期望 chunkId 是否落在 top-k |
| `mrr` | 期望 chunk 的排名倒数均值 |
| `refusalAccuracy` | 该拒答的题（库里没有的）是否正确拒答 |
| `citationValidity` | 答案里的 `[n]` 是否都能在 citations 里找到（**只对有 LLM 时跑**） |

`data/eval/kb-golden.json` 格式：
```json
{
  "version": 1,
  "cases": [
    { "id": "c01", "question": "...", "expectChunkIds": ["mountain:yibang#0"],
      "expectTypes": ["mountain"], "shouldRefuse": false }
  ]
}
```
要求：≥ 30 条，覆盖山头/产品/合规三类，其中 ≥ 5 条是**库里没有的**题目（测拒答）。
期望 chunkId 必须与 `buildChunks` 的真实输出对齐（先跑 `buildChunks` 打印再填）。

## 10. 完成标准（所有人）

- `node scripts/rag-smoke.mjs` 退出码 0
- `node scripts/rag-eval.mjs --offline`（不调 LLM）recall@5 ≥ 0.7
- 不新增任何 npm 依赖
- 自己改的文件自己能跑起来，并且**跑过**再说完成
