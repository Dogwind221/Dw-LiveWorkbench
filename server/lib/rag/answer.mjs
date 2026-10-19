/**
 * 知识库问答（RAG 的回答层）。
 *
 * 这一层的职责只有三件，都不含检索算法本身：
 *   1. 把检索到的 passage 编号后塞进 prompt，逼模型用 [n] 引用
 *   2. 校验模型吐出来的 [n] 是否真的对应某条 passage（**不许出现无出处的编号**）
 *   3. 证据不足时拒答 —— 宁可说"库里没有"，也不能编
 *
 * 第 3 条是这个项目存在的意义：直播场景里一句编造的"树龄 500 年"是合规事故。
 *
 * 但**实现方式改过一次**，值得记下来：最初打算用"检索分低于阈值就不调模型"来兜，
 * 实测证明走不通（见下面 MIN_BM25 的注释）。现在的分工是：
 * 分数闸只兜最明显的空枪，真正的拒答判断交给模型读证据后自觉。
 */
import { getIndex } from './index.mjs';
import { createLlm } from '../llm.mjs';

/**
 * 前置分数闸 —— 职责只有一条：**兜住最明显的空枪**，别浪费一次模型调用。
 *
 * 曾经想让它承担全部拒答职责，是错的。标注集扩到 18 条库外题后实测：
 * 库外题的最高 BM25（21.6）比一半正常问题还高，两类得分完全交错，
 * **不存在能分开它们的阈值**。原因见 README-rag.md「别指望阈值能解决拒答」。
 *
 * 所以这里故意设得**保守**：宁可放过（交给模型判），不可误杀正常问题。
 * 拒答的主力是 prompt 哨兵 + 模型自拒，不是这两个数。
 *
 * 两个数的分工也不一样：
 *   - BM25 阈值是**主闸**，但只兜最明显的空枪（设 7，远低于扫描最优的 19）
 *   - 向量阈值是**纯安全网**。判定是"且"，所以它越大越宽松 —— 设成 0.163 让它基本不约束，
 *     只在两路都极低时才一起拦。设小了反而会把 BM25 已经抓到的库外题又放出去。
 */
const MIN_BM25 = Number(process.env.RAG_MIN_BM25 || 7);
const MIN_VECTOR = Number(process.env.RAG_MIN_VECTOR || 0.163);

/**
 * 模型被要求：证据不足时只输出这个记号。用记号而不是让模型自由发挥，是为了能机械判定。
 *
 * 分两档而不是一档，是因为"库里没有"和"库里只有沾边的"对主播是两件事：
 * 前者该换话题，后者可以顺着答一半并说清边界。糊成一档会逼模型撒谎。
 */
const NO_EVIDENCE = '[[NO_EVIDENCE]]';
const PARTIAL_EVIDENCE = '[[PARTIAL_EVIDENCE]]';

/**
 * 拒答时回给用户的话。
 *
 * 拒答**不等于**返回空字符串：空字符串在界面上看起来像"系统坏了"，
 * 而"知识库里确实没有"是一个正常且有价值的结论。两种情况都要有人话。
 */
const REFUSAL_TEXT = '知识库里没有能回答这个问题的内容，没有编造。补一条知识库条目，或者换个问法再问一次。';

const SYSTEM = `你是普洱茶直播工作台的客服知识助手。你只依据给定的资料片段回答。

规则（必须严格遵守）：
1. 只使用【资料】里的内容回答，不要引入资料之外的知识，也不要凭常识补全。
2. 每一条事实性陈述后面都要标出来源编号，格式 [1]、[2]，编号必须来自【资料】里给的编号。
3. 资料**完全答不了**这个问题时（问的是别的茶类、物流售后、平台政策等资料里没有的领域），
   只输出 ${NO_EVIDENCE}，不要输出任何其他字符。
4. 资料**只有部分相关**、能答一部分但答不全时，用 ${PARTIAL_EVIDENCE} 开头，
   然后只说资料支持的那部分并标引用，最后一句说清楚哪部分资料里没有。不要为补全而编。
5. 资料里标注为 medium 置信度的价格、海拔等浮动数值，回答时要说明"参考区间"。
6. 涉及功效宣称（如降三高、治病）时不要替商家做承诺，只陈述资料原文并提示合规风险。
7. 用口语化中文回答，控制在 200 字以内，不要说"根据资料"这种废话开头。`;

/** 把 hit 列表拼成带编号的资料块。编号从 1 开始，和 prompt 里的 [n] 对应。 */
function renderEvidence(hits) {
  return hits
    .map((h, i) => {
      const meta = h.chunk.meta || {};
      const tag = meta.confidence ? `（置信度 ${meta.confidence}）` : '';
      return `[${i + 1}] ${h.chunk.title}${tag}\n${h.chunk.text}`;
    })
    .join('\n\n');
}

/**
 * 从答案里抽出被真正引用过的编号，并和 hits 对齐。
 * 关键：只回传**被引用**的那些，没被引用的片段不进 citations，否则前端会以为模型用了它们。
 */
function collectCitations(answer, hits) {
  const used = new Set();
  for (const m of String(answer).matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= hits.length) used.add(n);
  }
  return [...used]
    .sort((a, b) => a - b)
    .map((n) => {
      const h = hits[n - 1];
      return {
        n,
        chunkId: h.chunk.id,
        title: h.chunk.title,
        sourceId: h.chunk.sourceId,
        type: h.chunk.type,
        score: Number(h.score.toFixed(4)),
      };
    });
}

/**
 * @param {object} kb            loadKB() 的返回值
 * @param {string} question
 * @param {object} [opts]
 * @param {number} [opts.k=6]    送进 prompt 的片段数
 * @param {number} [opts.minBm25]    词法通道证据下限（覆盖 env RAG_MIN_BM25）
 * @param {number} [opts.minVector]  向量通道证据下限（覆盖 env RAG_MIN_VECTOR）
 * @param {object} [opts.llm]    注入用（测试时传 stub，避免真调模型）
 * @param {object} [opts.index]  注入用
 */
export async function answerKnowledge(kb, question, opts = {}) {
  const q = String(question ?? '').trim();
  if (!q) throw Object.assign(new Error('question 不能为空'), { code: 'BAD_QUESTION' });

  const k = Math.min(Math.max(Number(opts.k) || 6, 1), 20);
  const minBm25 = Number.isFinite(opts.minBm25) ? opts.minBm25 : MIN_BM25;
  const minVector = Number.isFinite(opts.minVector) ? opts.minVector : MIN_VECTOR;

  const index = opts.index || getIndex(kb);
  const hits = index.retriever.search(q, k);

  // 两个通道各自的最好成绩。取"最大值"而不是只看 top1，是因为融合后的 top1
  // 可能由另一路抬上来，用它的单通道分反而低估了证据。
  let bestBm25 = 0;
  let bestVector = 0;
  for (const h of hits) {
    bestBm25 = Math.max(bestBm25, h.scores?.bm25 ?? 0);
    bestVector = Math.max(bestVector, h.scores?.vector ?? 0);
  }

  const weak = bestBm25 < minBm25 && bestVector < minVector;
  if (!hits.length || weak) {
    return {
      // 与模型自拒保持同一句人话，前端不用为两种拒答写两套展示
      answer: REFUSAL_TEXT,
      citations: [],
      hits,
      refused: true,
      reason: hits.length
        ? `证据不足（BM25 ${bestBm25.toFixed(2)} < ${minBm25} 且 向量 ${bestVector.toFixed(3)} < ${minVector}）`
        : '知识库里没有任何可检索内容',
      meta: {
        stage: 'pre-llm',
        bestBm25: Number(bestBm25.toFixed(3)),
        bestVector: Number(bestVector.toFixed(4)),
        thresholds: { bm25: minBm25, vector: minVector },
        index: index.retriever.stats(),
      },
    };
  }

  const llm = opts.llm || createLlm();
  const user = `【资料】\n${renderEvidence(hits)}\n\n【问题】${q}`;

  let res;
  try {
    res = await llm.chat({ messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ], temperature: 0.2 });
  } catch (err) {
    // 模型不可用时不要把检索结果一起丢掉：把片段按引用格式返回，前端仍能人工处置
    return {
      answer: '',
      citations: collectCitations(hits.map((_, i) => `[${i + 1}]`).join(''), hits),
      hits,
      refused: false,
      degraded: true,
      reason: `模型通道不可用：${err.message}`,
      meta: { stage: 'llm-failed', bestBm25, bestVector },
    };
  }

  const raw = String(res.text || '').trim();
  const refused = raw.includes(NO_EVIDENCE) || raw === '';
  // 「部分相关」是介于"答得出来"和"完全没资料"之间的第三种结果：答一半、说清边界。
  // 把它和正常回答区分开，前端可以提示"以下内容不完整"，主播就不会照着念满。
  const partial = !refused && raw.includes(PARTIAL_EVIDENCE);
  const text = partial ? raw.replace(PARTIAL_EVIDENCE, '').trim() : raw;

  return {
    answer: refused ? REFUSAL_TEXT : text,
    citations: refused ? [] : collectCitations(text, hits),
    hits,
    refused,
    partial,
    reason: refused ? '模型判定资料不足以回答' : undefined,
    meta: {
      stage: 'ok',
      bestBm25: Number(bestBm25.toFixed(3)),
      bestVector: Number(bestVector.toFixed(4)),
      ...res.meta,
    },
  };
}

export { MIN_BM25, MIN_VECTOR, NO_EVIDENCE, PARTIAL_EVIDENCE };
