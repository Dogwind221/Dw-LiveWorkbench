/**
 * RAG 冒烟测试 —— 端到端验收工具，不依赖任何测试框架。
 *
 * 分三档，逐档收紧，任何一档失败就停下并打印真实差异：
 *   1. 结构档   建索引、chunk 格式、向量确定性与归一化（不需要模型）
 *   2. 检索档   真实问题能否召回正确条目（不需要模型）
 *   3. 回答档   带引用的回答 + 拒答行为（需要 RAG_SMOKE_LLM=1 才跑，避免冒烟就烧 token）
 *
 * 用法：
 *   node scripts/rag-smoke.mjs              只跑 1、2 档
 *   node scripts/rag-smoke.mjs --llm        三档全跑
 */
import { loadKB } from '../server/lib/kb.mjs';
import { buildChunks } from '../server/lib/rag/chunk.mjs';
import { embed, cosine, DIM } from '../server/lib/rag/embed.mjs';
import { createRetriever } from '../server/lib/rag/retrieve.mjs';
import { buildIndex } from '../server/lib/rag/index.mjs';

const runLlm = process.argv.includes('--llm') || process.env.RAG_SMOKE_LLM === '1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ---------------------------- 1. 结构档 ---------------------------- */
section('[1/3] 结构档（建索引 / chunk 格式 / 向量）');

const kb = loadKB();
check('loadKB() 拿到知识库', !!kb && typeof kb === 'object',
  `顶层的 mountains=${kb?.mountains?.length} products=${kb?.products?.length}`);

const t0 = Date.now();
const chunks = buildChunks(kb);
const buildMs = Date.now() - t0;

check('buildChunks() 产出非空', chunks.length > 0, `chunks=${chunks.length}`);
check('chunk 数量合理（不是把整库塞成一块）', chunks.length >= 50,
  `chunks=${chunks.length}，一个山头应拆成多个字段块`);

const byType = {};
for (const c of chunks) byType[c.type] = (byType[c.type] || 0) + 1;
console.log(`      类型分布: ${JSON.stringify(byType)}`);
check('覆盖 mountain / product 两类', byType.mountain > 0 && byType.product > 0);

const idSet = new Set();
let idDup = 0;
let badShape = 0;
let tooShort = 0;
let tooLong = 0;
for (const c of chunks) {
  if (idSet.has(c.id)) idDup += 1;
  idSet.add(c.id);
  if (!c.id || !c.type || !c.sourceId || !c.title || !c.text || !Array.isArray(c.tags) || !c.meta) badShape += 1;
  if (c.text.length < 20) tooShort += 1;
  if (c.text.length > 1200) tooLong += 1;
}
check('chunk id 唯一', idDup === 0, `重复 ${idDup} 个`);
check('chunk 字段齐全', badShape === 0, `缺字段 ${badShape} 个`);
check('没有过短的碎块（<20字）', tooShort === 0, `${tooShort} 个过短`);
check('没有过长的巨块（>1200字）', tooLong === 0, `${tooLong} 个过长`);

// text 必须自带字段名，否则模型无法引用
const labelled = chunks.filter((c) => /[:：]/.test(c.text)).length;
check('chunk 正文带字段名（便于引用）', labelled / chunks.length > 0.8,
  `带字段名的占 ${(labelled / chunks.length * 100).toFixed(1)}%`);

// 顺序可复现
const again = buildChunks(kb);
check('buildChunks() 输出顺序可复现',
  again.length === chunks.length && again.every((c, i) => c.id === chunks[i].id));

// 向量
const v1 = embed('老班章的茶气很足');
const v2 = embed('老班章的茶气很足');
check('embed() 确定性（同文本两次一致）',
  v1.length === v2.length && v1.every((x, i) => x === v2[i]));
check('embed() 维度正确', v1.length === DIM, `实际 ${v1.length}，期望 ${DIM}`);

let norm = 0;
for (const x of v1) norm += x * x;
check('embed() 输出 L2 归一化', Math.abs(Math.sqrt(norm) - 1) < 1e-5,
  `范数=${Math.sqrt(norm).toFixed(6)}`);

const vDiff = embed('老班章的茶气很足');
const vOther = embed('今天天气不错适合出门散步');
const simClose = cosine(vDiff, embed('老班章茶气挺足'));
const simFar = cosine(vDiff, vOther);
check('语义相近的文本相似度高于无关文本', simClose > simFar,
  `相近=${simClose.toFixed(4)} 无关=${simFar.toFixed(4)}`);

/* ---------------------------- 2. 检索档 ---------------------------- */
section('[2/3] 检索档（真实问题的召回）');

let retriever = null;
try {
  retriever = createRetriever(chunks);
} catch (err) {
  check('createRetriever() 可构建', false, err.message);
}
check('createRetriever() 可构建', !!retriever);

if (retriever) {
  const st = retriever.stats?.() || {};
  console.log(`      索引: ${JSON.stringify(st)}`);

  // 每个问题：期望命中的关键词必须出现在 top3 里。
  //
  // 注意这一档的定位：它只是**烟雾报警器**，不是质量门禁。
  // 这里用"top3 文本里出现某关键词"判定，存在假阳性 ——
  // 例如问"倚邦和布朗山的差别"，一个老班章的块因为写了"跟布朗山的浓强对比"也能过关。
  // 真正的质量问题（多实体覆盖、排序、拒答边界）由 rag-eval 的 recall/MRR/entityCoverage 负责。
  const probes = [
    { q: '倚邦和布朗山的口感有什么差别', want: /倚邦|布朗/, label: '产区对比' },
    { q: '中期茶怎么辨别年份', want: /中期茶|年份/, label: '产品知识' },
    { q: '老班章古树大概多少钱一公斤', want: /老班章|价格|元/, label: '价格数值' },
    { q: '为什么倚邦的汤水比较细', want: /倚邦/, label: '因果类' },
    { q: '直播间能不能说降三高', want: /三高|功效|医疗|违禁/, label: '合规类' },
    { q: '冲泡水温多少合适', want: /水温|冲泡|℃/, label: '参数类' },
  ];

  for (const p of probes) {
    const hits = retriever.search(p.q, 3);
    const blob = hits.map((h) => `${h.chunk.title} ${h.chunk.text}`).join(' ');
    const hit = hits.length > 0 && p.want.test(blob);
    const top3 = hits.map((h) => `${h.chunk.id}(${h.score.toFixed(3)})`).join(', ');
    check(`召回·${p.label}：${p.q}`, hit, hit ? '' : `top3=${top3}`);
  }

  // 单通道也要能用（评测和调参依赖它们）
  const bm = retriever.searchBM25('倚邦 甜柔', 3);
  const vc = retriever.searchVector('倚邦 甜柔', 3);
  check('BM25 单通道可独立调用', bm.length > 0, `返回 ${bm.length} 条`);
  check('向量单通道可独立调用', vc.length > 0, `返回 ${vc.length} 条`);
  check('融合结果带通道明细', !!(retriever.search('倚邦', 3)[0]?.scores?.rrf !== undefined),
    `scores=${JSON.stringify(retriever.search('倚邦', 3)[0]?.scores)}`);

  // 稳定排序：同分不随机
  const a1 = retriever.search('倚邦', 5).map((h) => h.chunk.id).join(',');
  const a2 = retriever.search('倚邦', 5).map((h) => h.chunk.id).join(',');
  check('检索结果可复现', a1 === a2);

  // 库里绝对没有的东西，top1 分数应该明显偏低
  const nonsense = retriever.search('武夷岩茶正岩肉桂的岩韵特征', 1);
  const onTopic = retriever.search('倚邦的山场特征', 1);
  check('无关问题的 top1 分数低于相关问题的 top1',
    (nonsense[0]?.score ?? 0) < (onTopic[0]?.score ?? 0),
    `无关=${(nonsense[0]?.score ?? 0).toFixed(4)} 相关=${(onTopic[0]?.score ?? 0).toFixed(4)}`);
}

// buildIndex 也要能用（HTTP 路由走的是它）
try {
  const idx = buildIndex(kb);
  check('buildIndex() 返回可用索引', !!idx?.retriever && Array.isArray(idx.chunks));
  check('buildIndex() 带签名（供单例判断重建）', typeof idx?.signature === 'string' && idx.signature.length > 0,
    `signature=${idx?.signature}`);
} catch (err) {
  check('buildIndex() 返回可用索引', false, err.message);
}

/* ---------------------------- 3. 回答档 ---------------------------- */
section(`[3/3] 回答档（带引用 / 拒答）${runLlm ? '' : '  —— 跳过，加 --llm 才跑'}`);

if (runLlm) {
  let answerKnowledge;
  try {
    ({ answerKnowledge } = await import('../server/lib/rag/answer.mjs'));
  } catch (err) {
    check('answer.mjs 可加载', false, err.message);
  }

  if (answerKnowledge) {
    // 该答的：要么正常带引用回答，要么明确拒答 —— 两种都是合法结果，
    // 但**不能**出现"有答案没出处"。检索本身的质量由 [2/3] 档和 rag-eval 负责，
    // 这里只把关"引用不能造假"。
    const good = await answerKnowledge(kb, '倚邦的山场特征是什么样的');
    console.log(`      答: ${good.answer.slice(0, 120)}${good.answer.length > 120 ? '…' : ''}`);
    console.log(`      引用: ${good.citations.map((c) => `[${c.n}]${c.title}`).join(' ') || '（无）'}`);
    check('回答非空（拒答也要有人话，不能是空串）', good.answer.length > 0);
    if (good.refused) {
      console.log(`      （这条检索没取到足够证据，走了拒答：${good.reason}）`);
      check('拒答时不带任何 citations', good.citations.length === 0);
    } else {
      check('回答带 [n] 引用标记', /\[\d+\]/.test(good.answer));
      check('每个引用编号都能在 citations 里找到', good.citations.length > 0,
        `citations=${good.citations.length}`);
      const nums = [...good.answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
      const orphan = nums.filter((n) => !good.citations.some((c) => c.n === n));
      check('没有无出处的悬空引用编号', orphan.length === 0, `悬空编号 ${orphan.join(',')}`);
    }

    // 该拒的：库里没有的内容。
    // 注意这里的判定放宽到"拒答 或 明确标注资料不完整"—— 实测发现很多库外问题
    // 仍能检索到领域相关但答非所问的内容（见 README-rag.md），
    // 硬要求 100% 拒答等于逼模型要么撒谎要么装死。第三种诚实的结果是允许的。
    const bad = await answerKnowledge(kb, '武夷岩茶正岩肉桂的岩韵怎么形成的');
    console.log(`      库外问题: refused=${bad.refused} partial=${!!bad.partial} reason=${bad.reason || '-'}`);
    check('库里没有的内容不硬答（拒答或明确标注不完整）', bad.refused || bad.partial,
      `answer=${bad.answer.slice(0, 80)}`);

    // 部分相关的问题：应当给出"答一半 + 说清边界"而不是硬编
    const part = await answerKnowledge(kb, '普洱茶的咖啡因含量大概多少，晚上喝了会不会睡不着');
    console.log(`      部分相关: refused=${part.refused} partial=${!!part.partial}`);
    console.log(`      答: ${part.answer.slice(0, 100)}`);
    check('部分相关的问题不会给出无出处的断言', part.refused || part.partial || part.citations.length > 0,
      `citations=${part.citations.length}`);

    // 前置拒答（完全不调模型）：把两个通道的阈值都抬到不可能达到的高度
    const forced = await answerKnowledge(kb, '倚邦的山场特征', { minBm25: 1e9, minVector: 1e9 });
    check('证据不足时前置拒答（不调模型）', forced.refused && forced.meta?.stage === 'pre-llm',
      `stage=${forced.meta?.stage}`);
  }
} else {
  console.log('      （跳过。要跑完整链路：node scripts/rag-smoke.mjs --llm）');
}

/* ---------------------------- 汇总 ---------------------------- */
console.log(`\n${'─'.repeat(56)}`);
console.log(`冒烟结果：通过 ${pass} / 失败 ${fail}   （索引构建 ${buildMs}ms，chunks=${chunks.length}）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
