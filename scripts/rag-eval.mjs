#!/usr/bin/env node
/**
 * RAG 评测（契约第 9 节）。
 *
 * 为什么要有这个脚本：检索质量是"感觉不错"最容易骗人的地方。
 * 44 个山头、38 个茶品、12 类合规词，问一句"老班章和布朗山差在哪"，
 * top5 里到底有没有那两条 passage，只有跑数字才知道。
 *
 * 两种模式：
 *   node scripts/rag-eval.mjs --offline    只测检索，不调 LLM。这是主要用法。
 *   node scripts/rag-eval.mjs              额外测 citationValidity；LLM 不可用则跳过，不崩。
 *
 * 退出码：recall@k（默认 k=5）≥ 0.7 → 0，否则 1。
 *         2 = golden 集读不了/不合法；3 = rag 核心模块缺失（rag-core 还没交付）。
 *
 * 约定（写进报告里，避免误读）：
 *   - 一条 case 的 expectChunkIds 是**可接受集合**，命中任意一个即算命中该 case。
 *   - recall@k 是 case 级命中率（不是 chunk 级召回率）。
 *   - MRR 取首个命中期望 chunk 的排名倒数；k 深度内没找到记 0。
 *   - 拒答题（shouldRefuse:true）不进 recall/MRR 分母，只进 refusalAccuracy。
 *   - 离线拒答判定没有 LLM 可问，只能看检索分。三个候选信号都报，主口径默认 bm25：
 *       bm25   —— 词法覆盖度，库外问题几乎没有共享 n-gram，实测分隔最好（主口径）
 *       vector —— 向量余弦，绝对相似度，跨 query 可比
 *       fused  —— RRF 融合分；量纲 ≈0.03，与 answer.mjs 的 MIN_TOP_SCORE=0.35 差一个数量级
 *     阈值用 --refuse-threshold 覆盖，信号用 --refuse-signal 切换。
 *   - 失败清单的判据是"没过门禁的 recall@k"，和 headline 数字严格对齐。
 *   - --json 时 stdout 只出 JSON，人读摘要走 stderr，方便 `| jq`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const GOLDEN_PATH = path.join(ROOT, 'data', 'eval', 'kb-golden.json');

/* ------------------------------------------------------------------ 参数 */

function parseArgv(argv) {
  const opts = {
    offline: false,
    json: false,
    k: 5,
    ks: [1, 3, 5, 10, 50],
    threshold: 0.7,
    // 离线拒答判定 = 看检索分。三个候选信号的默认阈值都是在当前 golden 集（56 条：38 应达 / 18 库外）
    // 上精扫出来的，换标注集或换语料必须重跑 --sweep，别沿用：
    //   bm25   19    —— 词法覆盖度，是唯一有区分度的信号（主口径）
    //   vector 0.17  —— 余弦相似度；实测在 bm25<19 上做"且"条件不改变结果（非约束），留作诊断
    //   fused  0.35  —— = answer.mjs 的旧 RAG_MIN_SCORE，保留它就是为了暴露量纲不匹配
    refuseSignal: 'bm25',
    refuseThreshold: null,
    refuseThresholds: { vector: 0.17, bm25: 19, fused: 0.35 },
    // --sweep：BM25 阈值 × 向量阈值 的二维网格。阈值该由数据定，不该由人拍，
    // 所以这里给一条命令就能重标任意语料/任意标注集下的最优点。
    sweep: false,
    sweepBm: null,
    sweepVec: null,
    sweepSteps: 12,
    sweepTop: 8,
    sweepMarks: [],
    // --channels：分通道 / 分融合权重的召回对照。用来回答"这个权重是不是把某一路废掉了"，
    // 而不是靠感觉。权重变了、或者怀疑某条 case 是"被融合压死"而不是"检索不到"，就跑它。
    channels: false,
    verbose: false,
    dumpChunks: false,
    probe: null,
    only: null,
    topN: 3,
  };
  const take = (a, i) => (a[i].includes('=') ? a[i].split('=').slice(1).join('=') : a[i + 1]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--dump-chunks') opts.dumpChunks = true;
    else if (a.startsWith('--k=') || a === '--k') {
      const v = Number(take(argv, i));
      if (!Number.isFinite(v) || v < 1) throw new Error(`--k 需要 ≥1 的数字，收到 ${take(argv, i)}`);
      opts.k = Math.floor(v);
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--ks=') || a === '--ks') {
      const v = take(argv, i);
      opts.ks = String(v).split(',').map((x) => Math.floor(Number(x))).filter((x) => Number.isFinite(x) && x > 0);
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--threshold=') || a === '--threshold') {
      opts.threshold = Number(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--refuse-signal=') || a === '--refuse-signal') {
      opts.refuseSignal = String(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--refuse-threshold=') || a === '--refuse-threshold') {
      opts.refuseThreshold = Number(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--refuse-threshold-vector=') || a === '--refuse-threshold-vector') {
      opts.refuseThresholds.vector = Number(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--refuse-threshold-bm25=') || a === '--refuse-threshold-bm25') {
      opts.refuseThresholds.bm25 = Number(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a === '--sweep') opts.sweep = true;
    else if (a === '--channels') opts.channels = true;
    else if (a.startsWith('--sweep-bm=') || a === '--sweep-bm') {
      opts.sweepBm = parseNums(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--sweep-vec=') || a === '--sweep-vec') {
      opts.sweepVec = parseNums(take(argv, i));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--sweep-steps=') || a === '--sweep-steps') {
      opts.sweepSteps = Math.min(40, Math.max(2, Math.floor(Number(take(argv, i)))));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--sweep-top=') || a === '--sweep-top') {
      opts.sweepTop = Math.max(1, Math.floor(Number(take(argv, i))));
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--sweep-mark=') || a === '--sweep-mark') {
      const p = parseNums(take(argv, i));
      if (p.length !== 2) throw new Error('--sweep-mark 需要两个数字，如 --sweep-mark=18,0.15');
      opts.sweepMarks.push(p);
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--probe=') || a === '--probe') {
      opts.probe = String(take(argv, i)).split(',').filter(Boolean);
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--only=') || a === '--only') {
      opts.only = String(take(argv, i)).split(',').filter(Boolean);
      if (!a.includes('=')) i++;
    } else if (a.startsWith('--show=') || a === '--show') {
      opts.topN = Math.max(1, Math.floor(Number(take(argv, i))));
      if (!a.includes('=')) i++;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${a}（--help 看用法）`);
    }
  }
  // 报告的 k 深度至少要覆盖所有要报的 recall@k
  opts.depth = Math.max(opts.k, ...opts.ks, 10);
  opts.ks = [...new Set([...opts.ks, opts.k])].sort((a, b) => a - b);
  if (!SIGNALS.includes(opts.refuseSignal)) throw new Error(`--refuse-signal 只能是 ${SIGNALS.join(' | ')}，收到 ${opts.refuseSignal}`);
  return opts;
}

const HELP = `用法：node scripts/rag-eval.mjs [选项]

  --offline                 不调 LLM，只测检索（默认主用法）
  --json                    stdout 只输出 JSON（人读摘要走 stderr）
  --sweep                   BM25 阈值 × 向量阈值 二维网格扫描（含单信号表 + 最优点）
  --channels                分通道 / 分融合权重的召回对照（判断某条 case 是不是被融合压死）
  --sweep-bm=6,10,18        显式指定 BM25 候选阈值（默认按观测区间等分）
  --sweep-vec=0.10,0.15     显式指定向量余弦候选阈值
  --sweep-steps=12          等分取点数（默认 12 → 13 个阈值）
  --sweep-top=8             --json 里列出粗网格平衡值最高的前 N 格（默认 8）
  --sweep-mark=18,0.15      额外标出某个阈值组合（可重复，用于对照人工设定）
  --k=5                     门禁用的 recall@k 与 k 深度（默认 5）
  --ks=1,3,5,10,50          要报告的 recall@k 列表
  --threshold=0.7           退出码门禁：recall@k ≥ 该值才退出 0
  --refuse-signal=vector    离线拒答用哪个信号：vector | bm25 | fused（默认 vector）
  --refuse-threshold=0.12   覆盖所选信号的拒答阈值
  --refuse-threshold-vector=0.12 / --refuse-threshold-bm25=6  分信号覆盖
  --probe=c01,c02           打印这些 case 的 top-k 检索结果
  --only=c01,c03            只跑这些 case
  --show=3                  失败用例展示的 top-N（默认 3）
  --dump-chunks             打印全部 passage 的 id/title（用于对齐 golden id）
  -v, --verbose             打印每个 case 的逐条结果
  -h, --help                本帮助

退出码：0 = recall@k ≥ threshold；1 = 未达标；2 = golden 集问题；3 = rag 核心模块缺失`;

/* ------------------------------------------------------------------ 工具 */

const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

function loadGolden() {
  if (!fs.existsSync(GOLDEN_PATH)) throw new Error(`golden 集不存在：${GOLDEN_PATH}`);
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`golden 集不是合法 JSON：${e.message}`);
  }
  if (!Array.isArray(data.cases) || !data.cases.length) throw new Error('golden 集里没有 cases');
  const problems = [];
  const seen = new Set();
  for (const [i, c] of data.cases.entries()) {
    const at = c.id || `#${i}`;
    if (!c.id) problems.push(`${at}: 缺 id`);
    if (seen.has(c.id)) problems.push(`${at}: id 重复`);
    seen.add(c.id);
    if (typeof c.question !== 'string' || !c.question.trim()) problems.push(`${at}: question 为空`);
    if (typeof c.shouldRefuse !== 'boolean') problems.push(`${at}: shouldRefuse 必须是 true/false`);
    const ids = c.expectChunkIds;
    if (!Array.isArray(ids)) problems.push(`${at}: expectChunkIds 必须是数组`);
    else if (c.shouldRefuse === false && ids.length === 0) problems.push(`${at}: 应答题却没给 expectChunkIds`);
    else if (ids.length > 3) problems.push(`${at}: expectChunkIds 最多 3 个（现在 ${ids.length} 个）`);
    if (!['colloquial', 'keyword'].includes(c.style)) problems.push(`${at}: style 必须是 colloquial | keyword（口语化查询占比要看它）`);
    if (c.shouldRefuse === false) {
      if (!Array.isArray(c.expectTypes) || !c.expectTypes.length) problems.push(`${at}: expectTypes 为空`);
      // expectText：期望块里**必须**出现的字符串。chunk id 可能还在、内容却已被重新分块搬走，
      // 只查 id 存在会漏掉这种漂移，所以语义也要查一遍。
      if (typeof c.expectText !== 'string' || !c.expectText.trim()) problems.push(`${at}: 应答题必须给 expectText（期望块里必须出现的字符串）`);
    } else if (Array.isArray(ids) && ids.length) {
      problems.push(`${at}: 拒答题不该有 expectChunkIds`);
    }
  }
  return { data, problems };
}

/* ------------------------------------------------------------- 指标计算 */

/** 一条 case 在某个 k 深度是否命中（期望 id 命中任意一个即算命中）。 */
function hitAt(ids, expectedSet, k) {
  return ids.slice(0, k).some((id) => expectedSet.has(id));
}

/** 首个命中期望 chunk 的排名（1-based）；找不到返回 0。 */
function firstRank(ids, expectedSet) {
  const i = ids.findIndex((id) => expectedSet.has(id));
  return i < 0 ? 0 : i + 1;
}

function evaluate(cases, retrieve) {
  const rows = [];
  for (const c of cases) {
    const hits = retrieve(c.question);
    const ids = hits.map((h) => h.chunk.id);
    const expectedSet = new Set(c.expectChunkIds || []);
    const top = hits[0];
    rows.push({
      id: c.id,
      question: c.question,
      style: c.style || 'unknown',
      shouldRefuse: c.shouldRefuse,
      expectChunkIds: c.expectChunkIds || [],
      expectTypes: c.expectTypes || [],
      gotIds: ids,
      got: hits.map((h) => ({
        id: h.chunk.id,
        type: h.chunk.type,
        title: h.chunk.title,
        score: Number(Number(h.score).toFixed(4)),
        vector: Number(Number(h.scores?.vector ?? 0).toFixed(4)),
        bm25: Number(Number(h.scores?.bm25 ?? 0).toFixed(4)),
      })),
      rank: firstRank(ids, expectedSet),
      rankByK: Object.fromEntries((c.__ks || []).map((k) => [k, hitAt(ids, expectedSet, k)])),
      top1Score: Number(top?.score ?? 0),
      top1Vector: Number(top?.scores?.vector ?? 0),
      top1Bm25: Number(top?.scores?.bm25 ?? 0),
    });
  }
  return rows;
}

function summarize(rows, opts) {
  const answerable = rows.filter((r) => !r.shouldRefuse);
  const refuseCases = rows.filter((r) => r.shouldRefuse);

  const recall = {};
  for (const k of opts.ks) recall[`recall@${k}`] = mean(answerable.map((r) => (r.rankByK[k] ? 1 : 0)));

  const mrr = mean(answerable.map((r) => (r.rank ? 1 / r.rank : 0)));

  // 口语化 vs 关键词式查询的分层指标：scout 的判断是"纯术语查询会让指标虚高"，
  // 分层报出来才能验证这个判断，而不是只在总体数字上打转。
  const styles = {};
  for (const st of ['colloquial', 'keyword']) {
    const sub = answerable.filter((r) => r.style === st);
    if (!sub.length) continue;
    styles[st] = {
      cases: sub.length,
      ...Object.fromEntries(opts.ks.map((k) => [`recall@${k}`, mean(sub.map((r) => (r.rankByK[k] ? 1 : 0)))])),
      mrr: mean(sub.map((r) => (r.rank ? 1 / r.rank : 0))),
    };
  }

  const gate = {
    metric: `recall@${opts.k}`,
    value: recall[`recall@${opts.k}`],
    threshold: opts.threshold,
  };
  gate.pass = Number.isFinite(gate.value) && gate.value >= gate.threshold;

  // 三个信号各自在默认阈值与扫描最优阈值下的表现
  const signals = {};
  for (const sig of SIGNALS) {
    const thr = opts.refuseThreshold != null && sig === opts.refuseSignal ? opts.refuseThreshold : opts.refuseThresholds[sig];
    const at = refusalAt(rows, sig, thr);
    const scan = scanThresholds(rows, sig);
    signals[sig] = { ...at, scanBest: scan.best, curve: scan.curve };
  }
  const primary = signals[opts.refuseSignal];
  if (!primary) throw new Error(`未知拒答信号：${opts.refuseSignal}`);

  return {
    recall,
    mrr,
    styles,
    gate,
    signals,
    primary,
    counts: { total: rows.length, answerable: answerable.length, refuse: refuseCases.length },
  };
}

/**
 * 通道 / 权重对照（--channels）。
 *
 * 动机：一条 case 没进 top5，可能是"检索不到"，也可能是"检索到了但被融合权重压死"。
 * 这两种的修法完全不同（前者改 embed/BM25，后者改权重），所以必须先分开量出来。
 * createRetriever(chunks, {wBM25,wVector,...}) 是契约里就有的口子，这里只是把它用起来。
 */
function buildChannels(chunks, cases, opts, createRetriever) {
  // evaluate() 靠 c.__ks 决定要统计哪些 k；cases 是共享对象，先补上再跑
  const answerable = cases.filter((c) => !c.shouldRefuse);
  for (const c of answerable) if (!c.__ks) c.__ks = opts.ks;
  const evalWith = (retrieve) => {
    const rows = evaluate(answerable, retrieve);
    const rec = {};
    for (const k of opts.ks) rec[`recall@${k}`] = mean(rows.map((r) => (r.rankByK[k] ? 1 : 0)));
    return { ...rec, mrr: mean(rows.map((r) => (r.rank ? 1 / r.rank : 0))), rows, n: rows.length };
  };

  const variants = [];
  const addFused = (label, rOpts) => {
    const r = createRetriever(chunks, rOpts);
    variants.push({ label, kind: 'fused', m: evalWith((q) => r.search(q, opts.depth)) });
  };

  // 单通道：直接用 retriever 暴露的 searchBM25 / searchVector，不走融合
  const base = createRetriever(chunks);
  variants.push({ label: '仅 BM25 通道', kind: 'single', m: evalWith((q) => base.searchBM25(q, opts.depth)) });
  variants.push({ label: '仅 向量通道', kind: 'single', m: evalWith((q) => base.searchVector(q, opts.depth)) });
  addFused('融合 0.9/0.1（当前默认）', {});
  for (const [wb, wv] of [[0.8, 0.2], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7]]) addFused(`融合 ${wb}/${wv}`, { wBM25: wb, wVector: wv });
  addFused('融合 0.9/0.1 + 关实体加分', { entityBoost: 0 });
  addFused('融合 0.9/0.1 + 关实体保底', { entityGuarantee: false });

  // 关键 case 的逐变体排名：c28/c30 这类"被融合压死"的嫌疑犯
  const probeIds = [...new Set([...(opts.probe || []), 'c28', 'c30'])].filter((id) => answerable.some((c) => c.id === id));
  const ranks = probeIds.map((id) => ({ id, byVariant: variants.map((v) => v.m.rows.find((r) => r.id === id)?.rank ?? 0) }));

  return { n: answerable.length, variants: variants.map((v) => ({ label: v.label, ...v.m, rows: undefined })), probeIds, ranks, ks: opts.ks, depth: opts.depth };
}

function printChannels(ch, L) {
  L('');
  L(`--- 通道 / 权重对照（应答题 ${ch.n} 条，同一套 golden）---`);
  L(`  ${'配置'.padEnd(28)}${ch.ks.map((k) => `recall@${String(k)}`.padStart(10)).join('')}${'MRR'.padStart(9)}`);
  let best = null;
  for (const v of ch.variants) {
    const r5 = v['recall@5'];
    if (!best || r5 > best['recall@5'] || (r5 === best['recall@5'] && v.mrr > best.mrr)) best = v;
  }
  for (const v of ch.variants) {
    const mark = v === best ? ' ←' : '';
    L(`  ${v.label.padEnd(28)}${ch.ks.map((k) => f3(v[`recall@${k}`]).padStart(10)).join('')}${f3(v.mrr).padStart(9)}${mark}`);
  }
  if (ch.ranks.length) {
    L('');
    L(`  关键 case 的逐变体排名（0 = 深度内完全没出现）：`);
    for (const { id, byVariant } of ch.ranks) {
      L(`    ${id}: ` + byVariant.map((r, i) => `${ch.variants[i].label.split('（')[0]}=${r || '>'+50}`).join('  '));
    }
    const diff = ch.ranks.some(({ byVariant }) => new Set(byVariant).size > 1);
    L(diff ? '    → 排名随配置变化 ⇒ 这几条是"被融合压死"，不是"检索不到"' : '    → 排名不随配置变化 ⇒ 不是融合权重问题，别在权重上花时间');
  }
}

/**
 * 阈值扫描（Lead 要求的 ②）。
 *
 * 判定规则固定为「两个信号都说过没证据才拒答」：refuse iff (bm25 < tB 且 向量 < tV)。
 * 平衡值取 min(放行应答题率, 拒掉库外题率) —— 保守口径，不偏袒任何一边：
 * 只要有一边被牺牲（比如全放行 → 拒答率 0），平衡值就是 0，不会被另一边的高分掩盖。
 *
 * 候选阈值默认按观测区间等分，不做任何"先看答案再挑点"的裁剪；
 * 这样换语料、扩标注集，直接重跑就是新的最优点。
 */
function buildSweep(rows, opts) {
  const answerable = rows.filter((r) => !r.shouldRefuse);
  const refuseCases = rows.filter((r) => r.shouldRefuse);
  const axis = (values, explicit) =>
    explicit && explicit.length ? [...explicit].sort((a, b) => a - b) : linspace(Math.min(...values), Math.max(...values), opts.sweepSteps);

  const bmThresholds = axis(rows.map((r) => r.top1Bm25), opts.sweepBm);
  const vecThresholds = axis(rows.map((r) => r.top1Vector), opts.sweepVec);

  const cell = (tB, tV) => {
    const refused = (r) => r.top1Bm25 < tB && r.top1Vector < tV;
    const passRate = answerable.length ? answerable.filter((r) => !refused(r)).length / answerable.length : NaN;
    const refuseRate = refuseCases.length ? refuseCases.filter(refused).length / refuseCases.length : NaN;
    return { bm: Number(tB.toFixed(4)), vec: Number(tV.toFixed(4)), passRate, refuseRate, balance: Math.min(passRate, refuseRate) };
  };

  const grid = bmThresholds.map((tB) => vecThresholds.map((tV) => cell(tB, tV)));
  const flat = grid.flat();
  const rank = (a, b) => b.balance - a.balance || b.passRate + b.refuseRate - (a.passRate + a.refuseRate);
  const sorted = [...flat].sort(rank);

  // 粗网格是给人看"形状"的，13×13 的步长会漏掉真正的峰值
  // （实测：粗网格最优平衡 77.8%，在全部观测值上精扫是 83.3%）。
  // 所以最优点一律以精扫为准，粗网格只用来标 * 给人看趋势。
  const exact = fineScans(rows);

  // 单点最优是几百个组合里挑出来的，天然有过拟合风险。
  // 在最优值 5 个百分点内的格子也算一遍范围，能看出峰值是"高原"还是"孤峰"。
  const near = flat.filter((c) => c.balance >= sorted[0].balance - 0.05);
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const robust = near.length >= 5;
  const plateau = {
    cells: near.length,
    of: flat.length,
    robust,
    bmRange: [Math.min(...near.map((c) => c.bm)), Math.max(...near.map((c) => c.bm))],
    vecRange: [Math.min(...near.map((c) => c.vec)), Math.max(...near.map((c) => c.vec))],
    bmRecommend: robust ? med(near.map((c) => c.bm)) : sorted[0].bm,
    vecRecommend: robust ? med(near.map((c) => c.vec)) : sorted[0].vec,
  };

  // 推荐：四种规则里平衡值最高的那个。单信号赢过联合的话必须说出来 ——
  // 那意味着第二路信号在这个标注集上没挣到自己的复杂度。
  const all = [
    { rule: 'jointAnd', label: `bm25 < ${exact.jointAnd.bm} 且 向量 < ${exact.jointAnd.vec}`, ...exact.jointAnd },
    { rule: 'bmOnly', label: `仅 bm25 < ${exact.bmOnly.bm}`, ...exact.bmOnly },
    { rule: 'jointOr', label: `bm25 < ${exact.jointOr.bm} 或 向量 < ${exact.jointOr.vec}`, ...exact.jointOr },
    { rule: 'vecOnly', label: `仅 向量 < ${exact.vecOnly.vec}`, ...exact.vecOnly },
  ].sort((a, b) => b.balance - a.balance);
  const recommend = all[0];
  const jointWins = recommend.rule === 'jointAnd' || recommend.rule === 'jointOr';

  return {
    rule: 'refuse iff (bm25 < tB 且 向量余弦 < tV)',
    balance: 'min(放行应答题率, 拒掉库外题率)',
    counts: { answerable: answerable.length, refuse: refuseCases.length },
    bmThresholds: bmThresholds.map((v) => Number(v.toFixed(4))),
    vecThresholds: vecThresholds.map((v) => Number(v.toFixed(4))),
    grid,
    gridBest: sorted[0],
    exact,
    all,
    recommend,
    jointWins,
    top: sorted.slice(0, opts.sweepTop),
    plateau,
    marks: opts.sweepMarks.map(([tB, tV]) => ({ ...cell(tB, tV), label: `bm<${tB} 且 vec<${tV}` })),
  };
}

/**
 * 在**全部观测到的分数**上精扫阈值（不做等分），四种判定规则各扫一遍。
 * 这是唯一能给出可信最优点的方式：等分网格的峰值位置取决于步长，而步长是任意的。
 */
function fineScans(rows) {
  const answerable = rows.filter((r) => !r.shouldRefuse);
  const refuseCases = rows.filter((r) => r.shouldRefuse);
  const rate = (f) => {
    const passRate = answerable.length ? answerable.filter((r) => !f(r)).length / answerable.length : NaN;
    const refuseRate = refuseCases.length ? refuseCases.filter(f).length / refuseCases.length : NaN;
    return { passRate, refuseRate, balance: Math.min(passRate, refuseRate) };
  };
  const cands = (key) => [...new Set(rows.map((r) => r[key]))].sort((a, b) => a - b);
  const bmC = cands('top1Bm25');
  const vecC = cands('top1Vector');
  const round = (x, n) => Number(x.toFixed(n));

  let bmOnly = { bm: 0, ...rate(() => false) };
  for (const t of bmC) {
    const m = rate((r) => r.top1Bm25 < t);
    if (m.balance > bmOnly.balance) bmOnly = { bm: round(t, 2), ...m };
  }
  let vecOnly = { vec: 0, ...rate(() => false) };
  for (const t of vecC) {
    const m = rate((r) => r.top1Vector < t);
    if (m.balance > vecOnly.balance) vecOnly = { vec: round(t, 4), ...m };
  }
  let jointAnd = { bm: 0, vec: 0, ...rate(() => false) };
  let jointOr = { bm: 0, vec: 0, ...rate(() => false) };
  for (const tb of bmC) {
    for (const tv of vecC) {
      const and = rate((r) => r.top1Bm25 < tb && r.top1Vector < tv);
      if (and.balance > jointAnd.balance) jointAnd = { bm: round(tb, 2), vec: round(tv, 4), ...and };
      const or = rate((r) => r.top1Bm25 < tb || r.top1Vector < tv);
      if (or.balance > jointOr.balance) jointOr = { bm: round(tb, 2), vec: round(tv, 4), ...or };
    }
  }
  return { bmOnly, vecOnly, jointAnd, jointOr };
}

/** 等分取点，含两端。n 段 → n+1 个点。 */
function linspace(min, max, n) {
  if (!(max > min)) return [min];
  return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
}

function parseNums(s) {
  return String(s)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
}

const pctInt = (x) => (Number.isFinite(x) ? String(Math.round(x * 100)).padStart(3) : '  -');

function printSweep(sw, L) {
  const w = 11;
  L('');
  L(`--- 阈值扫描 ${sw.bmThresholds.length} × ${sw.vecThresholds.length}（行=BM25 阈值，列=向量余弦阈值）`);
  L(`    判定：${sw.rule}；每格 = 放行应答题% / 拒掉库外题% / 平衡值`);
  L(`    平衡值 = ${sw.balance}（应答题 ${sw.counts.answerable} 条 / 库外题 ${sw.counts.refuse} 条）`);
  L('');
  L('  BM25\\向量 ' + sw.vecThresholds.map((v) => String(v.toFixed(3)).padStart(w)).join(''));
  for (const [i, tB] of sw.bmThresholds.entries()) {
    const cells = sw.grid[i].map((c) => {
      const isBest = c.bm === sw.gridBest.bm && c.vec === sw.gridBest.vec;
      const text = `${pctInt(c.passRate)}/${pctInt(c.refuseRate)}/${pctInt(c.balance)}`;
      return (isBest ? text + '*' : text).padStart(w);
    });
    L(`  <${String(tB.toFixed(1)).padStart(6)}  ` + cells.join(''));
  }
  L('');
  L(`  粗网格最优（* 标出，仅代表这个步长下最好的格子）：bm<${sw.gridBest.bm} 且 vec<${sw.gridBest.vec} → 平衡 ${(sw.gridBest.balance * 100).toFixed(1)}%`);
  L(`  抗过拟合（粗网格最优值 −5pt 内 ${sw.plateau.cells}/${sw.plateau.of} 格）：BM25 ∈ [${sw.plateau.bmRange[0]}, ${sw.plateau.bmRange[1]}]，向量 ∈ [${sw.plateau.vecRange[0]}, ${sw.plateau.vecRange[1]}]`);
  L('');
  L('  ── 精扫（在全部观测分数上扫，最优点以此为准；粗网格会漏峰）──');
  const row = (name, m, thr) => L(`     ${name.padEnd(14)} ${thr.padEnd(34)} 放行 ${(m.passRate * 100).toFixed(1)}%  拒答 ${(m.refuseRate * 100).toFixed(1)}%  平衡 ${(m.balance * 100).toFixed(1)}%`);
  row('仅 BM25', sw.exact.bmOnly, `bm25 < ${sw.exact.bmOnly.bm}`);
  row('仅 向量', sw.exact.vecOnly, `向量 < ${sw.exact.vecOnly.vec}`);
  row('联合 且', sw.exact.jointAnd, `bm25 < ${sw.exact.jointAnd.bm} 且 向量 < ${sw.exact.jointAnd.vec}`);
  row('联合 或', sw.exact.jointOr, `bm25 < ${sw.exact.jointOr.bm} 或 向量 < ${sw.exact.jointOr.vec}`);
  L('');
  L(`  ★ 推荐：${sw.recommend.label}  → 放行 ${(sw.recommend.passRate * 100).toFixed(1)}% / 拒答 ${(sw.recommend.refuseRate * 100).toFixed(1)}% / 平衡 ${(sw.recommend.balance * 100).toFixed(1)}%`);
  if (!sw.jointWins) {
    L(`     注意：赢的是**单信号**规则。也就是说第二路信号在这个标注集上没挣到自己的复杂度，`);
    L(`     要么去掉它，要么换一个真的互补的信号 —— 别为了"看起来更稳"硬加一路没用的判据。`);
  }
  for (const m of sw.marks) {
    L(`  对照 ${m.label}  → 放行 ${(m.passRate * 100).toFixed(1)}% / 拒答 ${(m.refuseRate * 100).toFixed(1)}% / 平衡 ${(m.balance * 100).toFixed(1)}%`);
  }
}
/** 单信号拒答用的三个候选取分函数。分数越大越"有证据"，低于阈值判定拒答。 */
const SIGNALS = ['vector', 'bm25', 'fused'];
const signalValue = (r, sig) => (sig === 'vector' ? r.top1Vector : sig === 'bm25' ? r.top1Bm25 : r.top1Score);

/** 给定信号与阈值下的拒答混淆矩阵。 */
function refusalAt(rows, sig, thr) {
  const answerable = rows.filter((r) => !r.shouldRefuse);
  const refuseCases = rows.filter((r) => r.shouldRefuse);
  const dec = (r) => signalValue(r, sig) < thr;
  const right = rows.filter((r) => dec(r) === r.shouldRefuse).length;
  const refuseHits = refuseCases.filter(dec).length;
  const answerHits = answerable.filter((r) => !dec(r)).length;
  // 平衡准确率：(拒答召回 + 应答通过率)/2，两类样本数差 6:35，只看总准确率会被大类带偏
  const rr = refuseCases.length ? refuseHits / refuseCases.length : NaN;
  const ap = answerable.length ? answerHits / answerable.length : NaN;
  return {
    signal: sig,
    threshold: Number(thr.toFixed(4)),
    accuracy: rows.length ? right / rows.length : NaN,
    balancedAccuracy: (rr + ap) / 2,
    refuseRecall: rr,
    answerPrecision: ap,
    missingRefusal: refuseCases.filter((r) => !dec(r)).map((r) => r.id),
    falseRefusal: answerable.filter(dec).map((r) => r.id),
  };
}

function scanThresholds(rows, sig) {
  const values = [...new Set(rows.map((r) => signalValue(r, sig)))].sort((a, b) => a - b);
  const grid = [...values.map((v) => v - 1e-9), ...values.map((v) => v + 1e-9), 0].filter((t) => t >= 0);
  let best = null;
  const curve = [];
  for (const t of grid) {
    const m = refusalAt(rows, sig, t);
    curve.push({ threshold: Number(t.toFixed(4)), accuracy: m.accuracy, balancedAccuracy: m.balancedAccuracy, refuseRecall: m.refuseRecall, answerPrecision: m.answerPrecision });
    if (!best || m.balancedAccuracy > best.balancedAccuracy || (m.balancedAccuracy === best.balancedAccuracy && m.accuracy > best.accuracy)) best = m;
  }
  return {
    // 曲线太长，只留平衡准确率发生变化的点，否则 JSON 里几百行没人看
    curve: curve.filter((p, i) => i === 0 || i === curve.length - 1 || p.balancedAccuracy !== curve[i - 1].balancedAccuracy),
    best: best
      ? { threshold: best.threshold, accuracy: best.accuracy, balancedAccuracy: best.balancedAccuracy, refuseRecall: best.refuseRecall, answerPrecision: best.answerPrecision }
      : null,
  };
}

/* ------------------------------------------------------------------ 主流程 */

async function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    console.error(`参数错误：${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  /* 1) 核心模块。rag-core 是并行开发的，缺失时给一句人能看懂的话，而不是堆栈。 */
  let buildChunks;
  let buildIndex;
  let createRetriever;
  try {
    ({ buildChunks } = await import('../server/lib/rag/chunk.mjs'));
    ({ buildIndex } = await import('../server/lib/rag/index.mjs'));
    // retriever 直接建的话更可控（能单独换 k），拿不到就走 buildIndex
    try {
      ({ createRetriever } = await import('../server/lib/rag/retrieve.mjs'));
    } catch {
      createRetriever = null;
    }
  } catch (e) {
    console.error(`[FATAL] 无法加载 rag 核心模块：${e.message}`);
    console.error('        scripts/rag-eval.mjs 依赖 server/lib/rag/{chunk,index}.mjs —— 这两个文件由 rag-core 交付。');
    console.error('        缺失时无法核对 expectChunkIds，也不会给出任何编造的指标。');
    return 3;
  }
  if (typeof buildChunks !== 'function') {
    console.error('[FATAL] server/lib/rag/chunk.mjs 没有导出 buildChunks()');
    return 3;
  }

  /* 2) 知识库 + 索引（--dump-chunks 要在 golden 校验之前，填 id 时 golden 还是空壳） */
  const { loadKB } = await import('../server/lib/kb.mjs');
  const kb = loadKB();

  const t0 = performance.now();
  let chunks;
  try {
    chunks = buildChunks(kb);
  } catch (e) {
    // rag-core 是并行开发的，编辑到一半的 chunk.mjs 会直接抛（实测遇到过 clamp/entityBoost 未定义）
    console.error(`[FATAL] buildChunks() 抛错：${e.message}`);
    console.error('        rag 核心可能正在被编辑。等它稳定后重跑，不要改 golden 去迁就。');
    return 3;
  }
  const buildMs = Math.round(performance.now() - t0);
  const chunkIds = new Set(chunks.map((c) => c.id));

  if (opts.dumpChunks) {
    for (const c of chunks) {
      console.log(`${c.id}\t[${c.type}]\t${c.title}\t${c.text.length}字\t${c.text.slice(0, 70).replace(/\s+/g, ' ')}`);
    }
    console.error(`[dump] ${chunks.length} 个 passage，buildMs=${buildMs}`);
    return 0;
  }

  /* 3) golden 集 */
  let golden;
  try {
    golden = loadGolden();
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    return 2;
  }
  if (golden.problems.length) {
    console.error(`[FATAL] golden 集不合法（${golden.problems.length} 处）：`);
    for (const p of golden.problems.slice(0, 20)) console.error(`        - ${p}`);
    return 2;
  }

  // golden 里引用了不存在的 chunk id → 一定是没对齐，直接拦下来，避免把脏期望算成"检索失败"
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const dangling = [];
  for (const c of golden.data.cases) {
    for (const id of c.expectChunkIds || []) {
      if (!chunkIds.has(id)) dangling.push(`${c.id} → ${id}`);
      // 顺带查 expectTypes：期望 id 的 type 必须写在 expectTypes 里，否则是手抄错了
      else if (!(c.expectTypes || []).includes(byId.get(id).type))
        dangling.push(`${c.id} → ${id} 的 type=${byId.get(id).type} 不在 expectTypes=[${(c.expectTypes || []).join(',')}] 里`);
    }
  }
  if (dangling.length) {
    console.error(`[FATAL] golden 集里有 ${dangling.length} 个 chunk id 不在 buildChunks() 输出里：`);
    for (const d of dangling.slice(0, 20)) console.error(`        - ${d}`);
    console.error('        这不是检索失败，是期望写错了。先 --dump-chunks 再填。');
    return 2;
  }

  // 语义守卫：id 还在、内容却被重新分块搬走了 —— 这种漂移查 id 是查不出来的。
  const semantic = [];
  for (const c of golden.data.cases) {
    if (c.shouldRefuse) continue;
    const texts = (c.expectChunkIds || []).map((id) => byId.get(id)?.text || '');
    if (!texts.some((t) => t.includes(c.expectText))) {
      semantic.push(`${c.id}: 期望块里找不到 expectText「${c.expectText}」`);
    }
  }
  if (semantic.length) {
    console.error(`[FATAL] golden 集有 ${semantic.length} 条期望语义对不上（chunk id 存在但内容已漂移）：`);
    for (const s of semantic.slice(0, 20)) console.error(`        - ${s}`);
    console.error('        compliance 类改过分块粒度后最容易踩这个：id 没失效，但 #n 里装的词换了。');
    return 2;
  }

  let index;
  if (createRetriever) index = { chunks, retriever: createRetriever(chunks) };
  else {
    index = buildIndex(kb);
    if (!index?.retriever) {
      console.error('[FATAL] buildIndex() 没返回 retriever');
      return 3;
    }
  }
  const retrieve = (q) => index.retriever.search(q, opts.depth);
  const rstats = typeof index.retriever.stats === 'function' ? index.retriever.stats() : {};

  /* 4) 选 case */
  let cases = golden.data.cases;
  if (opts.only) {
    const pick = new Set(opts.only);
    cases = cases.filter((c) => pick.has(c.id));
    if (!cases.length) {
      console.error(`[FATAL] --only 没匹配到任何 case：${opts.only.join(',')}`);
      return 2;
    }
  }
  for (const c of cases) c.__ks = opts.ks;

  /* 5) 跑检索指标 */
  let rows;
  try {
    rows = evaluate(cases, retrieve);
  } catch (e) {
    console.error(`[FATAL] 检索过程抛错：${e.message}`);
    console.error('        rag 核心（retrieve/embed）可能正在被编辑。等它稳定后重跑。');
    return 3;
  }
  const metrics = summarize(rows, opts);
  const sweep = opts.sweep ? buildSweep(rows, opts) : null;
  // 通道对照要在 summarize 之后跑，它会再建几个不同权重的索引（只读复用 rag-core 的 createRetriever）
  let channels = null;
  if (opts.channels) {
    if (!createRetriever) {
      console.error('[WARN] --channels 需要 server/lib/rag/retrieve.mjs 的 createRetriever，已跳过');
    } else {
      try {
        channels = buildChannels(chunks, cases, opts, createRetriever);
      } catch (e) {
        console.error(`[WARN] --channels 失败（rag 核心可能正在被编辑）：${e.message}`);
      }
    }
  }

  /* 6) citationValidity（只在非 offline 且真能调模型时） */
  let citations = { skipped: true, reason: '--offline：按契约不调模型' };
  if (!opts.offline) {
    citations = await evalCitations(kb, cases, opts);
  }

  // 失败 = 没过门禁指标。注意判据必须是 recall@k（门禁的 k），不是"深检索里排名第几"——
  // 用后者的会把"排到第 9 名"的 case 漏掉，数字和清单会不一致。
  const failures = rows
    .filter((r) => (r.shouldRefuse ? signalValue(r, opts.refuseSignal) >= metrics.primary.threshold : !r.rankByK[opts.k]))
    .map((r) => ({
      id: r.id,
      kind: r.shouldRefuse
        ? `应拒答但没拒（${opts.refuseSignal}=${signalValue(r, opts.refuseSignal)} ≥ ${metrics.primary.threshold}）`
        : `recall@${opts.k} 未命中（期望块最低排到第 ${r.rank || '>' + opts.depth} 名）`,
      bestRank: r.shouldRefuse ? null : r.rank || null,
      question: r.question,
      expected: r.expectChunkIds,
      expectTypes: r.expectTypes,
      got: r.got.slice(0, opts.topN),
    }));

  const result = {
    version: 1,
    mode: opts.offline ? 'offline' : 'online',
    generatedAt: new Date().toISOString(),
    golden: GOLDEN_PATH,
    kb: { updatedAt: kb.updatedAt, mountains: (kb.mountains || []).length, products: (kb.products || []).length, regions: (kb.regions || []).length },
    index: { chunks: chunks.length, buildMs, dim: rstats.dim ?? null, retrieverStats: rstats },
    params: {
      gateK: opts.k,
      threshold: opts.threshold,
      ks: opts.ks,
      depth: opts.depth,
      refuseSignal: opts.refuseSignal,
      refuseThresholds: opts.refuseThresholds,
      refuseThresholdOverride: opts.refuseThreshold,
    },
    counts: metrics.counts,
    styles: metrics.styles,
    metrics: {
      ...metrics.recall,
      mrr: metrics.mrr,
      refusalAccuracy: metrics.primary.accuracy,
      refusalBalancedAccuracy: metrics.primary.balancedAccuracy,
      refusalAccuracyFused: metrics.signals.fused.accuracy,
      citationValidity: citations.skipped ? null : citations.value,
    },
    detail: {
      gate: metrics.gate,
      refusalSignal: opts.refuseSignal,
      refusal: metrics.signals,
      sweep,
      channels,
      citations,
    },
    failures,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    printHuman(result, rows, opts, metrics, citations, true);
  } else {
    printHuman(result, rows, opts, metrics, citations, false);
  }
  return metrics.gate.pass ? 0 : 1;
}

/* ------------------------------------------------------- citationValidity */

/**
 * 答案里的 [n] 是否都能在 citations 里找到。
 * checkCitation 只做两件事：答案至少有一个编号；每个编号都在 citations 的 n 集合里。
 * "答案里一个编号都没有"也算不合法 —— 契约第 7 节要求答案必须带引用。
 */
function checkCitation(answer, citationsList) {
  const ns = new Set((citationsList || []).map((c) => c.n));
  const marks = [...String(answer || '').matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  const orphan = marks.filter((n) => !ns.has(n));
  return { marks, orphan, valid: marks.length > 0 && orphan.length === 0 };
}

async function evalCitations(kb, cases, opts) {
  let answerKnowledge;
  try {
    ({ answerKnowledge } = await import('../server/lib/rag/answer.mjs'));
  } catch (e) {
    return { skipped: true, reason: `answer.mjs 不可用：${e.message}` };
  }
  if (typeof answerKnowledge !== 'function') return { skipped: true, reason: 'answer.mjs 没有导出 answerKnowledge' };

  // LLM 不可用是可预期的（离线机器）。先探一发，失败就整体跳过，不逐条报错。
  let llm;
  try {
    const { createLlm } = await import('../server/lib/llm.mjs');
    llm = createLlm();
    const probes = typeof llm.providers === 'function' ? llm.providers() : [];
    if (Array.isArray(probes) && probes.length && probes.every((p) => p.available === false || p.ok === false)) {
      return { skipped: true, reason: '没有任何可用模型通道（llm.providers() 全部不可用）', providers: probes };
    }
  } catch (e) {
    return { skipped: true, reason: `llm.mjs 不可用：${e.message}` };
  }

  const target = cases.filter((c) => !c.shouldRefuse);
  let valid = 0;
  let refused = 0;
  let degraded = 0;
  let errors = 0;
  const bad = [];
  for (const c of target) {
    try {
      const res = await answerKnowledge(kb, c.question, { k: 6, llm, index: undefined });
      if (res.degraded) {
        degraded++;
        continue;
      }
      if (res.refused) {
        refused++;
        bad.push({ id: c.id, why: '应答题被判为证据不足', top1: res.meta?.top1 });
        continue;
      }
      const r = checkCitation(res.answer, res.citations);
      if (r.valid) valid++;
      else bad.push({ id: c.id, why: r.marks.length ? `孤立引用 [${r.orphan.join('],[')}]` : '答案里没有任何 [n] 引用', answer: String(res.answer).slice(0, 120) });
    } catch (e) {
      errors++;
      if (errors === 1 && /NO_LLM|ECONNREFUSED|ENOTFOUND|fetch failed|超时|timeout/i.test(e.message)) {
        return { skipped: true, reason: `LLM 通道不可用：${e.message}` };
      }
    }
  }
  if (degraded === target.length && target.length) {
    return { skipped: true, reason: '所有请求都降级（模型通道不可用）', degraded };
  }
  const scored = target.length - degraded;
  return {
    skipped: false,
    value: scored ? valid / scored : NaN,
    checked: scored,
    valid,
    refusedOnAnswerable: refused,
    degraded,
    errors,
    bad: bad.slice(0, 20),
  };
}

/* --------------------------------------------------------------- 人读摘要 */

function printHuman(result, rows, opts, metrics, citations, jsonMode) {
  const out = [];
  const L = (s = '') => out.push(s);
  const { counts } = metrics;

  L('');
  L('=== RAG 评测 ===');
  L(`模式        ${result.mode}${opts.offline ? '（不调 LLM，只测检索）' : '（含 citationValidity）'}`);
  L(`golden      ${counts.total} 条（应答题 ${counts.answerable} / 拒答题 ${counts.refuse}）`);
  L(`索引        ${result.index.chunks} 个 passage，buildMs=${result.index.buildMs}，知识库 ${result.kb.mountains} 山头 / ${result.kb.products} 茶品 / ${result.kb.regions} 产区（updatedAt ${result.kb.updatedAt}）`);
  L(`检索深度    top-${opts.depth}`);
  L('');
  for (const k of opts.ks) {
    const v = metrics.recall[`recall@${k}`];
    const gate = k === opts.k ? `   ← 门禁（≥${opts.threshold}）` : '';
    L(`recall@${String(k).padEnd(2)}   ${f3(v)}  (${pct(v)})${gate}`);
  }
  L(`MRR          ${f3(metrics.mrr)}`);
  for (const [st, m] of Object.entries(metrics.styles)) {
    const label = st === 'colloquial' ? '口语化' : '关键词式';
    L(`  ${label.padEnd(5)} ${String(m.cases).padStart(2)} 条  recall@5 ${f3(m[`recall@${opts.k}`] ?? m['recall@5'])}  MRR ${f3(m.mrr)}`);
  }
  const cq = metrics.styles.colloquial?.cases ?? 0;
  L(`  口语化占比 ${pct((cq / counts.answerable) || 0)}（应答题口径；要求 ≥ 30%）`);
  L(`refusalAccuracy  ${f3(metrics.primary.accuracy)}  (${pct(metrics.primary.accuracy)})   主口径信号 = ${opts.refuseSignal} < ${metrics.primary.threshold}`);
  L(`   ├ 拒答题正确拒答 ${pct(metrics.primary.refuseRecall)}（${counts.refuse - metrics.primary.missingRefusal.length}/${counts.refuse}）  应答题未被误拒 ${pct(metrics.primary.answerPrecision)}（${counts.answerable - metrics.primary.falseRefusal.length}/${counts.answerable}）`);
  L(`   └ 平衡准确率 ${f3(metrics.primary.balancedAccuracy)}（两类样本 ${counts.answerable}:${counts.refuse}，总准确率会偏乐观）`);
  L('   三个候选信号对照（阈值均在 golden 集上校准，故附扫描最优作参照）：');
  for (const sig of SIGNALS) {
    const s = metrics.signals[sig];
    L(
      `     ${sig.padEnd(7)} @${String(s.threshold).padEnd(7)} 准确率 ${f3(s.accuracy)}  拒答召回 ${f3(s.refuseRecall)}  应答通过 ${f3(s.answerPrecision)}  平衡 ${f3(s.balancedAccuracy)}` +
        `   | 扫描最优 t=${s.scanBest.threshold} → 准确率 ${f3(s.scanBest.accuracy)} / 平衡 ${f3(s.scanBest.balancedAccuracy)}`
    );
  }
  L(`   ※ fused 是 RRF 量纲（≈0.03），与 answer.mjs 的 RAG_MIN_SCORE=0.35 相差一个数量级；照 0.35 判会把所有问题都拒掉。`);
  L(`citationValidity ${citations.skipped ? `跳过 —— ${citations.reason}` : `${f3(citations.value)}  (${citations.valid}/${citations.checked}，孤立引用 ${citations.bad.length} 条)`}`);
  L('');

  if (metrics.primary.falseRefusal.length) {
    L(`拒答判定误伤（本可回答却被判为证据不足，信号=${opts.refuseSignal}）：${metrics.primary.falseRefusal.join(', ')}`);
  }
  if (metrics.primary.missingRefusal.length) {
    L(`该拒没拒（库外问题仍被当成有证据，信号=${opts.refuseSignal}）：${metrics.primary.missingRefusal.join(', ')}`);
  }
  if (metrics.primary.falseRefusal.length || metrics.primary.missingRefusal.length) L('');

  if (result.detail.sweep) printSweep(result.detail.sweep, L);
  if (result.detail.channels) printChannels(result.detail.channels, L);

  const missed = counts.answerable - Math.round(metrics.recall[`recall@${opts.k}`] * counts.answerable);
  L(`失败用例 ${result.failures.length} / ${counts.total}（应答题错过 ${missed} 条，拒答题漏拒 ${metrics.primary.missingRefusal.length} 条）`);
  for (const f of result.failures) {
    L(`  [${f.id}] ${f.kind}`);
    L(`       问：${f.question}`);
    L(`       期望：${f.expected.join(', ') || '(拒答)'}   类型：${f.expectTypes.join('/') || '-'}`);
    L(`       实际top${f.got.length}：${f.got.map((g) => `${g.id}(${g.score})`).join('  ') || '(无命中)'}`);
  }
  if (!result.failures.length) L('  （无）');

  if (opts.verbose) {
    L('');
    L('--- 逐条 ---');
    for (const r of rows) {
      const rank = r.shouldRefuse ? `refuse? top1score=${r.top1Score} top1vec=${r.top1Vector}` : `rank=${r.rank || '-'}`;
      L(`  ${r.id}  ${rank}  ${r.gotIds.slice(0, 5).join(' > ')}`);
    }
  }

  if (opts.probe) {
    L('');
    L('--- probe ---');
    for (const id of opts.probe) {
      const r = rows.find((x) => x.id === id);
      if (!r) {
        L(`  ${id}: 没在这个 case 集合里`);
        continue;
      }
      L(`  [${r.id}] ${r.question}`);
      for (const [i, g] of r.got.entries()) {
        L(`     ${i + 1}. ${g.id}  score=${g.score} vec=${g.vector} bm25=${g.bm25}  ${g.title}`);
      }
    }
  }

  L('');
  L(`结论：${metrics.gate.metric} = ${f3(metrics.gate.value)} ${metrics.gate.pass ? '≥' : '<'} ${metrics.gate.threshold} → 退出码 ${metrics.gate.pass ? 0 : 1}`);
  L('');

  const text = out.join('\n');
  if (jsonMode) process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

/* ------------------------------------------------------------------ 入口 */

// 只在被当作脚本直接跑时才执行；被 import 时只暴露纯函数，方便单测 checkCitation 这类判定
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`[FATAL] 评测脚本崩了：${err?.stack || err}`);
      process.exitCode = 2;
    });
}

export { checkCitation, refusalAt, scanThresholds, loadGolden, parseArgv, SIGNALS };
