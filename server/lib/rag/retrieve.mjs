/**
 * 双通道检索：BM25（词法）+ 向量（语义），用加权 RRF 融合两路**排名**。
 *
 * 为什么不直接加权原始分：BM25 是 0～10 量级的开放分数，余弦是 -1～1，
 * 相加等于让 BM25 单方面决定排序。RRF 只看名次（1/(k+rank)），天然免疫量纲。
 *
 * 为什么不是等权 RRF：在 60 这个平滑常数下 rank 3 与 rank 11 只差 0.0015，
 * 「向量第 1、BM25 第 11」会被拉平到第 4 名 —— 融合反而抹掉了信息。实测两路
 * 质量并不对称（词法更准），所以按权重合并且把 rrfK 从 60 压到 5（见 DEFAULTS.rrfK），
 * 把名次差异放大回来。
 *
 * 两路共用 embed.mjs 的字符 n-gram 分词器：分词口径不一致时，两路会各说各话，
 * 融合反而比单路更差。
 */
import { DIM, embed, cosine, tokenize, computeIdf, normalize } from './embed.mjs';

const DEFAULTS = {
  k1: 1.2,
  b: 0.75,
  rrfK: 5,
  wBM25: 0.9,
  wVector: 0.1,
  minDf: 2,
  maxGrams: 0,
  entityBoost: 0.08,
  entityGuarantee: true,
  k: 8,
};
const MAX_QUERY_GRAMS = 256; // 超长查询（整段粘进来）时给打分复杂度兜个底
/**
 * 标题里的实体名/字段名在索引文本里重复的次数（见 indexTextOf）。
 *
 * 已知取舍：次数越高，实体类问题越准（「为什么倚邦的汤水比较细」靠它从 BM25 第 11
 * 救到第 1），但「实体名 + 另一意图」的混合问句会被实体灌满 —— c28「我在直播间
 * 能不能说『这是今年最好的老班章』」期望的 compliance:absolute 块因此掉到第 20。
 * 实测降到 2/4 会让 MRR 从 0.634 掉到 0.560/0.622，收益面明显小于代价，故维持 6。
 * 要根治得引入查询意图识别（新功能），不是调参能解决的。
 */
const TITLE_BOOST = 6;
/**
 * 每个被点名实体最多给几个块加实体分：不设上限时，一个山头的 5 个兄弟块会被
 * 整体抬起、垄断 top-k（实测 r@5 0.947→0.921、coverage@5 满分→0.951/0.926）。
 *
 * ⚠️ 本项与 `k` 的取值耦合，不是独立参数：回答层实际拿 k=6 个片段喂模型，
 * 所以 top-3 与 top-4~6 对它没有行为差别 ——「boost 只给前 2 块」换来的
 * r@5 +0.026 / coverage@5 满分，代价是 r@3 −0.026，而丢的那 0.026 落在
 * top-4~6，照样进 prompt。**这个交换在回答层不可见，只在指标层可见。**
 * 若将来把 k 下调到 ≤3（新前端选择器 / 新调用方），r@3 就变成决策相关指标，
 * 必须重新评估本项，届时需要回退到「名下全块加分」。
 */
const ENTITY_TOP_N = 2;
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

// passage 首行形如 `山头：倚邦（别名：倚邦古茶山）` / `产区：西双版纳`
const ENTITY_HEAD_RE = /^[^：\n]{1,8}：([^（\n]+)(?:（别名：([^）\n]*)）)?/;

/**
 * 从 passage 自身反解实体词表（名字 + 别名 → sourceId）。
 * 这样 createRetriever(chunks) 不用多收一个 kb 参数，评测/冒烟里现有的调用方式不用改。
 */
function buildEntityLexicon(list) {
  const lex = new Map();
  for (const c of list) {
    const head = String(c.text || '').split('\n')[0] || '';
    const m = ENTITY_HEAD_RE.exec(head);
    if (!m || !c.sourceId) continue;
    for (const name of [m[1], ...(m[2] ? m[2].split('、') : [])]) {
      const key = normalize(name);
      // 单字名字（如「易」）会在任何问句里误命中，直接丢掉
      if (key.length >= 2) lex.set(key, c.sourceId);
    }
  }
  return lex;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 索引文本 = 实体名/字段名加权 + 正文。
 *
 * 为什么需要：正文平均 215 字，而实体名只在块首出现一次，它的 2-gram 权重被长度
 * 摊薄 —— 「为什么倚邦的汤水比较细」里倚邦块 BM25 只有第 11 名。把 title 里的
 * 实体名与字段名重复若干次，等于给这两类高判别力的 gram 一个可控的词频加成；
 * 同时前缀是定长的，等于是给每篇加了一个"长度基线"，BM25 的长度归一化
 * 不再因为块长短差异而放大噪声。重复 6 次是坐标下降实测的最优值
 * （golden 的 MRR 0.482 → 0.634），且不改 passage 本身的契约字段。
 */
export function indexTextOf(chunk) {
  const title = String(chunk?.title || '');
  const cut = title.indexOf(' · ');
  const name = cut > 0 ? title.slice(0, cut) : title;
  const field = cut > 0 ? title.slice(cut + 3).replace(/（第\d+段）$/, '') : '';
  const head = `${Array(TITLE_BOOST).fill(name).join(' ')} ${Array(TITLE_BOOST).fill(field || name).join(' ')}`;
  return `${head}\n${chunk?.text || ''}`;
}

/**
 * @param {Array} chunks  buildChunks() 的产物
 * @param {object} [opts]
 * @param {number} [opts.k1=1.2]      BM25 词频饱和参数
 * @param {number} [opts.b=0.75]      BM25 长度归一化强度
 * @param {number} [opts.rrfK=5]      RRF 平滑常数（越小，名次差异越被放大）
 * @param {number} [opts.wBM25=0.9]   词法通道权重
 * @param {number} [opts.wVector=0.1] 向量通道权重（合规词条这类短块上向量通道偏噪，实测权重 0.9/0.1 的双指标最优）
 * @param {(c:object)=>string} [opts.indexText] 自定义索引文本，默认 indexTextOf
 * @param {number} [opts.minDf=2]      低于该文档频率的 gram 不进向量空间
 * @param {boolean} [opts.binaryTf=true] 向量侧只记"出现过"，不记词频
 * @param {number} [opts.maxGrams=0]  向量侧每篇保留权重最高的前 K 个 gram（0=不限）
 * @param {number} [opts.entityBoost=0.08] 问句点名实体的融合分加成（0=关闭）
 * @param {boolean} [opts.entityGuarantee=true] 为点名实体各保底留一个名额（传 false 关闭）
 * @returns {object} Retriever
 */
export function createRetriever(chunks, opts = {}) {
  const t0 = Date.now();
  const list = (Array.isArray(chunks) ? chunks : []).filter((c) => c && typeof c.id === 'string');
  const k1 = num(opts.k1, DEFAULTS.k1);
  const b = num(opts.b, DEFAULTS.b);
  const rrfK = num(opts.rrfK, DEFAULTS.rrfK);
  const wBM25 = num(opts.wBM25, DEFAULTS.wBM25);
  const wVector = num(opts.wVector, DEFAULTS.wVector);
  const buildText = typeof opts.indexText === 'function' ? opts.indexText : indexTextOf;
  const minDf = num(opts.minDf, DEFAULTS.minDf);
  const vecOpts = { binaryTf: opts.binaryTf !== false, maxGrams: num(opts.maxGrams, DEFAULTS.maxGrams) };
  const entityBoost = Math.max(0, num(opts.entityBoost, DEFAULTS.entityBoost));
  // 默认开启：显式传 false 才关。多实体对比是直播高频提问，top3 被一边占满等于直接答错
  const entityGuarantee = opts.entityGuarantee !== false;
  const entityLex = buildEntityLexicon(list);
  const N = list.length;

  const byId = (x, y) => (list[x].id < list[y].id ? -1 : list[x].id > list[y].id ? 1 : 0);
  /** 同分按 chunk.id 字典序：否则排序稳定性会随引擎版本漂移，排名复现不了。 */
  const compare = (scores, x, y) => scores[y] - scores[x] || byId(x, y);

  const texts = list.map((c) => buildText(c));
  // IDF 必须在全语料上算：单块自己算 IDF 会让「常见字」在每个块里都变成罕见字
  const idf = computeIdf(texts, { minDf });
  const vectors = texts.map((t) => embed(t, idf, vecOpts));

  const tfs = [];
  const docLen = new Int32Array(N);
  let totalTokens = 0;
  for (let i = 0; i < N; i++) {
    const m = new Map();
    let len = 0;
    for (const g of tokenize(texts[i])) {
      m.set(g, (m.get(g) || 0) + 1);
      len += 1;
    }
    tfs.push(m);
    docLen[i] = len;
    totalTokens += len;
  }
  const avgdl = N ? totalTokens / N : 0;

  const df = new Map();
  for (const m of tfs) for (const g of m.keys()) df.set(g, (df.get(g) || 0) + 1);

  /** BM25 的 idf 用恒正形式，避免高频词拿到负权重把总分拉成负数。 */
  const bm25Idf = (g) => {
    const d = df.get(g) || 0;
    return Math.log(1 + (N - d + 0.5) / (d + 0.5));
  };

  function queryGrams(query) {
    const uniq = [];
    const seen = new Set();
    for (const g of tokenize(query)) {
      if (seen.has(g)) continue;
      seen.add(g);
      uniq.push(g);
      if (uniq.length >= MAX_QUERY_GRAMS) break;
    }
    return uniq;
  }

  function bm25Scores(query) {
    const s = new Float64Array(N);
    for (const g of queryGrams(query)) {
      if (!df.has(g)) continue;
      const idfG = bm25Idf(g);
      for (let i = 0; i < N; i++) {
        const tf = tfs[i].get(g);
        if (!tf) continue;
        const denom = tf + k1 * (1 - b + (b * docLen[i]) / (avgdl || 1));
        s[i] += (idfG * (tf * (k1 + 1))) / denom;
      }
    }
    return s;
  }

  function vectorScores(query) {
    const qv = embed(query, idf);
    const s = new Float64Array(N);
    for (let i = 0; i < N; i++) s[i] = cosine(qv, vectors[i]);
    return s;
  }

  /**
   * 查询里点名的实体。词表直接从 passage 的首行反解（`山头：倚邦（别名：…）`），
   * 这样 createRetriever(chunks) 的签名不用动，也不依赖 kb 对象。
   */
  function mentionedEntities(query) {
    if (!entityBoost && !entityGuarantee) return null;
    const q = normalize(query);
    if (!q) return null;
    const out = new Set();
    for (const [name, id] of entityLex) if (q.includes(name)) out.add(id);
    return out.size ? out : null;
  }

  /**
   * 名次表：0 表示该通道没给分（不计入 RRF）。
   * 零分文档必须排除，否则"两路都没命中"的块也会凭一个名次混进结果。
   */
  function rankOf(scores) {
    const idx = [];
    for (let i = 0; i < N; i++) if (scores[i] > 0) idx.push(i);
    idx.sort((x, y) => compare(scores, x, y));
    const ranks = new Int32Array(N);
    idx.forEach((doc, i) => {
      ranks[doc] = i + 1;
    });
    return ranks;
  }

  function hit(i, score, bm, ve, rb, rv, ent = false, boosted = false) {
    const reasons = [];
    if (rb) reasons.push(`BM25 #${rb}`);
    if (rv) reasons.push(`向量 #${rv}`);
    if (ent) reasons.push(`点名实体：${list[i].sourceId}`);
    return {
      chunk: list[i],
      score: round(score),
      scores: { bm25: round(bm), vector: round(ve), rrf: round(score), entityBoost: boosted ? entityBoost : 0 },
      reasons,
    };
  }

  function search(query, k = DEFAULTS.k) {
    const bm = bm25Scores(query);
    const ve = vectorScores(query);
    const rb = rankOf(bm);
    const rv = rankOf(ve);
    const ents = mentionedEntities(query);
    const fused = [];
    for (let i = 0; i < N; i++) {
      if (!rb[i] && !rv[i]) continue;
      const base = (rb[i] ? wBM25 / (rrfK + rb[i]) : 0) + (rv[i] ? wVector / (rrfK + rv[i]) : 0);
      fused.push({ i, base, rrf: base, bm: bm[i], ve: ve[i], rb: rb[i], rv: rv[i], named: !!(ents && ents.has(list[i].sourceId)), boosted: false });
    }
    fused.sort((x, y) => y.base - x.base || byId(x.i, y.i));

    // 候选 A（实体提升）：问句点名的实体加分。加常数而不是改权重，是为了只在
    // "分数本来接近"时改变名次，不去碾压 BM25 的判断。
    // 只给每个实体的前 ENTITY_TOP_N 个块加 —— 不设上限时，一个山头 5 个兄弟块
    // 全部被抬起来会把 top-k 垄断（实测 r@5 0.921 vs 0.947、coverage 0.951/0.926 vs 1.000/1.000）。
    if (ents && entityBoost > 0) {
      const taken = new Map();
      for (const r of fused) {
        if (!r.named) continue;
        const id = list[r.i].sourceId;
        const n = taken.get(id) || 0;
        if (n < ENTITY_TOP_N) {
          r.rrf = r.base + entityBoost;
          r.boosted = true;
          taken.set(id, n + 1);
        }
      }
    }
    fused.sort((x, y) => y.rrf - x.rrf || byId(x.i, y.i));

    // 候选 B（保底名额）：默认开启，`entityGuarantee:false` 可关。
    // A 只能保证"被点名的实体不缺席"，保证不了"每个被点名的实体都有代表" ——
    // 「南糯山和布朗山风格差多远」会被南糯山一个山头占满 top3，业务上等于答错。
    // 这里按组内最高分入选、挤掉末位（最低分）名额；实测 micro@5 0.805→0.951、
    // macro@5 0.778→0.926，MRR 0.749→0.748（噪声内）。
    if (entityGuarantee && ents) {
      const out = fused.slice(0, k);
      const have = new Set(out.map((r) => list[r.i].sourceId));
      for (const id of ents) {
        if (have.has(id)) continue;
        const best = fused.find((r) => list[r.i].sourceId === id);
        if (!best || out.some((r) => r.i === best.i)) continue;
        if (out.length >= k) out.pop();
        out.push(best);
        have.add(id);
      }
      out.sort((x, y) => y.rrf - x.rrf || byId(x.i, y.i));
      return out.map((r) => hit(r.i, r.rrf, r.bm, r.ve, r.rb, r.rv, r.named, r.boosted));
    }
    return fused.slice(0, k).map((r) => hit(r.i, r.rrf, r.bm, r.ve, r.rb, r.rv, r.named, r.boosted));
  }

  /** 仅词法通道：调试与评测对比用，score 就是原始 BM25 分。 */
  function searchBM25(query, k = DEFAULTS.k) {
    const s = bm25Scores(query);
    const idx = [];
    for (let i = 0; i < N; i++) if (s[i] > 0) idx.push(i);
    idx.sort((x, y) => compare(s, x, y));
    return idx.slice(0, k).map((i, n) => hit(i, s[i], s[i], 0, n + 1, 0));
  }

  /**
   * 仅向量通道：score 是「带符号 n-gram 哈希的余弦」（两边已归一化，即点积），
   * **可以为负**；负值只说明该文档更"不像"，这里按未命中处理（不进排名）。
   */
  function searchVector(query, k = DEFAULTS.k) {
    const s = vectorScores(query);
    const idx = [];
    for (let i = 0; i < N; i++) if (s[i] > 0) idx.push(i);
    idx.sort((x, y) => compare(s, x, y));
    return idx.slice(0, k).map((i, n) => hit(i, s[i], 0, s[i], 0, n + 1));
  }

  function stats() {
    return {
      chunks: N,
      dim: DIM,
      avgTokens: Math.round(avgdl * 10) / 10,
      buildMs: Date.now() - t0,
    };
  }

  return { search, searchBM25, searchVector, stats };
}
