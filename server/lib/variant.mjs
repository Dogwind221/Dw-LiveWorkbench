/**
 * A/B 方案对比（第 12 周：内容生产效率）。
 *
 * ## 要解决的问题
 *
 * "这个山头该怎么讲？"——同样的茶叶，讲知识科普还是讲山场故事？
 * 面对新手还是老茶客？凭感觉选，选完也不知道差在哪。
 *
 * 这个模块用**同一份事实**生成多个变体，然后给出可比的指标，
 * 让你看着数字选，而不是靠"我觉得"。
 *
 * ## 最重要的一条：**事实锁定**
 *
 * 变体之间只允许改**呈现方式**（目的 / 受众 / 风格 / 时长），
 * **绝不允许改事实**（山头、茶品、价格、规格、年份）。
 *
 * 为什么这是硬约束：如果 A 方案说 800 元、B 方案说 1200 元，
 * 那这两个不是"两种讲法"，而是**两个不同的商品** —— 拿来对比毫无意义，
 * 而且一旦选错就是价格事故。
 *
 * 所以每个变体都算一个 `factSignature`（事实字段的确定性哈希），
 * 对比时先校验它们是否一致；不一致直接给警告，不接受这次对比。
 *
 * ## 不假装有"唯一最优"
 *
 * 对比结果给的是**三组指标 + 三个"哪个更适合什么目标"的提示**，
 * 而不是一个"综合评分第一名"。因为"最安全"和"信息密度最高"经常不是同一份，
 * 合成为一个分数只会把真实取舍藏起来 —— 那是假精确。
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { buildDeck } from './deck/build.mjs';
import { writeJson } from './store.mjs';

/** 事实字段：这些决定"卖的是什么"，变体之间必须完全一致。 */
const FACT_FIELDS = [
  'mountainName', 'productName', 'type', 'year', 'spec', 'price', 'comparePrice', 'gift', 'stock', 'products',
];

/** 呈现字段：这些是允许变的，也正是 A/B 要对比的变量。 */
const PRESENTATION_FIELDS = ['purpose', 'audience', 'style', 'durationMin'];

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** 事实指纹。两个变体必须指纹相同才叫"同一件商品的不同讲法"。 */
export function factSignatureOf(deck) {
  const input = deck?.input || {};
  const picked = {};
  for (const k of FACT_FIELDS) if (input[k] !== undefined) picked[k] = input[k];
  return crypto.createHash('sha256').update(stableStringify(picked), 'utf8').digest('hex').slice(0, 16);
}

/** 从口播稿里抽出"开场钩子"——A/B 最直观的差异往往在第一句。 */
function hookOf(deck) {
  const text = String(deck?.script?.fullText || '');
  // 第一行通常是 `# 封面（约 ...）` 这种标题，跳过它
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const body = lines.find((l) => !l.startsWith('#') && !l.startsWith('【'));
  return (body || lines[0] || '').slice(0, 60);
}

/** 单个变体的可对比指标。 */
function metricsOf(deck) {
  const s = deck?.meta?.stats || {};
  const planned = Number(deck?.meta?.durationMin) || 0;
  const scriptMinutes = Number(s.scriptMinutes) || 0;
  const scriptChars = Number(s.scriptChars) || (deck?.script?.fullText || '').length;
  const comp = deck?.compliance || {};
  const counts = comp.counts || {};
  return {
    plannedMin: planned,
    slides: (deck.slides || []).length,
    scriptChars,
    scriptMinutes,
    interactionMinutes: Number(s.interactionMinutes) || 0,
    verbatimCoverage: s.verbatimCoverage ?? null,
    fillRate: s.fillRate ?? null,
    gapMinutes: s.gapMinutes ?? null,
    // 单位时间信息密度：不同时长的方案只能比这个，不能比绝对字数
    densityPerMin: planned > 0 ? Math.round((scriptChars / planned) * 10) / 10 : null,
    // 内容占比：口播占计划时长的比例，太低=冷场，太高=没互动
    contentRatio: planned > 0 ? Math.round((scriptMinutes / planned) * 1000) / 10 : null,
    compliance: {
      level: comp.level || 'unknown',
      score: comp.score ?? null,
      high: counts.high ?? 0,
      medium: counts.medium ?? 0,
      warnTotal: comp.warnTotal ?? 0,
    },
    hook: hookOf(deck),
  };
}

/**
 * 生成一组变体并对比。
 *
 * @param {object} opts
 * @param {object} [opts.base]        所有变体共享的输入（含事实字段）
 * @param {Array<{label:string, overrides?:object}>} opts.variants 变体定义
 * @param {string} [opts.groupId]     分组 id（默认自动生成）
 * @param {boolean} [opts.persist]    是否落盘（默认 true）
 * @param {string} [opts.tag]         可选标记，写进每个方案（便于归类或测试清扫）
 */
export function buildVariants({ base = {}, variants = [], groupId, persist = true, tag = '' } = {}) {
  if (!Array.isArray(variants) || variants.length < 2) {
    const err = new Error('至少给两个变体，否则没有对比的意义');
    err.code = 'NEED_TWO_VARIANTS';
    throw err;
  }
  if (variants.length > 6) {
    const err = new Error('单组最多 6 个变体（再多就分不清了）');
    err.code = 'TOO_MANY_VARIANTS';
    throw err;
  }

  const gid = groupId || `grp_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

  const built = variants.map((v, i) => {
    const label = String(v?.label || `变体 ${i + 1}`);
    const overrides = v?.overrides || {};
    // 记录这一变体实际改了哪些呈现字段，用于说明"差异来自哪里"
    const changed = PRESENTATION_FIELDS.filter(
      (k) => overrides[k] !== undefined && String(overrides[k]) !== String(base[k])
    );
    const deck = buildDeck({ ...base, ...overrides });
    const saved = {
      ...deck,
      variantGroupId: gid,
      variantLabel: label,
      factSignature: factSignatureOf(deck),
      ...(tag ? { tag } : {}),
    };
    if (persist) {
      try {
        writeJson(path.join('decks', `${deck.id}.json`), saved);
      } catch {
        /* 落盘失败不该让对比结果丢失，下面仍返回指标 */
      }
    }
    return {
      label,
      deckId: deck.id,
      changed,
      overrides,
      factSignature: saved.factSignature,
      meta: {
        purpose: deck.meta?.purpose,
        purposeLabel: deck.meta?.purposeLabel,
        audience: deck.meta?.audience,
        audienceLabel: deck.meta?.audienceLabel,
        style: deck.meta?.style,
        styleLabel: deck.meta?.styleLabel,
        durationMin: deck.meta?.durationMin,
      },
      metrics: metricsOf(deck),
    };
  });

  /* --- 事实锁定校验 --- */
  const sigs = new Set(built.map((b) => b.factSignature));
  const factLocked = sigs.size === 1;
  const warnings = [];

  if (!factLocked) {
    warnings.push({
      level: 'error',
      code: 'FACT_CHANGED',
      message:
        '变体之间的事实字段不一致（价格/规格/商品被改了）。这不是"同一件商品的两种讲法"，' +
        '而是不同的商品 —— 不要拿来做 A/B 对比，容易变成价格事故。',
    });
  }

  const durations = new Set(built.map((b) => b.metrics.plannedMin));
  if (durations.size > 1) {
    warnings.push({
      level: 'info',
      code: 'DURATION_DIFFERS',
      message: '计划时长不同，绝对字数不可直接比较。请对比「信息密度（字/分钟）」和「内容占比」。',
    });
  }

  const risky = built.filter((b) => b.metrics.compliance.high > 0);
  if (risky.length) {
    warnings.push({
      level: 'warn',
      code: 'COMPLIANCE_HIGH',
      message: `有 ${risky.length} 个变体含高危违禁词：${risky.map((r) => r.label).join('、')}。播出前必须改。`,
    });
  }

  /* --- 决策提示（不合成总分）--- */
  const bySafest = [...built].sort((a, b) => {
    const ah = a.metrics.compliance.high;
    const bh = b.metrics.compliance.high;
    if (ah !== bh) return ah - bh; // 高危词越少越安全
    return (a.metrics.compliance.score ?? 99) - (b.metrics.compliance.score ?? 99);
  })[0];
  const byDensest = [...built].sort(
    (a, b) => (b.metrics.densityPerMin ?? 0) - (a.metrics.densityPerMin ?? 0)
  )[0];
  const byInteractive = [...built].sort(
    (a, b) => b.metrics.interactionMinutes - a.metrics.interactionMinutes
  )[0];

  const guidance = {
    safest: { label: bySafest.label, deckId: bySafest.deckId, why: `高危违禁词 ${bySafest.metrics.compliance.high} 个、合规分 ${bySafest.metrics.compliance.score}` },
    densest: { label: byDensest.label, deckId: byDensest.deckId, why: `${byDensest.metrics.densityPerMin} 字/分钟` },
    mostInteractive: { label: byInteractive.label, deckId: byInteractive.deckId, why: `互动 ${byInteractive.metrics.interactionMinutes} 分钟` },
    note: '没有唯一最优：要安全选 safest，要讲透选 densest，要留人选 mostInteractive。按这场直播的目标定。',
  };

  return {
    groupId: gid,
    at: new Date().toISOString(),
    factLocked,
    factSignature: factLocked ? [...sigs][0] : null,
    changedFields: [...new Set(built.flatMap((b) => b.changed))],
    variants: built,
    warnings,
    guidance,
  };
}
