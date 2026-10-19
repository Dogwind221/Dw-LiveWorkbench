/**
 * 零词表重叠探针 —— 专门用来暴露检索器的短板。
 *
 * ## 为什么需要它
 *
 * 正式评测集（`data/eval/kb-golden.json`）的 recall@5 = 0.974，看着很好。
 * 但那份题集里的"口语化"其实是**自然句式 + 复用术语**：
 * 比如"我在直播间能不能说这是今年最好的老班章" —— 里面就有"老班章""直播间"。
 * 字符 n-gram 当然能命中，因为**它们和知识库共用同一批字**。
 *
 * 真正考语义的是**零词表重叠**：用户说的话里，一个知识库术语都不出现。
 * 比如"想送领导，包装要体面一点的" —— 该命中"送礼场景"，
 * 但库里没有这几个字，只能靠语义理解。
 *
 * 而本项目用的是字符 n-gram + BM25，**没有真正的语义能力**。
 * 所以这个探针测的不是"能不能用"，而是**能力边界在哪**。
 *
 * ## 判定方式
 *
 * 人工给每条查询标"期望信号词"（命中块里应该出现的字）。
 * top-3 里只要有一块的文本含期望词，就算命中。
 * 这是个粗判定，但它能清楚地区分"语义对了"和"字面撞上了"。
 *
 * 用法：
 *   node scripts/rag-probe.mjs
 *   node scripts/rag-probe.mjs --k 5      # 改看 top-k
 */
import { loadKB } from '../server/lib/kb.mjs';
import { searchKnowledge } from '../server/lib/rag/search.mjs';

const argv = process.argv.slice(2);
const kIdx = argv.indexOf('--k');
const K = kIdx >= 0 ? Number(argv[kIdx + 1]) || 5 : 5;
const TOP = 3; // 用 top-3 判定，比 recall@5 严格

/**
 * 每条：query（**不说任何知识库术语**）、期望信号词、意图说明。
 * 刻意选真实顾客会说的话，不是技术人员的说法。
 */
const CASES = [
  {
    q: '喝起来甜丝丝、汤水很滑的那种茶',
    want: ['甜', '汤水', '柔', '滑'],
    intent: '按口感描述找茶（不点名山头）',
  },
  {
    q: '想送领导，包装要体面一点的',
    want: ['送礼', '礼盒', '商务', '伴手礼'],
    intent: '送礼场景选品',
  },
  {
    q: '这茶喝了能减肥吗',
    want: ['医疗', '保健', '功效', '减肥'],
    intent: '功效宣称（应该给合规红线）',
  },
  {
    q: '为什么我泡出来又苦又涩',
    want: ['冲泡', '水温', '出汤', '苦涩', '手法'],
    intent: '冲泡手法排错',
  },
  {
    q: '有没有便宜点、天天喝不心疼的',
    want: ['口粮', '性价比', '入门', '价格'],
    intent: '口粮茶 / 低价段',
  },
  {
    q: '晚上喝会不会睡不着',
    want: ['咖啡因', '失眠', '晚上', '睡前'],
    intent: '饮用场景 / 咖啡因',
  },
  {
    q: '怀孕了还能喝吗',
    want: ['孕妇', '怀孕', '体质', '不宜'],
    intent: '人群禁忌（应该谨慎/拒答）',
  },
  {
    q: '家里没地方放，怎么存比较好',
    want: ['存储', '仓储', '存放', '避光', '防潮'],
    intent: '仓储建议',
  },
];

const kb = loadKB();
console.log('');
console.log('=== 零词表重叠探针（这些问句里不含任何知识库术语）===');
console.log(`判定：top-${TOP} 内是否出现期望信号词\n`);

let hit = 0;
const failures = [];

for (const c of CASES) {
  const r = searchKnowledge(kb, c.q, { k: K });
  const hits = (r.hits || []).slice(0, K);
  const top = hits.slice(0, TOP);

  // 判定：top-3 里是否有块的文本含任一期望信号词
  const matched = [];
  let ok = false;
  top.forEach((h, i) => {
    const text = `${h.text || ''} ${h.title || ''} ${h.field || ''}`;
    const found = c.want.filter((w) => text.includes(w));
    if (found.length) { ok = true; matched.push({ rank: i + 1, id: h.id, found }); }
  });

  if (ok) hit++;
  else failures.push({ q: c.q, top: top.map((h) => h.id) });

  const flag = ok ? '✓' : '✗';
  console.log(`${flag} 问：${c.q}`);
  console.log(`   意图：${c.intent}`);
  if (ok) {
    console.log(`   命中：第 ${matched.map((m) => m.rank).join('/')} 名（信号词 ${matched[0].found.join('、')}）`);
  } else {
    console.log(`   ✗ 跑偏。实际 top${TOP}：`);
    top.forEach((h, i) => {
      const t = String(h.text || h.title || '').replace(/\s+/g, ' ').slice(0, 46);
      console.log(`      ${i + 1}. [${h.id}] ${t}`);
    });
  }
  console.log('');
}

const rate = hit / CASES.length;
console.log('─'.repeat(56));
console.log(`零重叠命中率：${hit} / ${CASES.length} = ${(rate * 100).toFixed(0)}%（判定口径 top-${TOP}）`);
console.log('');
console.log('怎么读这个数字：');
console.log('  · 和正式评测集的 recall@5 = 0.974 对比 —— 差距就是"语义泛化"的缺口。');
console.log('  · 探针通过率高≠没问题：命中的也可能只是"字面撞上了几个字"。');
console.log('  · 想补这个缺口，只有一条路：真·语义嵌入（dense embedding）。');
console.log('    公开数据显示中文纯词法检索 Recall@100 只有 0.560，而 dense 是 0.944。');
console.log('');
if (failures.length) {
  console.log('失败清单（这些是最值得改进的方向）：');
  for (const f of failures) console.log(`  · ${f.q}  →  拿到 ${f.top[0] || '(空)'} 等`);
  console.log('');
}
process.exitCode = 0; // 这是探针，不是门禁：跑完知道边界就行，不该让 CI 红
