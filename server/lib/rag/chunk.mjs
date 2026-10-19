/**
 * RAG 分块：把知识库对象切成「可检索的最小语义单元」。
 *
 * 为什么按字段组拆、而不是一个条目塞一块：检索精度取决于粒度。用户问价格时，
 * 讲山场环境的长段落会把价格句挤到排名之外，模型拿到的证据就答非所问。
 * 每个块都自带「字段名 + 条目名」，模型才能直接引用（如「山场特征：…」）。
 *
 * 输出顺序完全由输入数组顺序决定，不依赖对象键序/时间/随机数，可复现。
 */
import { loadCompliance } from '../compliance.mjs';

const MAX_BLOCK = 400; // 契约要求单块 100–400 字，超长按句切分
const MIN_TAIL = 60; // 尾块过短就并回前一块，避免留下半句话的碎片
const SENT_END = '。！？；\n';

// 全角括号包起来的多为「（这一章要讲透的东西）」这类写作占位符，进索引只会污染召回
const PLACEHOLDER_RE = /^[（(【[].*[）)】\]]$/;

/** 组装 "字段名：值" 的内容部分；数组用顿号连接，与库里原有的中文风格一致。 */
function toText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    const items = v.map((x) => toText(x)).filter(Boolean);
    return items.length ? items.join('、') : '';
  }
  return String(v).trim();
}

function isPlaceholder(text) {
  return PLACEHOLDER_RE.test(text.replace(/\s/g, ''));
}

/** 去掉 undefined/null/空串/空数组，让 meta 只留真实溯源信息。 */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}

function splitSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (SENT_END.includes(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 单行超过上限时按句拆开，每段都补回字段名 —— 否则模型引用时不知道这是哪一项。
 * 单句本身还超长（极少见）时退化为硬切，保证「单块 ≤ MAX_BLOCK」这条硬约束不破。
 */
function splitLongLine(line, max) {
  if (line.length <= max) return [line];
  const cut = line.indexOf('：');
  const prefix = cut >= 0 ? line.slice(0, cut + 1) : '';
  const body = line.slice(prefix.length);
  const room = Math.max(40, max - prefix.length);
  const parts = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      parts.push(prefix + buf);
      buf = '';
    }
  };
  for (const sent of splitSentences(body)) {
    if (sent.length > room) {
      flush();
      for (let i = 0; i < sent.length; i += room) parts.push(prefix + sent.slice(i, i + room));
      continue;
    }
    if (buf && buf.length + sent.length > room) flush();
    buf += sent;
  }
  flush();
  return parts.length ? parts : [line];
}

/** 贪心装箱：行不会被跨块切断，保证顺序与边界都可复现。 */
function packLines(lines, max) {
  const blocks = [];
  let cur = '';
  for (const line of lines) {
    if (!cur) {
      cur = line;
      continue;
    }
    if (cur.length + 1 + line.length <= max) cur += '\n' + line;
    else {
      blocks.push(cur);
      cur = line;
    }
  }
  if (cur) blocks.push(cur);
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const prev = blocks[blocks.length - 2];
    if (last.length < MIN_TAIL && prev.length + 1 + last.length <= max) {
      blocks.splice(blocks.length - 2, 2, prev + '\n' + last);
    }
  }
  return blocks;
}

function newSection() {
  return { lines: [], out: [] };
}

/** 每块条数：非法值/越界都收敛到 [1,8]，否则一个手滑的 0 会让 for 循环死循环。 */
function clamp(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

function put(sec, name, value) {
  const text = toText(value);
  if (!text || isPlaceholder(text)) return;
  for (const part of splitLongLine(`${name}：${text}`, MAX_BLOCK)) sec.lines.push(part);
}

/** 收口：把暂存的行装箱成 passage 正文（header 会占一行，所以上限要减去它）。 */
function seal(sec, title, header) {
  if (!sec.lines.length) return;
  const max = Math.max(120, MAX_BLOCK - header.length - 1);
  const blocks = packLines(sec.lines, max);
  blocks.forEach((text, i) => {
    sec.out.push({ title: blocks.length > 1 ? `${title}（第${i + 1}段）` : title, text });
  });
}

/**
 * 统一编号：`<type>:<sourceId>#<n>`，n 按条目内 passage 顺序递增。
 * header 逐块重复，是为了让每一块单独喂给模型时都能自证出处。
 */
function emit(list, base, sections, header) {
  let n = 0;
  for (const sec of sections) {
    for (const block of sec.out) {
      list.push({
        id: `${base.type}:${base.sourceId}#${n++}`,
        type: base.type,
        sourceId: base.sourceId,
        title: `${base.name} · ${block.title}`,
        text: `${header}\n${block.text}`,
        tags: base.tags,
        meta: base.meta,
      });
    }
  }
}

/** 同上，但直接吃已经打好的块数组（合规词条要按条数切块并自定标题）。 */
function emitBlocks(list, base, blocks, header) {
  let n = 0;
  for (const block of blocks) {
    list.push({
      id: `${base.type}:${base.sourceId}#${n++}`,
      type: base.type,
      sourceId: base.sourceId,
      title: `${base.name} · ${block.title}`,
      text: `${header}\n${block.text}`,
      tags: base.tags,
      meta: base.meta,
    });
  }
}

/** 从「产地」里认出区县，作为结构化标签（找不到就不加，不做猜测）。 */
function countyOf(area, cities) {
  if (!area || !cities) return '';
  return cities.find((c) => c && area.includes(c)) || '';
}

/**
 * @param {object} kb   loadKB() 的返回值；若带 compliance 字段则一并索引
 * @param {object} [opts]
 * @param {object} [opts.compliance]       显式传入合规词库，避免函数内部读盘
 * @param {number} [opts.wordsPerBlock=3]  合规禁用词每块放几条
 * @param {number} [opts.patternsPerBlock=1] 正则模式每块放几条
 * @param {number} [opts.rulesPerBlock=1]  语境规则每块放几条
 * @returns {Array} Passage[]
 */
export function buildChunks(kb, opts = {}) {
  const src = kb || {};
  const regions = Array.isArray(src.regions) ? src.regions : [];
  const mountains = Array.isArray(src.mountains) ? src.mountains : [];
  const products = Array.isArray(src.products) ? src.products : [];
  const topics = Array.isArray(src.topics) ? src.topics : [];
  const compliance = opts.compliance || src.compliance || loadCompliance();
  const wordsPerBlock = clamp(opts.wordsPerBlock, 3);
  const patternsPerBlock = clamp(opts.patternsPerBlock, 1);
  const rulesPerBlock = clamp(opts.rulesPerBlock, 1);

  const cityMap = new Map();
  for (const r of regions) if (r && r.name) cityMap.set(r.name, Array.isArray(r.cities) ? r.cities : []);

  const out = [];

  for (const r of regions) {
    if (!r || !r.id) continue;
    const name = r.name || r.id;
    const header = `产区：${name}`;
    const s = newSection();
    put(s, '产区简介', r.desc);
    put(s, '主要城市', r.cities);
    put(s, '主要茶区', r.subAreas);
    seal(s, '产区概况', header);
    emit(out, {
      type: 'region', sourceId: r.id, name,
      tags: [name, ...(r.cities || [])],
      meta: compact({ source: 'knowledge.json' }),
    }, [s], header);
  }

  for (const m of mountains) {
    if (!m || !m.id) continue;
    const name = m.name || m.id;
    const alias = Array.isArray(m.alias) ? m.alias : [];
    const header = `山头：${name}${alias.length ? `（别名：${alias.join('、')}）` : ''}`;

    const terroir = newSection();
    put(terroir, '山场特征', m.terroir);
    put(terroir, '产地', m.area);
    put(terroir, '所属产区', m.region);
    put(terroir, '海拔', m.altitude);
    put(terroir, '树种', m.treeType);
    put(terroir, '树龄', m.treeAge);
    put(terroir, '土壤', m.soil);
    put(terroir, '等级', m.grade);
    seal(terroir, '山场特征', header);

    const tasting = newSection();
    put(tasting, '香气', m.aroma);
    put(tasting, '滋味与口感', m.taste);
    put(tasting, '汤色', m.soup);
    put(tasting, '叶底', m.leaf);
    seal(tasting, '品鉴', header);

    const price = newSection();
    put(price, '参考价格', m.priceRange);
    put(price, '避坑要点', m.pitfalls);
    put(price, '备注', m.note);
    seal(price, '价格与避坑', header);

    const sale = newSection();
    put(sale, '卖点话术', m.sellingPoints);
    put(sale, '适合人群', m.audience);
    seal(sale, '卖点与人群', header);

    const brew = newSection();
    put(brew, '冲泡建议', m.brewTips);
    seal(brew, '冲泡建议', header);

    const cities = cityMap.get(m.region);
    emit(out, {
      type: 'mountain', sourceId: m.id, name,
      tags: [m.region, countyOf(m.area, cities), ...(Array.isArray(m.audience) ? m.audience : [])].filter(Boolean),
      meta: compact({
        source: 'knowledge.json',
        confidence: m.confidence,
        grade: m.grade,
        region: m.region,
        area: m.area,
        note: m.note,
      }),
    }, [terroir, tasting, price, sale, brew], header);
  }

  for (const p of products) {
    if (!p || !p.id) continue;
    const name = p.name || p.id;
    const aka = Array.isArray(p.aka) ? p.aka : [];
    const header = `茶品：${name}${aka.length ? `（别名：${aka.join('、')}）` : ''}`;

    const overview = newSection();
    put(overview, '简介', p.summary);
    put(overview, '类别', p.category);
    put(overview, '别名', p.aka);
    seal(overview, '概览', header);

    const points = newSection();
    put(points, '要点', p.points);
    seal(points, '要点', header);

    const sale = newSection();
    put(sale, '卖点话术', p.sellingPoints);
    seal(sale, '卖点与人群', header);

    const pit = newSection();
    put(pit, '避坑要点', p.pitfalls);
    seal(pit, '避坑', header);

    const brew = newSection();
    put(brew, '冲泡建议', p.brewTips);
    seal(brew, '冲泡建议', header);

    emit(out, {
      type: 'product', sourceId: p.id, name,
      tags: [p.category, ...aka].filter(Boolean),
      meta: compact({ source: 'knowledge.json', confidence: p.confidence, category: p.category }),
    }, [overview, points, sale, pit, brew], header);
  }

  for (const t of topics) {
    if (!t || !t.id) continue;
    const name = t.name || t.id;
    const header = `主题：${name}`;

    const overview = newSection();
    put(overview, '类别', t.category);
    put(overview, '概述', t.summary);
    seal(overview, '概览', header);

    const points = newSection();
    put(points, '要点', t.points);
    seal(points, '要点', header);

    const cautions = newSection();
    put(cautions, '注意事项', t.cautions);
    put(cautions, '补充说明', t.details);
    seal(cautions, '注意事项', header);

    emit(out, {
      type: 'topic', sourceId: t.id, name,
      tags: [t.category].filter(Boolean),
      meta: compact({ source: 'knowledge.json', category: t.category }),
    }, [overview, points, cautions], header);
  }

  const categories = Array.isArray(compliance.categories) ? compliance.categories : [];
  for (const cat of categories) {
    if (!cat || !cat.id) continue;
    const name = cat.name || cat.id;
    const header = `合规类别：${name}`;
    const blocks = [];

    // 风险与整改保持整块：「这一类为什么违规」本身就是完整语义单元，拆开没有收益
    const risk = newSection();
    put(risk, '风险等级', cat.level);
    put(risk, '风险说明', cat.risk);
    put(risk, '整改建议', cat.advice);
    seal(risk, '风险与整改', header);
    blocks.push(...risk.out);

    // 禁用词按 wordsPerBlock 条一组独立成块。
    // 每条 word 的 {word, level, suggest, note} 就是「能不能说 / 换成什么」的完整答案；
    // 原来 8 条挤一块（约 400 字）时，块长把 BM25 的长度归一化分压下去，
    // 精确命中的那条反而排不上来（实测「降三高」被挤到第 6 名、进不了 top5）。
    const items = [];
    for (const w of cat.words || []) {
      if (!w || !w.word) continue;
      const mode = w.mode || cat.mode || 'block';
      const parts = [`「${w.word}」`];
      if (w.suggest) parts.push(`建议改为「${w.suggest}」`);
      if (w.note) parts.push(`说明：${w.note}`);
      parts.push(`等级：${w.level || cat.level || 'medium'}`);
      parts.push(mode === 'warn' ? '提示项（不拦截）' : '禁用项');
      items.push({ word: w.word, line: `禁用词：${parts.join('；')}` });
    }
    for (let i = 0; i < items.length; i += wordsPerBlock) {
      const group = items.slice(i, i + wordsPerBlock);
      blocks.push({
        title: `禁用词${group.map((g) => `「${g.word}」`).join('')}`,
        text: group.map((g) => g.line).join('\n'),
      });
    }

    emitBlocks(out, {
      type: 'compliance', sourceId: cat.id, name,
      tags: [name, cat.level].filter(Boolean),
      meta: compact({ source: 'compliance.json', level: cat.level, words: items.length }),
    }, blocks, header);
  }

  const patterns = Array.isArray(compliance.patterns) ? compliance.patterns : [];
  if (patterns.length) {
    const header = '合规规则：正则模式（机器可识别的违禁词形态）';
    const blocks = [];
    for (let i = 0; i < patterns.length; i += patternsPerBlock) {
      const group = patterns.slice(i, i + patternsPerBlock).filter(Boolean);
      if (!group.length) continue;
      const lines = group.map((p) => {
        const parts = [`${p.name || p.id}`];
        if (p.regex) parts.push(`正则：${p.regex}`);
        parts.push(`等级：${p.level || 'medium'}`);
        if (p.suggest) parts.push(`建议：${p.suggest}`);
        if (p.note) parts.push(`说明：${p.note}`);
        return `模式：${parts.join('；')}`;
      });
      blocks.push({ title: `正则模式 ${group.map((p) => p.name || p.id).join('、')}`, text: lines.join('\n') });
    }
    emitBlocks(out, {
      type: 'compliance', sourceId: 'patterns', name: '违禁词正则模式',
      tags: ['合规', '正则'],
      meta: compact({ source: 'compliance.json', patterns: patterns.length }),
    }, blocks, header);
  }

  const rules = Array.isArray(compliance.contextRules) ? compliance.contextRules : [];
  if (rules.length) {
    const header = '合规规则：语境共现（触发词与目标词在窗口内同时出现才算违规）';
    const blocks = [];
    for (let i = 0; i < rules.length; i += rulesPerBlock) {
      const group = rules.slice(i, i + rulesPerBlock).filter(Boolean);
      if (!group.length) continue;
      const lines = group.map((r) => {
        const parts = [`${r.name || r.id}`];
        if (r.trigger?.length) parts.push(`触发词：${r.trigger.join('、')}`);
        if (r.targetWords?.length) parts.push(`目标词：${r.targetWords.join('、')}`);
        if (r.window) parts.push(`判定窗口：${r.window} 字`);
        parts.push(`等级：${r.level || 'medium'}`);
        if (r.suggest) parts.push(`建议：${r.suggest}`);
        if (r.note) parts.push(`说明：${r.note}`);
        if ((r.mode || 'block') === 'warn') parts.push('提示项（不拦截）');
        return `语境规则：${parts.join('；')}`;
      });
      blocks.push({ title: `语境规则 ${group.map((r) => r.name || r.id).join('、')}`, text: lines.join('\n') });
    }
    emitBlocks(out, {
      type: 'compliance', sourceId: 'context-rules', name: '违禁词语境规则',
      tags: ['合规', '语境'],
      meta: compact({ source: 'compliance.json', rules: rules.length }),
    }, blocks, header);
  }

  return out;
}
