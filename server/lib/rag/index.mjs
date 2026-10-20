/**
 * RAG 索引门面：chunk → embed → retriever 一次装好，并做进程内单例。
 *
 * ## 签名为什么用「内容哈希」而不是「updatedAt + 条目数」
 *
 * 早期版本用 `updatedAt + 各数组长度` 当签名，注释里写着"条目数兜住手改数据"。
 * **实测发现这会漏**：`saveKB()` 把 updatedAt 写成 `YYYY-MM-DD`（只到天），
 * 所以**同一天内的第二次编辑**——比如上午改了一个价格、下午又改了另一个——
 * 条形数量没变、日期也没变，签名完全一样，索引就不会重建。
 * 结果是管理员改了知识库，RAG 还在拿旧索引回答，看上去像"改了没用"。
 *
 * 现在改成对内容做 sha1（取前 12 位）。
 * 成本实测：552 块的知识库 JSON.stringify + sha1 ≈ **1ms**，而重建索引要 **100ms** ——
 * 用 1ms 换掉一整类"改了不生效"的 bug，非常划算。
 * 签名里仍然保留日期和条目数，只是为了日志可读，不参与判断。
 *
 * 合规词库单独参与哈希，因为它不在 kb 里，却是问答必须覆盖的一类。
 */
import crypto from 'node:crypto';

import { loadKB } from '../kb.mjs';
import { loadCompliance } from '../compliance.mjs';
import { buildChunks } from './chunk.mjs';
import { createRetriever } from './retrieve.mjs';

let cached = null;

/** 内容指纹：稳定 JSON 化后取 sha1 前 12 位。 */
function hashOf(obj) {
  let json;
  try {
    json = JSON.stringify(obj ?? {});
  } catch {
    json = '';
  }
  return crypto.createHash('sha1').update(json, 'utf8').digest('hex').slice(0, 12);
}

function signatureOf(kb, compliance) {
  const src = kb || {};
  const counts = [
    (src.regions || []).length,
    (src.mountains || []).length,
    (src.products || []).length,
    (src.tags || []).length,
    (src.topics || []).length,
    (compliance?.categories || []).length,
    (compliance?.patterns || []).length,
    (compliance?.contextRules || []).length,
  ].join(',');
  // 形如 `kb:abc123def456|cmp:0011aabbccdd|2026-10-20|4,44,38,16,4,12,17,10`
  // 后面两段只给人看，真正决定是否重建的是前两个哈希
  return `kb:${hashOf(src)}|cmp:${hashOf(compliance)}|${src.updatedAt || ''}|${counts}`;
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
