/**
 * 模块 5：合规违禁词检查。
 *
 * 三层检查：
 *   1) 词表匹配    —— 绝对化用语、功效宣称等固定词
 *   2) 正则匹配    —— 数字承诺、联系方式、年份虚标等模式
 *   3) 语境规则    —— 触发词 × 目标词 在窗口内共现（如「降」+「三高」）
 */
import { readJson, writeJson } from './store.mjs';
import { snapshotSeed } from './paths.mjs';

const FILE = 'compliance.json';

const LEVEL_SCORE = { high: 10, medium: 5, low: 2 };
const LEVEL_ORDER = { high: 3, medium: 2, low: 1 };

export function loadCompliance() {
  snapshotSeed(FILE);
  const c = readJson(FILE, null);
  if (!c) {
    return { version: 1, categories: [], patterns: [], contextRules: [] };
  }
  return {
    ...c,
    categories: c.categories || [],
    patterns: c.patterns || [],
    contextRules: c.contextRules || [],
    allowCompounds: c.allowCompounds || [],
    allowPatterns: c.allowPatterns || [],
  };
}

export function complianceStats(c) {
  const words = (c.categories || []).reduce((n, cat) => n + (cat.words || []).length, 0);
  return {
    categories: (c.categories || []).length,
    words,
    patterns: (c.patterns || []).length,
    contextRules: (c.contextRules || []).length,
    updatedAt: c.updatedAt,
  };
}

export function getWhitelist() {
  const s = readJson('settings.json', {}) || {};
  return Array.isArray(s.complianceWhitelist) ? s.complianceWhitelist : [];
}

export function addWhitelist(word) {
  const s = readJson('settings.json', {}) || {};
  const list = new Set(Array.isArray(s.complianceWhitelist) ? s.complianceWhitelist : []);
  list.add(word);
  s.complianceWhitelist = [...list];
  writeJson('settings.json', s);
  return s.complianceWhitelist;
}

export function removeWhitelist(word) {
  const s = readJson('settings.json', {}) || {};
  s.complianceWhitelist = (s.complianceWhitelist || []).filter((w) => w !== word);
  writeJson('settings.json', s);
  return s.complianceWhitelist;
}

function snippetOf(text, index, len) {
  const from = Math.max(0, index - 12);
  const to = Math.min(text.length, index + len + 12);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\n/g, ' ') + (to < text.length ? '…' : '');
}

/**
 * @param {string} text 待检文本（口播稿 / 文案 / 商品标题）
 * @returns {{hits:Array, warnings:Array, level:string, score:number, counts:object, cleaned:string, whitelist:string[]}}
 */
export function checkText(text, options = {}) {
  const kb = options.compliance || loadCompliance();
  const whitelist = options.whitelist || getWhitelist();
  const wl = new Set(whitelist);
  const src = String(text || '');
  const hits = [];
  const warnings = [];

  // 中性复合词豁免范围：命中区间若完整落在这些词内部，则视为误报。
  // 例：正则 /最[...多...]/ 会命中「最多」，但「最多」是中性词。
  const exempt = [];
  for (const compound of kb.allowCompounds || []) {
    if (!compound) continue;
    let from = 0;
    while (true) {
      const i = src.indexOf(compound, from);
      if (i < 0) break;
      exempt.push([i, i + compound.length]);
      from = i + compound.length;
    }
  }
  // 正则豁免：用于「第一泡」「树龄」这类行业正常表达，
  // 比逐个列举复合词更省事，也方便用户自己加规则。
  for (const pattern of kb.allowPatterns || []) {
    try {
      const re = new RegExp(pattern, 'g');
      let m;
      let guard = 0;
      while ((m = re.exec(src)) !== null && guard++ < 2000) {
        if (!m[0]) {
          re.lastIndex++;
          continue;
        }
        exempt.push([m.index, m.index + m[0].length]);
      }
    } catch {
      /* 忽略非法正则 */
    }
  }
  const isExempt = (index, len) => exempt.some(([s, e]) => index >= s && index + len <= e);

  const push = (bucket, entry) => {
    if (isExempt(entry.index, entry.length)) return;
    bucket.push(entry);
  };

  // 1) 词表
  for (const cat of kb.categories || []) {
    const catMode = cat.mode || 'block';
    for (const w of cat.words || []) {
      const word = w.word;
      if (!word || wl.has(word)) continue;
      const mode = w.mode || catMode;
      const bucket = mode === 'warn' ? warnings : hits;
      let from = 0;
      while (true) {
        const idx = src.indexOf(word, from);
        if (idx < 0) break;
        push(bucket, {
          kind: 'word',
          word,
          index: idx,
          length: word.length,
          level: w.level || cat.level || 'medium',
          category: cat.name || cat.id,
          categoryId: cat.id,
          suggest: w.suggest || '',
          note: w.note || cat.risk || '',
          snippet: snippetOf(src, idx, word.length),
        });
        from = idx + word.length;
        if (hits.length + warnings.length > 4000) break;
      }
    }
  }

  // 2) 正则
  for (const p of kb.patterns || []) {
    let re;
    try {
      re = new RegExp(p.regex, 'g');
    } catch {
      continue;
    }
    const bucket = (p.mode || 'block') === 'warn' ? warnings : hits;
    let m;
    let guard = 0;
    while ((m = re.exec(src)) !== null && guard++ < 2000) {
      const word = m[0];
      if (!word) {
        re.lastIndex++;
        continue;
      }
      if (wl.has(word)) continue;
      push(bucket, {
        kind: 'pattern',
        word,
        index: m.index,
        length: word.length,
        level: p.level || 'medium',
        category: p.name || p.id,
        categoryId: p.id,
        suggest: p.suggest || '',
        note: p.note || '',
        snippet: snippetOf(src, m.index, word.length),
      });
    }
  }

  // 3) 语境规则
  for (const rule of kb.contextRules || []) {
    const win = Number(rule.window) || 12;
    const bucket = (rule.mode || 'block') === 'warn' ? warnings : hits;
    for (const trig of rule.trigger || []) {
      let from = 0;
      while (true) {
        const ti = src.indexOf(trig, from);
        if (ti < 0) break;
        for (const tgt of rule.targetWords || []) {
          const hi = src.indexOf(tgt, Math.max(0, ti - win));
          if (hi >= 0 && Math.abs(hi - ti) <= win) {
            const start = Math.min(ti, hi);
            const word = src.slice(start, Math.max(ti + trig.length, hi + tgt.length));
            if (wl.has(word)) continue;
            push(bucket, {
              kind: 'context',
              word,
              index: start,
              length: word.length,
              level: rule.level || 'high',
              category: rule.name || rule.id,
              categoryId: rule.id,
              suggest: rule.suggest || '',
              note: rule.note || `「${trig}」与「${tgt}」在${win}字内共现`,
              snippet: snippetOf(src, start, word.length),
            });
          }
        }
        from = ti + trig.length;
        if (from >= src.length) break;
      }
    }
  }

  // 去重：同一位置只保留等级更高 / 更长的命中
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const kept = [];
  for (const h of hits) {
    const dup = kept.find(
      (k) => k.index < h.index + h.length && h.index < k.index + k.length
    );
    if (dup) {
      if (LEVEL_ORDER[h.level] > LEVEL_ORDER[dup.level] || (h.level === dup.level && h.length > dup.length)) {
        Object.assign(dup, h);
      }
      continue;
    }
    kept.push(h);
  }

  // 提示项按词聚合，避免同一个地名出现几十次把报告刷满
  const warnMap = new Map();
  for (const w of warnings) {
    const key = `${w.word}|${w.categoryId}`;
    if (!warnMap.has(key)) {
      warnMap.set(key, { ...w, count: 1 });
    } else {
      warnMap.get(key).count += 1;
    }
  }
  const warnList = [...warnMap.values()].sort((a, b) => b.count - a.count);

  const counts = { high: 0, medium: 0, low: 0 };
  for (const h of kept) counts[h.level] = (counts[h.level] || 0) + 1;
  const score = kept.reduce((s, h) => s + (LEVEL_SCORE[h.level] || 2), 0);
  const level = counts.high ? 'high' : counts.medium ? 'medium' : counts.low ? 'low' : 'clean';

  // 生成「一键替换建议稿」
  let cleaned = src;
  for (const h of [...kept].sort((a, b) => b.index - a.index)) {
    if (!h.suggest) continue;
    cleaned = cleaned.slice(0, h.index) + `【${h.suggest}】` + cleaned.slice(h.index + h.length);
  }

  return { hits: kept, warnings: warnList, level, score, counts, cleaned, whitelist, total: kept.length };
}

/** 检查结果只保留摘要，便于挂在方案(deck)上或做列表展示。 */
export function summarize(result) {
  return {
    level: result.level,
    score: result.score,
    counts: result.counts,
    total: result.total,
    warnTotal: (result.warnings || []).length,
    top: result.hits.slice(0, 12).map((h) => ({
      word: h.word,
      level: h.level,
      category: h.category,
      suggest: h.suggest,
    })),
    warnings: (result.warnings || []).slice(0, 8).map((w) => ({
      word: w.word,
      category: w.category,
      count: w.count,
      note: w.note,
    })),
  };
}
