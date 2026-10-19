/**
 * 模块 4：弹幕问答。
 *
 * 输入一句弹幕/问题，输出「可以直接念的回答」草稿，并标注依据与合规风险。
 * 全部走知识库 + 规则匹配，不依赖外部模型，断网也能用。
 */
import { loadKB, findMountain, findProducts, searchKB } from './kb.mjs';
import { checkText, loadCompliance } from './compliance.mjs';
import { readJson } from './store.mjs';

const INTENTS = [
  {
    id: 'efficacy',
    name: '功效类（高风险）',
    level: 'high',
    test: /降|治|调理|养生|排毒|减肥|瘦身|抗癌|防癌|三高|血压|血糖|血脂|失眠|胃病|提高免疫|抗衰|保健/,
    advice: '食品不得宣称功效。回答时只谈口感、工艺、原料与饮用体验，不接功效话头。',
  },
  {
    id: 'price',
    name: '价格与优惠',
    test: /多少钱|价格|贵|便宜|优惠|折扣|活动|几折|划算|包邮|运费|赠品|送什么/,
  },
  {
    id: 'brew',
    name: '冲泡方法',
    test: /怎么泡|怎么喝|水温|多少度|投茶|出汤|闷|煮|盖碗|紫砂|飘逸杯|放多少|几克|能泡几泡|耐泡/,
  },
  {
    id: 'storage',
    name: '存储与转化',
    test: /怎么存|保存|存放|受潮|发霉|冰箱|转化|陈化|放几年|能存多久|湿度/,
  },
  { id: 'authenticity', name: '真伪与鉴别', test: /真假|怎么辨|是不是|正宗|纯料|古树|树龄|拼配|冒充|做旧/ },
  { id: 'taste', name: '口感与风味', test: /苦|涩|甜|回甘|生津|香|汤色|口感|好喝|喉韵|茶气|耐泡/ },
  { id: 'origin', name: '山头与产地', test: /哪个山|产区|产地|海拔|山场|云南|临沧|勐海|易武|景迈/ },
  { id: 'vintage', name: '年份与季节', test: /哪年|年份|几年|春茶|秋茶|新茶|老茶|头春/ },
  { id: 'audience', name: '适合人群', test: /适合|孕妇|小孩|老人|能喝吗|空腹|睡前|胃不好/ },
  { id: 'gift', name: '送礼相关', test: /送礼|送人|礼盒|包装|体面|商务/ },
  { id: 'logistics', name: '发货与售后', test: /发货|什么时候发|快递|多久到|退货|退款|售后|坏了/ },
  { id: 'type', name: '生熟与品类', test: /生普|熟普|生茶|熟茶|区别|哪个好|红茶|白茶/ },
];

const CATEGORY_ANSWERS = {
  price: () =>
    '价格我直接把数念给你，不做那种先涨后降的动作。直播间这个价只在这场有效，结束恢复日常价。你要是想先试试，也可以先拿一饼，喝着合适再来。',
  brew: (m) =>
    m?.brewTips
      ? `冲泡参数是${m.brewTips}。第一泡快出汤醒茶不喝，前三泡别闷，后面每泡加几秒，味道是往上走的。`
      : '水温95-100℃，投茶7-8克，第一泡快出汤醒茶不喝，前三泡5秒左右出汤，之后每泡加5秒。太浓就减投茶量，别靠缩短时间硬压。',
  storage: () => '避光、通风、无异味、湿度别太高，放纸箱里就行。别放冰箱，别和有味道的东西放一起，这两条记住就够。',
  authenticity: (m) =>
    m?.pitfalls?.length
      ? `看叶底和汤色最实在。${m.pitfalls[0]}。你问店家原料批次，答不上来的就要多留个心。`
      : '看叶底、看汤色，再问原料批次和年份。愿意让你看叶底、给得出报告的，基本可以放心一半。',
  taste: (m) =>
    m
      ? `${(m.taste || []).join('、') || '汤感顺滑'}，香气上主要是${(m.aroma || []).join('、') || '清雅花香'}。苦能化得开才是关键，停在舌头上不下去的就要注意。`
      : '苦能化开、化开之后有回甜，这是判断的标准。只看「苦不苦」容易买错。',
  origin: (m) =>
    m
      ? `这款原料来自${[m.region, m.area].filter(Boolean).join(' · ')}${m.altitude ? '，海拔' + m.altitude : ''}。山场最后都会落到汤感和香气上。`
      : '产地信息我这边是可以对得上批次的，具体我念一下手上的原料信息卡。',
  vintage: (m) => `${m?.treeAge ? `树龄方面是${m.treeAge}。` : ''}年份不是越老越好，前提是当年工艺过关、仓储干净，否则放久了也只是变旧。`,
  audience: () =>
    '没有绝对不能喝的说法，但空腹和睡前我不建议喝浓的。孕妇、小孩这类特殊人群，请按医生建议来，这个我不能替你判断。',
  gift: () => '送礼可以配礼盒，不加价，但要单独打包，发货会晚一天。建议附一张原料信息卡，收礼的人才有感觉。',
  logistics: () => '默认顺丰或京东，下单后当天或次日发出，偏远地区以物流信息为准。运输破损拍照片给我，直接补发。',
  type: () =>
    '生普靠时间转化，熟普靠工艺发酵。生普新茶偏鲜爽，放几年往陈香走；熟普出厂就温和，适合马上喝。两个方向不同，没有高下。',
  efficacy: () => '这个我不能这么讲。茶是食品，不是药，功效类的说法我不能说，说了是违规的。我只能告诉你它的原料、工艺和喝起来的感受。',
};

export function classifyIntent(question) {
  const q = String(question || '');
  const hit = INTENTS.find((i) => i.test.test(q));
  return hit || { id: 'other', name: '其他', level: 'low' };
}

function matchKnowledge(question) {
  const kb = loadKB();
  const mountain = findMountain(kb, question);
  const products = findProducts(kb, [question]).slice(0, 3);
  const search = searchKB(kb, question);
  return { kb, mountain, products, search };
}

/** 从问答库（data/faq.json）里找相似问题。 */
function matchFaqStore(question) {
  const store = readJson('faq.json', []) || [];
  const q = String(question || '').replace(/[？?！!。，,\s]/g, '');
  if (!q) return null;
  let best = null;
  for (const f of store) {
    if (f.enabled === false) continue;
    const k = String(f.q || '').replace(/[？?！!。，,\s]/g, '');
    if (!k) continue;
    if (k === q) return f;
    // 粗略相似度：公共字符占比
    const common = [...new Set(k)].filter((c) => q.includes(c)).length;
    const score = common / Math.max(k.length, 1);
    if (score > 0.7 && (!best || score > best.score)) best = { ...f, score };
  }
  return best;
}

/**
 * 生成可直接念的回答草稿。
 * @returns {{intent, answer, basis, followUps, risk, blocked}}
 */
export function answerQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return { intent: null, answer: '', basis: [], followUps: [], risk: null, blocked: false, warning: '问题为空' };

  const intent = classifyIntent(q);
  const { mountain, products, search } = matchKnowledge(q);
  const faqHit = matchFaqStore(q);

  let answer = '';
  const basis = [];

  if (faqHit) {
    answer = faqHit.a;
    basis.push({ type: 'faq', text: `问答库：${faqHit.q}` });
  } else if (CATEGORY_ANSWERS[intent.id]) {
    answer = CATEGORY_ANSWERS[intent.id](mountain);
    if (mountain && ['taste', 'brew', 'origin', 'storage', 'authenticity', 'vintage'].includes(intent.id)) {
      basis.push({ type: 'mountain', text: `知识库山头：${mountain.name}` });
    }
  } else if (mountain) {
    answer = `这款是${mountain.name}${mountain.area ? '（' + mountain.area + '）' : ''}，喝起来${(mountain.taste || []).join('、') || '汤感顺滑'}。想细问哪一部分，我再展开。`;
    basis.push({ type: 'mountain', text: `知识库山头：${mountain.name}` });
  } else if (products.length) {
    answer = `${products[0].summary || products[0].name}。${(products[0].points || [])[0] || ''}`.trim();
    basis.push({ type: 'product', text: `知识库茶品：${products[0].name}` });
  } else {
    const related = search.mountains[0] || search.products[0];
    answer = related
      ? `你问的应该是「${related.name}」。${related.summary || related.terroir || (related.taste || []).join('、') || ''}`
      : '这个问题我先记下来，讲完这段我专门回一下。你也可以再说具体一点，比如是问冲泡还是问原料。';
    if (related) basis.push({ type: 'search', text: `模糊命中：${related.name}` });
  }

  // 合规自检
  const compliance = loadCompliance();
  const risk = checkText(answer, { compliance });
  const qRisk = checkText(q, { compliance });

  const followUps = [];
  if (intent.id === 'price') followUps.push('要不要我把每泡成本算一下？');
  if (intent.id === 'brew') followUps.push('你现在用什么器具？我可以按你的器具给参数。');
  if (intent.id === 'efficacy') followUps.push('（不要顺着功效话题延伸，转回口感与工艺）');

  const blocked = intent.level === 'high' || risk.counts.high > 0;
  return {
    intent,
    question: q,
    answer: risk.counts.high > 0 ? risk.cleaned : answer,
    basis,
    followUps,
    risk: {
      level: risk.level,
      counts: risk.counts,
      hits: risk.hits.slice(0, 8).map((h) => ({ word: h.word, suggest: h.suggest, category: h.category })),
      questionHits: qRisk.hits.slice(0, 5).map((h) => ({ word: h.word, category: h.category })),
    },
    blocked,
    warning: blocked ? '这条问题涉及高风险表达，回答已按合规建议改写，请勿延伸功效话题。' : '',
  };
}

/** 批量处理一堆弹幕，按风险与意图分组，便于直播中快速筛选。 */
export function answerBatch(questions) {
  const out = (questions || []).slice(0, 100).map((q) => {
    try {
      return answerQuestion(q);
    } catch (err) {
      return { question: q, answer: `（生成失败：${err.message}）`, intent: null, risk: null };
    }
  });
  const grouped = {};
  for (const item of out) {
    const key = item.intent?.name || '其他';
    grouped[key] = (grouped[key] || 0) + 1;
  }
  return { items: out, grouped };
}

export function listIntents() {
  return INTENTS.map((i) => ({ id: i.id, name: i.name, level: i.level || 'low', advice: i.advice || '' }));
}
