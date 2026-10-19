/** 稿子写作工具：确定性随机 + 时长估算 + 模板填充。 */

export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：同一场直播重复生成得到同一份稿子，改种子才变。 */
export function makeRng(seed) {
  let a = hashStr(String(seed));
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function pickN(rng, arr, n) {
  const copy = [...(arr || [])];
  const out = [];
  while (copy.length && out.length < n) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

export function maybe(rng, p = 0.5) {
  return rng() < p;
}

/** 中文口播语速，约 240 字/分钟（留出停顿与互动空间）。 */
export const CHARS_PER_MIN = 240;

export function charCount(s) {
  return String(s ?? '').replace(/\s/g, '').length;
}

export function talkMinutes(text) {
  return charCount(text) / CHARS_PER_MIN;
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** 模板填充：{key} 占位，缺失时用回退值。 */
export function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') return '';
    return String(v);
  });
}

/** 清理因为变量缺失留下的空标点/空格，避免稿子里出现「，。」这种。 */
export function tidy(text) {
  return String(text)
    .replace(/\s*([，。、；：！？])\s*/g, '$1')
    .replace(/([，、；：])([，。、；：！？])/g, '$2')
    .replace(/[，、；：]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 按目标时长挑选段落簇：永远保留第 1 簇（开场必须有），
 * 之后顺序追加直到字数到达目标。
 */
export function fitClusters(clusters, targetMinutes, opts = {}) {
  const ratio = opts.ratio ?? 0.82; // 留一部分时间给互动和停顿
  const targetChars = Math.max(60, targetMinutes * CHARS_PER_MIN * ratio);
  const out = [];
  let n = 0;
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (!cluster || !cluster.length) continue;
    out.push(cluster);
    n += cluster.reduce((s, l) => s + charCount(l.text), 0);
    if (n >= targetChars) break;
  }
  if (!out.length && clusters.length) out.push(clusters[0]);
  return out.flat();
}

export function round(n, step = 10) {
  return Math.round(n / step) * step;
}

export function yuan(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString('zh-CN');
}
