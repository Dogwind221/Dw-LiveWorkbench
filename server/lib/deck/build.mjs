/**
 * 模块 3 主引擎：直播方案生成。
 *
 * 输入 = 选题 + 一款或多款茶 + 场次设置
 * 输出 = DeckSpec：可直接渲染成 PPT 的结构 + 可直接进提词器的口播稿
 *
 * 设计原则：
 *  - 全离线，规则 + 知识库驱动，同一 seed 重复生成结果一致
 *  - 时长驱动：段落时长 → 稿子字数，稿子讲多久由总时长倒推
 *  - 一场多款茶：真实直播是「过款」节奏，多款茶让内容随时长线性增长
 *  - 稿子讲不满的部分，转成明确的「互动环节计划」，不留空白时间
 *  - 生成结果自带合规自检
 */
import { loadKB, findMountain, findProducts, listRegions } from '../kb.mjs';
import { checkText, summarize, loadCompliance } from '../compliance.mjs';
import { readJson } from '../store.mjs';
import { BLOCK_MAP, PURPOSE_FLOW, PURPOSES, AUDIENCES, STYLES } from './blocks.mjs';
import { makeRng, pick, talkMinutes, fmtClock, charCount, CHARS_PER_MIN } from './copy.mjs';
import { makeExpander } from './expand.mjs';

const SLIDE_PACE = 3.0; // 每张幻灯片大致承载的讲解分钟数
const SPLITTABLE = new Set(['points', 'cards', 'table', 'faq', 'steps']);
const MAX_PRODUCTS = 5;

/** 场次越长，扩写池生成的变体趟数越多（去重后仍不重复）。 */
function passesForDuration(durationMin) {
  return Math.min(6, Math.max(3, Math.round(durationMin / 12)));
}

/** 段落角色划分：开场段 / 每款茶的专属段 / 收尾段。
 *
 * ⚠️ 这张表必须和块的 `requires: 'mountain'` 对齐：
 * 规划时只有 per-product 的段落才会拿到 productIndex，
 * 而 requires mountain 的块在 productIndex === null 时会被**直接丢掉** ——
 * 表现是「块加进了 PURPOSE_FLOW，页面却死活不出来」（实测踩过）。
 * 所以任何按山头讲的块（溯源、气候生态、工艺与滋味）都要登记在这里。
 */
const OPENING = new Set(['cover', 'agenda', 'hook', 'credibility']);
const PER_PRODUCT = new Set([
  'mountain-profile', 'terroir', 'craft-effect', 'traceability',
  'tasting', 'product', 'proof', 'price',
]);
const PRODUCT_ROLES = ['主推款', '对比款', '引流款', '福利款', '返场款'];

const DEFAULT_INPUT = {
  topic: '普洱茶直播',
  productName: '',
  mountainName: '',
  type: '生普',
  year: String(new Date().getFullYear()),
  spec: '357g/饼',
  price: '',
  comparePrice: '',
  gift: '',
  stock: '',
  purpose: 'mixed',
  audience: 'regular',
  style: 'practical',
  durationMin: 60,
  host: '主播',
  brand: '本店',
  nextTopic: '',
  seed: '',
  products: [],
};

export function listOptions() {
  const kb = loadKB();
  return {
    purposes: Object.entries(PURPOSES).map(([id, v]) => ({ id, ...v })),
    audiences: Object.entries(AUDIENCES).map(([id, v]) => ({ id, ...v })),
    styles: Object.entries(STYLES).map(([id, v]) => ({ id, ...v })),
    durations: [30, 45, 60, 90, 120],
    productRoles: PRODUCT_ROLES,
    regions: listRegions(kb),
    mountains: (kb.mountains || []).map((m) => ({
      id: m.id,
      name: m.name,
      region: m.region,
      area: m.area,
      grade: m.grade || '',
      taste: (m.taste || []).slice(0, 3),
    })),
    types: ['生普', '熟普', '生茶（散）', '熟茶（散）', '红茶', '白茶', '柑普', '拼配'],
  };
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeProduct(raw, index, input) {
  const mountain = findMountain(loadKBShared(), raw.mountainName || raw.name || '');
  return {
    name: raw.name || raw.productName || mountain?.name || `茶品${index + 1}`,
    mountainName: mountain?.name || raw.mountainName || '',
    mountainId: mountain?.id || '',
    mountain,
    type: raw.type || input.type,
    year: raw.year || input.year,
    spec: raw.spec || input.spec,
    price: num(raw.price),
    comparePrice: num(raw.comparePrice),
    gift: raw.gift || input.gift || '',
    stock: raw.stock || input.stock || '',
    role: raw.role || PRODUCT_ROLES[index] || '主推款',
  };
}

let _kbCache = null;
function loadKBShared() {
  if (!_kbCache) _kbCache = loadKB();
  return _kbCache;
}

export function resetKBCache() {
  _kbCache = null;
}

function normalizeInput(raw = {}) {
  const input = { ...DEFAULT_INPUT, ...raw };
  input.durationMin = Math.max(15, Math.min(240, Number(input.durationMin) || 60));
  if (!PURPOSES[input.purpose]) input.purpose = 'mixed';
  if (!AUDIENCES[input.audience]) input.audience = 'regular';
  if (!STYLES[input.style]) input.style = 'practical';
  input.seed = input.seed || `${input.topic}|${input.productName}|${input.purpose}|${input.durationMin}`;

  // 多款茶：没传 products 就用扁平字段合成一款
  if (!Array.isArray(input.products) || !input.products.length) {
    input.products = [
      {
        name: input.productName || input.mountainName || input.topic,
        mountainName: input.mountainName,
        type: input.type,
        year: input.year,
        spec: input.spec,
        price: input.price,
        comparePrice: input.comparePrice,
        gift: input.gift,
        stock: input.stock,
        role: '主推款',
      },
    ];
  }
  input.products = input.products.slice(0, MAX_PRODUCTS);
  return input;
}

/* ------------------------- 段落规划 ------------------------- */

function planSections(input, products) {
  const flow = PURPOSE_FLOW[input.purpose] || PURPOSE_FLOW.mixed;
  const openingIds = flow.filter((id) => OPENING.has(id));
  const perIds = flow.filter((id) => PER_PRODUCT.has(id));
  const closingIds = flow.filter((id) => !OPENING.has(id) && !PER_PRODUCT.has(id));

  const entries = [];
  const push = (id, productIndex) => {
    const block = BLOCK_MAP.get(id);
    if (!block) return;
    if (block.minMinutes && input.durationMin < block.minMinutes) return;
    if (block.requires === 'mountain') {
      if (productIndex === null) return;
      if (!products[productIndex]?.mountain) return;
    }
    entries.push({ id, productIndex, block });
  };

  openingIds.forEach((id) => push(id, null));
  for (let i = 0; i < products.length; i++) perIds.forEach((id) => push(id, i));
  closingIds.forEach((id) => push(id, null));

  if (!entries.length) return [];

  const totalW = entries.reduce((a, e) => a + e.block.weight, 0);
  let minutes = entries.map((e) => (e.block.weight / totalW) * input.durationMin);
  minutes = minutes.map((m) => Math.max(0.8, m));
  const sum = minutes.reduce((a, b) => a + b, 0);
  minutes = minutes.map((m) => (m * input.durationMin) / sum);

  return entries.map((e, i) => ({
    id: e.id,
    productIndex: e.productIndex,
    title: e.block.title,
    goal: e.block.goal,
    minutes: Math.round(minutes[i] * 10) / 10,
  }));
}

/* ------------------------- 幻灯片拆分 ------------------------- */

/**
 * 把「这个段落想要几张幻灯片」的预算分配给块返回的每一张。
 * 每张至少 1；多出来的按顺序补，保证可预期（不按权重算，避免同一份输入算出不同结果）。
 */
function allocateDesired(n, desired) {
  const out = new Array(n).fill(1);
  let extra = Math.max(0, desired - n);
  let i = 0;
  while (extra-- > 0) {
    out[i % n]++;
    i++;
  }
  return out;
}

/**
 * 把一张内容过满的幻灯片拆成两张。
 *
 * 两条铁律：
 *  1) 拆分必须同时切「视觉内容」和「口播稿」，否则两张会共享同一份稿子/同一份内容
 *  2) 视觉内容切不动时宁可不拆 —— 只切稿子会产出两张一模一样的页面
 */
function splitSlide(slide) {
  if (!SPLITTABLE.has(slide.type)) return null;

  const clusters = slide.scriptClusters || [];
  const cut = Math.max(1, Math.ceil(clusters.length / 2));
  const ca = clusters.slice(0, cut);
  const cb = clusters.slice(cut);

  const bullets = slide.bullets || [];
  // 阈值放到 6：5 条要点在版面上放得下（行长 0.9 英寸/条），
  // 拆成两页反而把「为什么由我来讲这件事」这种一页就够的说散了。
  if (bullets.length >= 6) {
    const half = Math.ceil(bullets.length / 2);
    return [
      { ...slide, bullets: bullets.slice(0, half), scriptClusters: ca },
      { ...slide, title: `${slide.title}（续）`, bullets: bullets.slice(half), scriptClusters: cb },
    ];
  }
  const cards = slide.cards || [];
  // 阈值放到 5：4 张卡片是设计好的版面（四列网格，或 3+1 的因果链），
  // 拆成 2+2 会把「条件 → 结果」这条链子切断（实测「为什么是这个味」被拆成两页）。
  if (cards.length >= 5) {
    const half = Math.ceil(cards.length / 2);
    return [
      { ...slide, cards: cards.slice(0, half), scriptClusters: ca },
      { ...slide, title: `${slide.title}（续）`, cards: cards.slice(half), scriptClusters: cb },
    ];
  }
  const steps = slide.steps || [];
  if (steps.length >= 6) {
    const half = Math.ceil(steps.length / 2);
    return [
      { ...slide, steps: steps.slice(0, half), scriptClusters: ca },
      { ...slide, title: `${slide.title}（续）`, steps: steps.slice(half), scriptClusters: cb },
    ];
  }
  const faqItems = slide.faq || [];
  if (faqItems.length >= 6) {
    const half = Math.ceil(faqItems.length / 2);
    return [
      { ...slide, faq: faqItems.slice(0, half), scriptClusters: ca },
      { ...slide, title: `${slide.title}（续）`, faq: faqItems.slice(half), scriptClusters: cb },
    ];
  }
  const rows = slide.table?.rows || [];
  // 阈值放到 9：山头档案这种「产区/海拔/树种/土壤/风格/等级/参考价位」本身就是一页的档案，
  // 7 行就拆会把一份档案劈成两页（实测踩过）。真超长的表（9 行以上）才拆。
  if (rows.length >= 9) {
    const half = Math.ceil(rows.length / 2);
    return [
      { ...slide, table: { ...slide.table, rows: rows.slice(0, half) }, scriptClusters: ca },
      { ...slide, title: `${slide.title}（续）`, table: { ...slide.table, rows: rows.slice(half) }, scriptClusters: cb },
    ];
  }
  return null;
}

function expandSlides(slide, desired) {
  const out = [slide];
  let guard = 0;
  while (out.length < desired && guard++ < 6) {
    let bestIdx = -1;
    let bestScore = 0;
    out.forEach((s, i) => {
      const score =
        (s.bullets?.length || 0) +
        (s.cards?.length || 0) * 1.2 +
        (s.table?.rows?.length || 0) * 0.8 +
        (s.scriptClusters?.length || 0);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });
    if (bestIdx < 0) break;
    const parts = splitSlide(out[bestIdx]);
    if (!parts) break;
    out.splice(bestIdx, 1, ...parts);
  }
  return out;
}

/** 幻灯片「视觉内容」签名，用于检测重复页（口播稿不参与）。 */
function slideSignature(s) {
  return JSON.stringify([
    s.type,
    s.title,
    s.subtitle || '',
    s.footnote || '',
    s.bullets || [],
    s.cards || [],
    s.steps || [],
    s.faq || [],
    (s.table && s.table.rows) || [],
    s.left || null,
    s.right || null,
    s.price || '',
    s.comparePrice || '',
    s.anchors || [],
  ]);
}

/* ------------------------- 稿子填充 ------------------------- */

function fitScript(clusters, targetMinutes, expand, slide) {
  const targetChars = Math.max(80, targetMinutes * CHARS_PER_MIN);
  const out = [];
  let n = 0;
  for (const cluster of clusters || []) {
    if (!cluster?.length) continue;
    out.push(...cluster);
    n += cluster.reduce((s, l) => s + charCount(l.text), 0);
    if (n >= targetChars) break;
  }
  if (n < targetChars && typeof expand === 'function') {
    expand.reserve?.(out);
    out.push(...expand(slide, targetChars - n));
  }
  if (!out.length && clusters?.length) out.push(...clusters[0]);
  return out.filter((l) => l && l.text);
}

/* ------------------------- 互动缺口计划 ------------------------- */

const INTERACTION_BANK = [
  {
    title: '弹幕集中答疑',
    desc: '念出评论区问题逐个回答，优先答「会不会苦」「怎么泡」「能不能存」',
    weight: 1.4,
    cue: '看评论区',
    lines: [
      '我们把评论区的问题过一遍，我念一个答一个。',
      '这个问题问的人最多，我展开说一下。',
      '如果答得不够清楚，你再追问，我不怕被问。',
      '答不上来的我会直说答不上来，不糊弄你。',
    ],
  },
  {
    title: '现场冲泡演示',
    desc: '当着镜头泡一泡，把汤色、叶底、出汤节奏拍给观众看',
    weight: 1.2,
    cue: '拿起盖碗',
    lines: [
      '我现在泡一泡，你跟着看画面。',
      '注意出汤速度，前三泡一定要快。',
      '我把公道杯端近一点，你看这个汤色。',
      '泡开之后我把叶底摊出来给你看。',
    ],
  },
  {
    title: '盲品对比',
    desc: '把本品和另一款同价位茶对冲，让观众看汤色与叶底差别',
    weight: 1.1,
    cue: '拿两只公道杯',
    lines: [
      '我拿两只杯子对冲一下，你只看颜色。',
      '同样价位，差别主要在这几个地方。',
      '不用听我说，你自己看画面判断。',
    ],
  },
  {
    title: '老客连麦/截图反馈',
    desc: '请老客说一句真实感受，比主播自己夸十句有用',
    weight: 1.0,
    cue: '念反馈',
    lines: [
      '我念几条老客的反馈，不是我说的，是他们说的。',
      '这位朋友上次买了两饼，说喝法跟我讲的一样。',
      '反馈里有说不习惯的，我也念出来，不挑好的说。',
    ],
  },
  {
    title: '产地素材播放',
    desc: '放一段进山或初制所的视频，讲当时的情形与天气',
    weight: 1.0,
    cue: '切素材',
    lines: [
      '我放一段今年上山拍的素材，边看边说。',
      '这是初制所，当天采的鲜叶就在这儿摊晾。',
      '当时天气不太好，所以这批的产量比往年少。',
    ],
  },
  {
    title: '问题反抛',
    desc: '问观众平时怎么选茶，挑典型回答展开讲',
    weight: 1.0,
    cue: '互动',
    lines: [
      '我反过来问你们：平时买茶先看什么？',
      '评论区已经有人打了，我挑两个说说我的看法。',
      '这个问题没有标准答案，但方向能看出来。',
    ],
  },
  {
    title: '福利环节',
    desc: '按平台规则做福袋或抽奖，用真实机制拉停留',
    weight: 0.9,
    cue: '上福袋',
    lines: [
      '按照平台规则上一个福袋，参与方式我念一遍。',
      '中奖的朋友收到茶样记得跟我说喝感。',
      '福利是真实的机制，我不玩虚的。',
    ],
  },
  {
    title: '下单引导复述',
    desc: '把下单步骤、赠品规则、售后政策再说一遍，接住新进来的流量',
    weight: 0.8,
    cue: '指购物车',
    lines: [
      '刚进来的朋友我重复一遍怎么买。',
      '点购物车、选规格、提交，就这三步。',
      '有赠品的记得备注，售后七天无理由。',
    ],
  },
  {
    title: '下一场预告',
    desc: '预告下一场主题与时间，把观众带到下一场',
    weight: 0.6,
    cue: '收尾',
    lines: [
      '下一场我打算讲另一个方向的山头，感兴趣的先关注。',
      '具体时间我会提前在主页发，不会临时改。',
      '今天没讲透的部分，下一场接着讲。',
    ],
  },
];

function buildInteractionPlan(gapMinutes) {
  if (gapMinutes < 2) return [];
  const totalW = INTERACTION_BANK.reduce((a, b) => a + b.weight, 0);
  const items = INTERACTION_BANK.map((b) => ({
    title: b.title,
    desc: b.desc,
    cue: b.cue,
    lines: b.lines || [],
    minutes: Math.round(((b.weight / totalW) * gapMinutes) * 10) / 10,
  })).filter((i) => i.minutes >= 0.5);
  const keep = Math.max(2, Math.min(items.length, Math.ceil(gapMinutes / 4)));
  return items.slice(0, keep);
}

/* ------------------------- 主流程 ------------------------- */

/**
 * 中文文案里的半角直引号转成「」。
 *
 * 为什么做统一规范化而不是逐个改文案模板：引号散落在 blocks.mjs / expand.mjs 的
 * 几十处模板与事实拼装里（实测六种场次共 133 处），逐个改既容易漏、也会被以后
 * 新增的文案重新引入。放在生成出口做一次，覆盖全部字段与以后的新文案。
 *
 * 只处理双引号：单引号在中文里更可能是撇号或英文缩写，不动。
 * 成对替换（开→「，闭→」）；数量为奇数时最后一个会留成「，属于尽力而为，
 * 由 ppt-lab/quote-audit.mjs 体检脚本兜底发现。
 */
export function fixQuotes(v) {
  if (typeof v !== 'string' || v.indexOf('"') < 0) return v;
  let open = true;
  return v.replace(/"/g, () => {
    const ch = open ? '「' : '」';
    open = !open;
    return ch;
  });
}

/**
 * 剥掉 Markdown 的行内标记。
 *
 * 知识库的 .md 是**手写**的，人在里面自然会用 **加粗**、`代码`、- 列表。
 * 但 PPT 和口播稿是纯文本渲染 —— 不剥就会在投屏上出现「**生活在里面**」这种字样。
 * 实测踩过：知识库正文里加粗的关键句，原样带进了选料逻辑页。
 *
 * 只处理行内标记；段落/换行结构不动（块自己会按行拆）。
 */
export function stripMarkdown(v) {
  if (typeof v !== 'string' || !v) return v;
  return v
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **粗体**
    .replace(/__([^_]+)__/g, '$1') // __粗体__
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2') // *斜体*
    .replace(/`([^`]+)`/g, '$1') // `代码`
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 行首 # 标题
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // 行首列表符
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // [文字](链接) → 文字
}

/** 对一页里所有对外可见的文案字段做规范化（与 PPT/口播稿共用同一份数据） */
function normalizeSlideCopy(s) {
  const f = (v) => stripMarkdown(fixQuotes(v));
  s.title = f(s.title);
  s.subtitle = f(s.subtitle);
  s.kicker = f(s.kicker);
  s.quote = f(s.quote);
  s.footnote = f(s.footnote);
  s.bullets = (s.bullets || []).map(f);
  s.cards = (s.cards || []).map((c) => ({ ...c, title: f(c.title), desc: f(c.desc) }));
  s.steps = (s.steps || []).map((c) => ({ ...c, title: f(c.title), desc: f(c.desc) }));
  s.faq = (s.faq || []).map((c) => ({ ...c, q: f(c.q), a: f(c.a) }));
  if (s.table) s.table = { ...s.table, rows: (s.table.rows || []).map((r) => r.map(f)) };
  if (s.left) s.left = { ...s.left, title: f(s.left.title), items: (s.left.items || []).map(f) };
  if (s.right) s.right = { ...s.right, title: f(s.right.title), items: (s.right.items || []).map(f) };
  s.script = (s.script || []).map((l) => ({ ...l, text: f(l.text) }));
  if (Array.isArray(s.meta)) s.meta = s.meta.map(f);
  return s;
}

export function buildDeck(rawInput = {}) {
  const input = normalizeInput(rawInput);
  const kb = loadKB();
  _kbCache = kb;
  const compliance = loadCompliance();
  const faqStore = readJson('faq.json', []) || [];

  const products = input.products.map((p, i) => normalizeProduct(p, i, input));

  const primary = products[0];
  const relatedByProduct = products.map((p) =>
    findProducts(kb, [p.type, ...((p.mountain?.taste || []).slice(0, 2)), p.name, '生普', '熟普']).slice(0, 6)
  );

  const meta = {
    title: input.topic || `${primary.name} 直播专场`,
    topic: input.topic,
    purpose: input.purpose,
    purposeLabel: PURPOSES[input.purpose].label,
    audience: input.audience,
    audienceLabel: AUDIENCES[input.audience].label,
    style: input.style,
    styleLabel: STYLES[input.style].label,
    durationMin: input.durationMin,
    host: input.host,
    brand: input.brand,
    nextTopic: input.nextTopic,
    date: new Date().toISOString().slice(0, 10),
    seed: input.seed,
    productCount: products.length,
    hasMountain: products.some((p) => p.mountain),
  };

  const baseCtx = {
    meta,
    input,
    kb,
    plan: [],
    kbFaq: faqStore.filter((f) => f.enabled !== false).slice(0, 12),
    kbrole: {
      years: input.hostYears || '',
      visits: input.hostVisits || '',
      standard: input.hostStandard || '',
    },
  };

  const planned = planSections(input, products);
  const plan = planned.map((p, i) => ({
    id: p.id,
    title: p.title,
    goal: p.goal,
    minutes: p.minutes,
    productIndex: p.productIndex,
    productName: p.productIndex === null ? '' : products[p.productIndex].name,
    index: i + 1,
  }));

  const expanders = new Map();

  const sections = [];
  const slides = [];
  let idx = 0;

  planned.forEach((planItem, si) => {
    const block = BLOCK_MAP.get(planItem.id);
    const product = planItem.productIndex === null ? primary : products[planItem.productIndex];
    const expandKey = planItem.productIndex === null ? 'global' : `p${planItem.productIndex}`;

    const ctx = {
      ...baseCtx,
      plan,
      product,
      mountain: product.mountain || null,
      relatedProducts: planItem.productIndex === null ? relatedByProduct[0] : relatedByProduct[planItem.productIndex],
      r: makeRng(`${input.seed}|${planItem.id}|${expandKey}`),
      minutes: planItem.minutes,
      sectionNo: si + 1,
      productIndex: planItem.productIndex,
    };

    if (!expanders.has(expandKey)) expanders.set(expandKey, makeExpander(ctx, passesForDuration(input.durationMin)));
    ctx.expand = expanders.get(expandKey);

    let produced = [];
    try {
      produced = block.build(ctx) || [];
    } catch (err) {
      console.error(`[deck] 段落 ${planItem.id} 生成失败：${err.message}`);
      produced = [];
    }
    if (!produced.length) return;

    const desired = Math.max(1, Math.min(3, Math.round(planItem.minutes / SLIDE_PACE)));
    /* 一个段落可以返回**多张**幻灯片（例如「信任与溯源」= 溯源档案表 + 选料逻辑）。
       ⚠️ 这里以前写的是 expandSlides(produced[0], desired) —— 只取第一张，
       后面几张被静默丢掉，不报错、日志也没有。表现就是「块里明明 return 了两页，
       生成结果只有一页」，极难查。所以必须把返回的每一张都展开。 */
    const budgets = allocateDesired(produced.length, desired);
    const expanded = produced.flatMap((p, i) => expandSlides(p, budgets[i]));
    const totalW = expanded.reduce((a, s) => a + (s.weight || 1), 0);

    const section = {
      id: `${planItem.id}${planItem.productIndex === null ? '' : `-${planItem.productIndex + 1}`}`,
      blockId: planItem.id,
      productIndex: planItem.productIndex,
      productName: product.name,
      title: planItem.productIndex === null ? block.title : `${product.name} · ${block.title}`,
      goal: block.goal,
      minutes: planItem.minutes,
      slideIds: [],
    };

    for (const s of expanded) {
      const slideMinutes = (planItem.minutes * (s.weight || 1)) / totalW;
      const slide = {
        id: `s${String(++idx).padStart(2, '0')}`,
        index: idx,
        sectionId: section.id,
        sectionTitle: block.title,
        sectionNo: si + 1,
        productIndex: planItem.productIndex,
        productName: planItem.productIndex === null ? '' : product.name,
        type: s.type,
        // 段落没显式给 kicker 时回落到段落名；显式给空串 = 这页不要小标签
        // （开场页就是这样：标题已经说清楚了，多一个「开场」反而啰嗦）
        kicker: s.kicker !== undefined ? s.kicker : block.title,
        title: s.title || block.title,
        subtitle: s.subtitle || '',
        bullets: s.bullets || [],
        cards: s.cards || [],
        steps: s.steps || [],
        faq: s.faq || [],
        table: s.table || null,
        left: s.left || null,
        right: s.right || null,
        quote: s.quote || '',
        price: s.price || '',
        comparePrice: s.comparePrice || '',
        anchors: s.anchors || [],
        meta: s.meta || [],
        footnote: s.footnote || '',
        notes: s.notes || '',
        minutes: Math.round(slideMinutes * 10) / 10,
        script: [],
        scriptClusters: s.scriptClusters || [],
      };
      section.slideIds.push(slide.id);
      slides.push(slide);
    }
    sections.push(section);
  });

  /* --- 页面去重兜底 ---
     多款茶同场时，某些段落（工艺、凭证、库存）与具体产品关系不大，
     容易生成两张一模一样的页面。先用产品名区分标题；仍相同则合并成一张，
     把多出来的稿子接到前一张上 —— 讲的时候继续讲，但画面上不会重复。 */
  const seenSig = new Map();
  const deduped = [];
  for (const slide of slides) {
    const sig = slideSignature(slide);
    const prev = seenSig.get(sig);
    if (!prev) {
      seenSig.set(sig, slide);
      deduped.push(slide);
      continue;
    }
    if (slide.productName && !slide.title.includes(slide.productName)) {
      slide.title = `${slide.title} · ${slide.productName}`;
      const sig2 = slideSignature(slide);
      if (!seenSig.has(sig2)) {
        seenSig.set(sig2, slide);
        deduped.push(slide);
        continue;
      }
    }
    prev.mergedClusters = [...(prev.mergedClusters || []), ...(slide.scriptClusters || [])];
    prev.minutes = Math.round((prev.minutes + slide.minutes) * 10) / 10;
    prev.mergedFrom = [...(prev.mergedFrom || []), slide.id];
  }
  slides.length = 0;
  slides.push(...deduped);
  slides.forEach((s, i) => {
    s.index = i + 1;
    s.id = `s${String(i + 1).padStart(2, '0')}`;
  });
  // 文案规范化（必须放在生成 fullText 与合规检查之前，否则检查的文本和产出不一致）
  slides.forEach(normalizeSlideCopy);
  for (const section of sections) {
    section.slideIds = slides.filter((s) => s.sectionId === section.id).map((s) => s.id);
  }

  /* --- 稿子填充 + 时间轴 --- */
  let cursorSec = 0;
  const scriptSections = [];
  for (const section of sections) {
    const secSlides = slides.filter((s) => s.sectionId === section.id);
    if (!secSlides.length) continue;
    const start = cursorSec;
    const lines = [];
    const expandKey = section.productIndex === null ? 'global' : `p${section.productIndex}`;
    const expand = expanders.get(expandKey);
    for (const slide of secSlides) {
      const target = Math.max(0.4, slide.minutes * 0.9);
      const clusters = [...(slide.scriptClusters || []), ...(slide.mergedClusters || [])];
      slide.script = fitScript(clusters, target, expand, slide);
      delete slide.scriptClusters;
      delete slide.mergedClusters;
      slide.talkMinutes = Math.round(talkMinutes(slide.script.map((l) => l.text).join('')) * 10) / 10;
      lines.push(
        ...slide.script.map((l) => ({
          text: l.text,
          cue: l.cue || '',
          slideId: slide.id,
          slideIndex: slide.index,
          slideTitle: slide.title,
          productName: slide.productName,
        }))
      );
      cursorSec += slide.minutes * 60;
    }
    const text = lines.map((l) => l.text).join('');
    scriptSections.push({
      sectionId: section.id,
      title: section.title,
      goal: section.goal,
      productIndex: section.productIndex,
      startSec: Math.round(start),
      endSec: Math.round(cursorSec),
      plannedMinutes: section.minutes,
      talkMinutes: Math.round(talkMinutes(text) * 10) / 10,
      lines,
    });
  }

  // 文案规范化的**最终收口**：脚本是在上面「稿子填充」阶段才写回 slide.script 的，
  // 所以必须放在这里再跑一次，才能覆盖口播稿与 fullText / 合规检查（下面的 checkText 用得到）。
  slides.forEach(normalizeSlideCopy);
  for (const sec of scriptSections) {
    sec.lines = sec.lines.map((l) => ({ ...l, text: fixQuotes(l.text) }));
  }

  const fullText = scriptSections
    .map((sec) => {
      const head = `\n\n# ${sec.title}（约 ${fmtClock(sec.startSec)} 开始 / 计划 ${sec.plannedMinutes} 分钟）\n`;
      return head + sec.lines.map((l) => (l.cue ? `〔${l.cue}〕${l.text}` : l.text)).join('\n');
    })
    .join('\n');

  const scriptMinutes = scriptSections.reduce((a, s) => a + s.talkMinutes, 0);
  const gapMinutes = Math.max(0, Math.round((input.durationMin - scriptMinutes) * 10) / 10);
  const interaction = buildInteractionPlan(gapMinutes);
  const interactionMinutes = Math.round(interaction.reduce((a, i) => a + i.minutes, 0) * 10) / 10;

  const check = checkText(fullText, { compliance });

  const deck = {
    id: `deck_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    input,
    meta: {
      ...meta,
      stats: {
        slideCount: slides.length,
        sectionCount: sections.length,
        scriptChars: charCount(fullText),
        scriptMinutes: Math.round(scriptMinutes * 10) / 10,
        interactionMinutes,
        interactionCount: interaction.length,
        // 逐字稿覆盖：主播照着念的时间占全场比例
        verbatimCoverage: Math.round((scriptMinutes / input.durationMin) * 100),
        // 排满率：逐字稿 + 互动环节提词，合计覆盖全场
        fillRate: Math.min(100, Math.round(((scriptMinutes + interactionMinutes) / input.durationMin) * 100)),
        gapMinutes: Math.max(0, Math.round((input.durationMin - scriptMinutes - interactionMinutes) * 10) / 10),
      },
    },
    product: {
      ...primary,
      mountain: undefined,
    },
    products: products.map((p) => ({ ...p, mountain: undefined })),
    mountain: primary.mountain
      ? {
          id: primary.mountain.id,
          name: primary.mountain.name,
          region: primary.mountain.region,
          area: primary.mountain.area,
          altitude: primary.mountain.altitude,
          treeAge: primary.mountain.treeAge,
          treeType: primary.mountain.treeType,
          soil: primary.mountain.soil,
          aroma: primary.mountain.aroma || [],
          taste: primary.mountain.taste || [],
          soup: primary.mountain.soup,
          leaf: primary.mountain.leaf,
          grade: primary.mountain.grade,
          pitfalls: primary.mountain.pitfalls || [],
          sellingPoints: primary.mountain.sellingPoints || [],
        }
      : null,
    sections,
    slides,
    interaction,
    script: {
      minutes: Math.round(scriptMinutes * 10) / 10,
      fullText,
      sections: scriptSections,
    },
    compliance: summarize(check),
  };

  return deck;
}

export function deckToExportModel(deck) {
  return {
    meta: deck.meta,
    product: deck.product,
    products: deck.products,
    mountain: deck.mountain,
    sections: deck.sections,
    slides: deck.slides,
    interaction: deck.interaction,
  };
}
