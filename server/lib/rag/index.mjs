/**
 * RAG 索引门面：chunk → embed → retriever 一次装好，并做进程内单例。
 *
 * 为什么用「updatedAt + 条目数」当签名而不是深比较 kb：编辑器每次保存都会改
 * updatedAt，深比较整个 kb 的成本比重建索引还高；条目数兜住"更新了但日期没变"
 * 的手改数据。合规词库单独读，因为它不在 kb 里，却是问答必须覆盖的一类。
 */
import { loadKB } from '../kb.mjs';
import { loadCompliance } from '../compliance.mjs';
import { buildChunks } from './chunk.mjs';
import { createRetriever } from './retrieve.mjs';

let cached = null;

function signatureOf(kb, compliance) {
  const src = kb || {};
  return [
    src.updatedAt || '',
    (src.regions || []).length,
    (src.mountains || []).length,
    (src.products || []).length,
    (src.tags || []).length,
    (src.topics || []).length,
    compliance?.updatedAt || '',
    (compliance?.categories || []).length,
    (compliance?.patterns || []).length,
    (compliance?.contextRules || []).length,
  ].join('|');
}

/**
 * @param {object} kb  loadKB() 的返回值
 * @param {object} [opts]  透传给 createRetriever（k1 / b / rrfK）；compliance 可显式传入
 * @returns {{chunks:Array, retriever:object, builtAt:string, signature:string}}
 */
export function buildIndex(kb, opts = {}) {
  const src = kb || loadKB();
  const compliance = opts.compliance || src.compliance || loadCompliance();
  const chunks = buildChunks(src, { compliance });
  const retriever = createRetriever(chunks, opts);
  return {
    chunks,
    retriever,
    builtAt: new Date().toISOString(),
    signature: signatureOf(src, compliance),
  };
}

/** 进程内单例：kb 与合规词库都没变就直接复用，避免每个请求都重算 500 维向量。 */
export function getIndex(kb) {
  const src = kb || loadKB();
  const compliance = src.compliance || loadCompliance();
  const signature = signatureOf(src, compliance);
  if (cached && cached.signature === signature) return cached;
  cached = buildIndex(src, { compliance });
  return cached;
}

/** 评测/测试用：丢掉单例，强制下一次 getIndex 冷启动。 */
export function clearIndex() {
  cached = null;
}
