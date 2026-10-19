/**
 * 零依赖本地向量化。
 *
 * 为什么是字符 n-gram 而不是"关键词匹配的包装"：中文没有空格，任何词表都覆盖不全
 * 山头/茶品的别名与错别字；字符 2-gram + 3-gram 是无需词典、对未登录词天然友好的
 * 稀疏表示，再用带符号哈希压到 512 维稠密向量，短查询与长段落就能比余弦。
 *
 * 哈希必须是确定性的（FNV-1a），否则同一份语料两次构建索引会得到不同排名；
 * 这里不依赖对象键序、时间或随机数。
 *
 * 模块顶层不做任何文件 IO —— 向量化要能被纯函数式调用，也不能拖慢引入方启动。
 */

export const DIM = 512;

/** 哈希函数的碰撞概率与维度无关，只与桶数有关：512 桶 + 有符号累加足够区分茶类语料。 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 标点与空白一律丢掉：它们不携带语义，留着只会让 n-gram 维度被排版噪声占满
const NOISE_RE = /[\s\u3000·・\-—_–()（）【】〔〕「」『』“”‘’"'`,，。；;：:!！?？、/\\|~～]+/g;

/** 归一化：大小写、全角标点、空白都会造成同一句话哈希到不同桶。 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(NOISE_RE, '');
}

const MAX_TOKEN_CACHE = 4096;
const tokenCache = new Map();

function cacheTouch(map, key) {
  const v = map.get(key);
  if (v === undefined) return undefined;
  map.delete(key); // 重新插入 = LRU 提权
  map.set(key, v);
  return v;
}

function cachePut(map, key, v, max = MAX_TOKEN_CACHE) {
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, v);
  return v;
}

/**
 * 字符 n-gram 分词器：embed 与 BM25 共用同一份切分，两路通道才可比。
 * 返回带重复项的数组（词频由调用方统计），长度 1 的文本退化为单字，避免零向量。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = normalize(text);
  if (!s) return [];
  const cached = cacheTouch(tokenCache, s);
  if (cached) return cached;

  const out = [];
  if (s.length === 1) out.push(s);
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  }
  return cachePut(tokenCache, s, out);
}

const IDF_IDS = new WeakMap();
let idfSeq = 0;

/**
 * 语料级 IDF。文档频率放进 Map 而不是数组，是为了让 OOV（查询里有、库里没有）
 * 的 gram 走默认值，而不是下标越界。
 *
 * minDf 默认 2 是关键取舍：只出现在一个 passage 里的 gram 在语料里只有一个"家"，
 * 它既不可能被别的查询命中，又会把该向量的模长撑大（512 维本来就不宽裕），
 * 结果是把真正命中的稀有词淹在哈希碰撞噪声里。实测把它滤掉后，
 * 「直播间能不能说降三高」这条查询的目标块从向量第 362 名升到前排。
 * 词法通道不受影响 —— BM25 侧仍然保留 df=1 的 gram，那是最强的精确命中信号。
 *
 * @param {string[]} texts
 * @param {object} [opts]
 * @param {number} [opts.minDf=2]  低于该文档频率的 gram 不进向量空间
 * @returns {Map<string,number>} gram -> idf
 */
export function computeIdf(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts : [];
  const minDf = Number.isFinite(Number(opts.minDf)) ? Number(opts.minDf) : 2;
  const n = list.length;
  const df = new Map();
  for (const t of list) {
    // 同一文档内的重复 gram 只计一次，否则 idf 会被长段落带偏
    for (const g of new Set(tokenize(t))) df.set(g, (df.get(g) || 0) + 1);
  }
  const idf = new Map();
  for (const [g, d] of df) if (d >= minDf) idf.set(g, Math.log((n + 1) / (d + 0.5)));
  idfSeq += 1;
  IDF_IDS.set(idf, idfSeq);
  return idf;
}

function idfOf(gram, idf) {
  if (!idf) return 1; // 不传语料时退化为纯次线性 TF，仍是真实向量而非关键词表
  const v = idf.get(gram);
  return v === undefined ? 0 : v;
}

const MAX_VEC_CACHE = 8192;
const vecCache = new Map();

/**
 * 把文本编码成 L2 归一化后的稠密向量。
 *
 * @param {string} text
 * @param {Map<string,number>} [idf]  computeIdf() 的产物；传入则用 TF-IDF 权重，
 *                                    不传则用 TF 权重（同样归一化，可直接点积）
 * @param {object} [opts]
 * @param {boolean} [opts.binaryTf]  忽略词频，只记"出现过"
 * @param {number} [opts.maxGrams]   每篇只保留权重最高的前 K 个 gram（0=不限）
 * @returns {Float32Array} 长度 DIM
 */
export function embed(text, idf, opts = {}) {
  const id = idf ? IDF_IDS.get(idf) || 0 : 0;
  const binaryTf = !!opts.binaryTf;
  const maxGrams = Number(opts.maxGrams) || 0;
  const key = `${id}|${binaryTf ? 1 : 0}|${maxGrams}\u0000${text}`;
  const hit = cacheTouch(vecCache, key);
  if (hit) return hit;

  const vec = new Float32Array(DIM);
  const tf = new Map();
  for (const g of tokenize(text)) tf.set(g, (tf.get(g) || 0) + 1);

  let items = [];
  for (const [gram, count] of tf) {
    const weight = (binaryTf ? 1 : 1 + Math.log(count)) * idfOf(gram, idf);
    if (weight) items.push([gram, weight]);
  }
  // 只保留权重最高的 K 个 gram：512 维装不下长正文的全部 n-gram，
  // 冗余 gram 会让模长虚高、并制造哈希碰撞噪声
  if (maxGrams > 0 && items.length > maxGrams) {
    items = items.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, maxGrams);
  }

  for (const [gram, weight] of items) {
    const h = fnv1a(gram);
    // 有符号哈希：同一桶上的不同 gram 正负相消，比全正累加更能抵抗 512 维的碰撞噪声
    const sign = h >>> 31 ? -1 : 1;
    vec[(h & 0x7fffffff) % DIM] += sign * weight;
  }

  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;

  cachePut(vecCache, key, vec, MAX_VEC_CACHE);
  return vec;
}

/**
 * 两个 L2 归一化向量的点积。
 *
 * 语义上这是「带符号 n-gram 哈希的余弦相似度」，**取值范围是 [-1, 1]，可以为负** ——
 * 带符号哈希让同一桶上的不同 gram 正负相消（抗 512 维碰撞），代价就是负值不再是
 * 理论不可能。检索侧因此把 ≤0 的文档当作"该通道没命中"排除，而不是当作"相似度 0"。
 * 两边都假定已 L2 归一化，所以直接点积即可。
 */
export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a?.length || 0, b?.length || 0);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** 测试与长驻进程用：清掉两个缓存，再看一次冷启动行为。 */
export function clearEmbedCache() {
  tokenCache.clear();
  vecCache.clear();
}
