/**
 * 纯检索接口（不调模型）。
 *
 * 单独存在的理由：调参和排错时最需要的就是"**先看检索结果**"。
 * 回答错了有两种原因 —— 检索没取对，或者模型没用对片段 —— 只有把检索
 * 结果单独暴露出来，才能区分这两者。前端「只看检索结果」按钮走的就是这里。
 */
import { getIndex } from './index.mjs';

/** 给前端展示用的片段裁剪长度。原文可能 400 字，全塞回去页面没法看。 */
const SNIPPET = 240;

/**
 * @param {object} kb
 * @param {string} question
 * @param {object} [opts]
 * @param {number} [opts.k=8]
 */
export function searchKnowledge(kb, question, opts = {}) {
  const q = String(question ?? '').trim();
  if (!q) throw Object.assign(new Error('question 不能为空'), { code: 'BAD_QUESTION' });

  const k = Math.min(Math.max(Number(opts.k) || 8, 1), 30);
  const index = opts.index || getIndex(kb);
  const hits = index.retriever.search(q, k);

  return {
    question: q,
    hits: hits.map((h) => ({
      id: h.chunk.id,
      title: h.chunk.title,
      type: h.chunk.type,
      sourceId: h.chunk.sourceId,
      tags: h.chunk.tags,
      // 完整 text 给前端做高亮/展开，snippet 给列表默认展示
      text: h.chunk.text,
      snippet: h.chunk.text.length > SNIPPET ? `${h.chunk.text.slice(0, SNIPPET)}…` : h.chunk.text,
      score: Number(h.score.toFixed(4)),
      scores: h.scores,
      reasons: h.reasons,
    })),
    meta: {
      k,
      top1: hits.length ? Number(hits[0].score.toFixed(4)) : 0,
      index: index.retriever.stats(),
    },
  };
}
