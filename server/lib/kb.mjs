import { readJson, writeJson } from './store.mjs';
import { snapshotSeed } from './paths.mjs';

const FILE = 'knowledge.json';

const EMPTY = {
  version: 1,
  updatedAt: '',
  disclaimer: '',
  regions: [],
  mountains: [],
  products: [],
  tags: [],
};

export function loadKB() {
  snapshotSeed(FILE);
  const kb = readJson(FILE, null);
  if (!kb) return structuredClone(EMPTY);
  return {
    ...structuredClone(EMPTY),
    ...kb,
    regions: kb.regions || [],
    mountains: kb.mountains || [],
    products: kb.products || [],
    tags: kb.tags || [],
  };
}

export function saveKB(kb) {
  // 用完整时间戳，不要只写日期。
  // 索引缓存靠这个字段判断要不要重建；只写 `YYYY-MM-DD` 的话，
  // 同一天内的第二次编辑签名不变 → 索引不重建 → RAG 继续拿旧数据回答。
  // （kb-file.mjs 的导入路径本来就是完整时间戳，这里改成一致。）
  kb.updatedAt = new Date().toISOString();
  writeJson(FILE, kb);
  return kb;
}

export function kbStats(kb) {
  return {
    regions: kb.regions.length,
    mountains: kb.mountains.length,
    products: kb.products.length,
    tags: (kb.tags || []).length,
    updatedAt: kb.updatedAt,
  };
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s\u3000·・\-_()（）【】]/g, '');

/** 按 id / 名称 / 别名查找山头，支持模糊（"老班章" -> "班章" 也能命中）。 */
export function findMountain(kb, query) {
  if (!query) return null;
  const q = norm(query);
  if (!q) return null;
  const list = kb.mountains || [];

  const byId = list.find((m) => norm(m.id) === q);
  if (byId) return byId;

  const byName = list.find((m) => norm(m.name) === q);
  if (byName) return byName;

  const byAlias = list.find((m) => (m.alias || []).some((a) => norm(a) === q));
  if (byAlias) return byAlias;

  // 包含匹配：优先选择名字更长（更具体）的那个，避免"冰岛"匹配到"冰岛坝歪"
  const contained = list
    .filter((m) => {
      const names = [m.name, ...(m.alias || [])].map(norm);
      return names.some((n) => n && (n.includes(q) || q.includes(n)));
    })
    .sort((a, b) => norm(b.name).length - norm(a.name).length);
  return contained[0] || null;
}

/** 按关键词命中知识条目（products），返回全部匹配项。 */
export function findProducts(kb, keywords = []) {
  const list = kb.products || [];
  const keys = keywords.map(norm).filter(Boolean);
  if (!keys.length) return [];
  const scored = [];
  for (const p of list) {
    const hay = [p.id, p.name, p.category, ...(p.aka || [])].map(norm);
    let score = 0;
    for (const k of keys) {
      for (const h of hay) {
        if (!h) continue;
        if (h === k) score += 3;
        else if (h.includes(k) || k.includes(h)) score += 1;
      }
    }
    if (score > 0) scored.push({ p, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.p);
}

/** 全局搜索：山头 + 茶品，供 UI 搜索框使用。 */
export function searchKB(kb, q) {
  const query = norm(q);
  if (!query) return { mountains: [], products: [] };
  const mountains = (kb.mountains || []).filter((m) =>
    [m.id, m.name, m.region, m.area, ...(m.alias || []), ...(m.aroma || []), ...(m.taste || [])]
      .map(norm)
      .some((s) => s && s.includes(query))
  );
  const products = (kb.products || []).filter((p) =>
    [p.id, p.name, p.category, p.summary, ...(p.aka || []), ...(p.points || [])]
      .map(norm)
      .some((s) => s && s.includes(query))
  );
  return { mountains, products };
}

export function listRegions(kb) {
  const names = new Set((kb.regions || []).map((r) => r.name));
  for (const m of kb.mountains || []) if (m.region) names.add(m.region);
  return [...names];
}

export function upsertMountain(kb, item) {
  const list = kb.mountains || (kb.mountains = []);
  const idx = list.findIndex((m) => m.id === item.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item, updatedAt: new Date().toISOString() };
  else list.push(item);
  return saveKB(kb);
}

export function upsertProduct(kb, item) {
  const list = kb.products || (kb.products = []);
  const idx = list.findIndex((p) => p.id === item.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item, updatedAt: new Date().toISOString() };
  else list.push(item);
  return saveKB(kb);
}
