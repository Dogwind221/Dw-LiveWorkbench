/**
 * 直播内容块库 —— 模块 3 的核心资产。
 *
 * 每个块 = 一个「直播段落」，同时产出两样东西：
 *   1) slides：给 PPT 用的结构化视觉内容
 *   2) scriptClusters：给提词器用的口播稿段落簇（按分配到的时长自动裁剪）
 *
 * 内容全部来自知识库字段 + 直播运营模板，不依赖外部大模型，离线可跑。
 * 写作口径：不出现绝对化用语 / 功效宣称 / 投资暗示，保证生成稿本身合规。
 */
import { pick, pickN, fill, tidy, yuan } from './copy.mjs';

const L = (text, cue = '') => ({ text: tidy(text), cue });
const S = (o) => ({
  weight: 1,
  bullets: [],
  cards: [],
  scriptClusters: [],
  ...o,
});

function parseGram(spec) {
  const m = String(spec || '').match(/(\d+(?:\.\d+)?)\s*(g|克|kg|公斤)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /kg|公斤/i.test(m[2]) ? n * 1000 : n;
}

/**
 * 这个字段到底有没有「真内容」。
 *
 * 除了空值，还要挡掉**占位提示**：模板里写的是「（器皿 / 水温 / 投茶比 —— 先定死这个）」，
 * 那是给人看的填写提示，不是内容。如果把它当正文渲染出来，
 * 直播间 PPT 上会出现一整页带括号的说明文字 —— 比空白更难看。
 */
function hasContent(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  // 整段被（）或()包住 = 还没填
  if (/^[（(][\s\S]*[）)]$/.test(s)) return false;
  if (/^[（(]待填[）)]$/.test(s)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 01 封面
 * ------------------------------------------------------------------ */
const cover = {
  id: 'cover',
  title: '封面',
  goal: '立住主题，观众一眼知道今晚卖什么、讲什么',
  weight: 0.6,
  minMinutes: 0,
  build(ctx) {
    const { meta, product, mountain } = ctx;
    const who = mountain?.name || product.mountainName || product.name || meta.topic;
    const sub = [product.type, product.year, product.spec].filter(Boolean).join(' · ');
    return [
      S({
        type: 'cover',
        kicker: meta.purposeLabel,
        title: meta.title,
        subtitle: `${who}${sub ? ' · ' + sub : ''}`,
        meta: [`主讲：${meta.host}`, meta.date],
        scriptClusters: [
          [
            L(`欢迎新进来的朋友，我是${meta.host}。`),
            L(`今晚这场，我们只聊一件事——${who}。`, '停顿，看镜头'),
            L(
              `${meta.audienceLabel}都能听，前面讲清楚它为什么是这个味，后半段给你实实在在的价格。`,
              '语气放平，别急'
            ),
            L(`不想听广告的，前面这段知识也够你以后买茶用得上。`),
          ],
          [
            L(`先说一下今晚的节奏：${meta.durationMin}分钟，中间不留广告，讲到哪儿是哪儿。`),
            L(`有问题随时打在评论区，我会挑着回答。`),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 02 留住观众（页面靠标题本身表达，不印「开场」这类标签）
 * ------------------------------------------------------------------ */
const hook = {
  id: 'hook',
  title: '留住观众',
  goal: '90 秒内把人留住',
  weight: 2,
  minMinutes: 0,
  build(ctx) {
    const { r, meta, product, mountain } = ctx;
    const who = mountain?.name || product.mountainName || product.name || meta.topic;
    const taste = (mountain?.taste || [])[0] || '汤感干净';
    const price = product.price ? `${yuan(product.price)}` : '';
    // 知识科普这类场次不报单款价（观众问价就答山头的参考区间）——
    // 开场页原来会念「今晚这饼我按 2,680 给」，和「弱化推销」的知识场直接矛盾。
    const selling = (PURPOSE_FLOW[meta.purpose] || []).includes('price');
    const cards = [
      {
        title: '悬念',
        desc: pick(r, [
          `同样叫${who}，价格能差十倍，差在哪？今晚把差别摊开给你看。`,
          `市面上十饼${who}，可能只有一饼是那种味道——剩下的差在哪，我讲给你听。`,
          `${who}为什么会被炒到那个价？先别急着信，我们先说清楚它凭什么。`,
        ]),
      },
      {
        title: '利益',
        desc: selling
          ? price
            ? pick(r, [
                `今晚这批是${price}的价格，我会告诉你它为什么值这个数，也告诉你什么价以下要小心。`,
                `不讲虚的，今晚这饼我按${price}给，多一分我都不加。`,
              ])
            : pick(r, [
                `今晚讲完，你去别处买${who}至少不会被糊弄。`,
                `看完这场，你自己就能判断一饼${who}值不值得买。`,
              ])
          : pick(r, [
              `今晚不讲价格玄学，只讲${who}为什么是${taste}这个味。`,
              `听完你自己就能判断：一饼${who}该是什么味，什么价以上是在收智商税。`,
            ]),
      },
      {
        title: '共鸣',
        desc: pick(r, [
          `很多茶友花了大价钱，买回来的茶却越喝越空——今天说清楚怎么避开。`,
          `喝茶这件事，钱花在原料上，别花在包装和故事上。`,
        ]),
      },
    ];
    return [
      S({
        type: 'hook',
        // 空串 = 这页不要小标签：标题本身够表达，页面上多一个「开场」反而啰嗦
        kicker: '',
        title: pick(r, [
          `今晚只讲一件事：${who}`,
          `${who}，到底好在哪儿`,
          `花五分钟，把${who}喝明白`,
        ]),
        subtitle: `口味关键词：${taste}`,
        cards,
        scriptClusters: [
          [
            L(`${who}，我先把结论放这儿：${taste}。`, '重音落在口味词上'),
            L(taste ? `但这句话谁都会说，所以我今晚要拆开讲，它是怎么来的。` : ''),
            L('先问你一个问题——你上一次买茶，是听人推荐，还是自己喝出来的？', '停顿 2 秒'),
          ],
          [
            L('评论区已经有人打字了，我看到了。'),
            L('今晚不整虚的，就三件事：它是什么、怎么喝、什么价。'),
            L('看完你自己就能判断。', '收一下语气'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 04 主播背书
 * ------------------------------------------------------------------ */
const credibility = {
  id: 'credibility',
  title: '讲清楚凭什么听我讲',
  goal: '建立信任，降低下单心理门槛',
  weight: 1.2,
  minMinutes: 40,
  purposes: ['newlaunch', 'knowledge', 'mixed', 'thanks'],
  build(ctx) {
    const { r, meta, kbrole } = ctx;
    return [
      S({
        type: 'points',
        kicker: '关于我',
        title: '为什么由我来讲这件事',
        bullets: [
          kbrole.years || '做普洱茶虽说没有多年，但基本也懂得七七八八',
          // 注意：原来写的是「每年春秋两季进山」，但只做春茶，
          // 两处放一起会自相矛盾（客户会当场问），所以这里统一成只讲春茶。
          kbrole.visits || '每年进山，从茶农手上拿料（但只做春茶）',
          kbrole.standard || '选品标准：原料清楚、工艺不糊弄、仓储干净',
          '不卖没喝过的茶，不带没去过山头的货',
          kbrole.regions || '主做版纳和普洱厂区，有更清晰的认知',
        ],
        footnote: '有任何疑问，评论区随时打断我',
        scriptClusters: [
          [
            L(`我叫${meta.host}，做普洱茶虽说没有多年，但基本也懂得七七八八。`),
            L('我只做春茶 —— 春茶的底子清楚，秋茶我不碰。'),
            L('料是每年进山从茶农手上直接拿的，不是坐在办公室里挑的。'),
          ],
          [
            L('我主要做版纳和普洱厂区，这两片的茶我心里有更清晰的认知。'),
            L('我的标准就三条：原料说得清、工艺不糊弄、仓储没毛病。'),
            L('三条里有任何一条不对，这茶就不在我这儿出现。'),
          ],
          [
            L('所以今晚你听到的不是网上抄来的资料，是我自己喝出来的判断。'),
            pick(r, [
              L('所以你今天听完，哪怕不买，也算没白来。'),
              L('觉得我讲得实在，点个关注就行，不用下单。'),
            ]),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 05 山头档案
 * ------------------------------------------------------------------ */
const mountainProfile = {
  id: 'mountain-profile',
  title: '山头档案',
  goal: '讲清楚这款茶的地理身份',
  weight: 2.4,
  minMinutes: 0,
  requires: 'mountain',
  build(ctx) {
    const { r, meta, product, mountain } = ctx;
    if (!mountain) return mountainGeneric(ctx);
    const rows = [
      ['产区', [mountain.region, mountain.area].filter(Boolean).join(' · ')],
      ['海拔', mountain.altitude || '—'],
      ['树种', [mountain.treeType, mountain.treeAge].filter(Boolean).join(' / ') || '—'],
      ['土壤', mountain.soil || '—'],
      ['风格', (mountain.taste || []).join('、') || '—'],
    ];
    // 知识科普这类**没有独立价格页**的场次，改在这里给「山头参考价位 + 等级」——
    // 观众问「这山头什么价」时有个基于知识库的答案，而不是报某一款产品的价。
    // 有价格页的场次（新品首发等）不重复显示，避免两个价格打架。
    const flow = PURPOSE_FLOW[meta.purpose] || [];
    const showRefPrice = !flow.includes('price');
    if (showRefPrice) {
      if (mountain.grade) rows.push(['等级', mountain.grade]);
      if (mountain.priceRange) rows.push(['参考价位', mountain.priceRange]);
    }
    const finalRows = rows.filter((r2) => r2[1] && r2[1] !== '—');
    const out = [
      S({
        type: 'table',
        kicker: '山头档案',
        title: `${mountain.name} · 基本信息`,
        table: { headers: ['项目', '内容'], rows: finalRows },
        footnote: mountain.alias?.length ? `也叫：${mountain.alias.join('、')}` : '',
        scriptClusters: [
          [
            L(`${mountain.name}在${mountain.region || ''}${mountain.area ? '的' + mountain.area : ''}。`),
            mountain.altitude ? L(`海拔大概${mountain.altitude}。`) : '',
            mountain.treeType ? L(`树种是${mountain.treeType}${mountain.treeAge ? '，' + mountain.treeAge : ''}。`) : '',
            mountain.soil ? L(`土壤是${mountain.soil}，这一点后面讲风味的时候会用上。`) : '',
          ],
          [
            L(`所以它的风格可以概括成：${(mountain.taste || []).join('、') || '汤感干净'}。`),
            mountain.aroma?.length ? L(`香气上主要是${mountain.aroma.join('、')}。`) : '',
            showRefPrice && mountain.priceRange
              ? L(
                  `价位上，${mountain.grade ? mountain.grade + '的地位，' : ''}${mountain.priceRange}。` +
                    '这是区间不是定价，具体看年份和树龄等级 —— 你别拿这个区间的下限去对标别人报的低价。'
                )
              : '',
            L('这些词听着抽象，下一段我一个个拆给你。'),
          ],
        ],
      }),
    ];

    /* §2 的另一半：气候与生态。
       和「地理身份」分两页，是因为这页回答的是「为什么是这个味」的上游原因，
       和坐标、树龄那种身份信息不是一回事。没填就整页不出。 */
    const ecoRows = [
      ['气候', mountain.climate],
      ['日照', mountain.sunlight],
      ['降水', mountain.rainfall],
      ['生态', mountain.ecology],
      ['伴生植物', (mountain.companionPlants || []).join('、')],
    ].filter(([, v]) => hasContent(v));
    if (ecoRows.length >= 2) {
      out.push(
        S({
          type: 'table',
          kicker: '气候与生态',
          title: `${mountain.name} · 为什么长成这样`,
          table: { headers: ['项目', '内容'], rows: ecoRows },
          footnote: '这些条件叠在一起，才有后面那个味道',
          scriptClusters: [
            ecoRows.slice(0, 3).map(([k, v]) => L(`${k}上，${v}。`)),
            [
              ecoRows.length > 3 ? L(`${ecoRows[3][0]}：${ecoRows[3][1]}。`) : '',
              ecoRows.length > 4 ? L(`${ecoRows[4][0]}：${ecoRows[4][1]}。`) : '',
              L('这些条件不是背资料，是决定茶汤厚薄、香气扬不扬的直接原因。'),
            ],
          ].filter((c) => c.some(Boolean)),
        })
      );
    }
    return out;
  },
};

function mountainGeneric(ctx) {
  const { meta, product } = ctx;
  const name = product.name || meta.topic;
  return [
    S({
      type: 'points',
      kicker: '茶品档案',
      title: `${name} · 基本盘`,
      bullets: [
        product.type ? `类型：${product.type}` : '类型：普洱茶',
        product.year ? `年份：${product.year}` : '',
        product.spec ? `规格：${product.spec}` : '',
        '原料与工艺信息以实际到货批次为准，直播间同步公示',
      ].filter(Boolean),
      scriptClusters: [
        [
          L(`先把${name}的基本信息摆出来。`),
          L('产地、年份、规格我会一条条念清楚，不模糊处理。'),
          L('这些是你能拿去核对的硬信息。'),
        ],
      ],
    }),
  ];
}

/* ------------------------------------------------------------------ *
 * 06 山场与风味的因果
 * ------------------------------------------------------------------ */
const terroir = {
  id: 'terroir',
  title: '山场怎么决定味道',
  goal: '把「好喝」讲成有依据的事',
  weight: 2.2,
  minMinutes: 30,
  requires: 'mountain',
  build(ctx) {
    const { r, mountain } = ctx;
    if (!mountain?.terroir) return [];
    const cards = [
      {
        title: '海拔与温差',
        desc: mountain.altitude
          ? `海拔${mountain.altitude}，昼夜温差大，芽叶长得慢，内含物质积累更充分。`
          : '昼夜温差大，芽叶长得慢，内含物质积累更充分。',
      },
      {
        title: '土壤与根系',
        desc: mountain.soil || '砾石含量高的土壤，排水好，根系扎得深。',
      },
      {
        title: '树龄与产量',
        desc: mountain.treeAge
          ? `${mountain.treeAge}，单株产量低，一芽两叶的采摘窗口短。`
          : '树龄够老，单株产量低，采摘窗口短。',
      },
      {
        title: '落到杯子里',
        desc: `喝起来就是${(mountain.taste || []).join('、') || '汤感顺滑'}，香气偏${(mountain.aroma || [])[0] || '清雅'}。`,
      },
    ];
    return [
      S({
        type: 'cards',
        kicker: '山场逻辑',
        title: '为什么是这个味',
        cards,
        quote: mountain.terroir,
        scriptClusters: [
          [
            L('很多人问我，同一个山头的茶，凭什么味道能喝出来。'),
            L(mountain.terroir),
          ],
          [
            L('拆成三件事你就懂了。'),
            L('第一是海拔和温差，长得慢，物质积累就足。'),
            L(`第二是土壤，${mountain.soil || '砾石多、排水好'}，根系往下扎，吸到的矿物质不一样。`),
            L('第三是树龄，老树发芽少，但每一芽的分量足。'),
            L('这三件事叠起来，就是你杯子里那个味道。', '放慢语速'),
          ],
          [
            L(`所以我说它${(mountain.taste || []).join('、') || '顺口'}，不是我随口夸的。`),
            L('你要是喝到一款标着这个山头、但完全没有这个走向的茶，心里就该打个问号了。', '看镜头'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 07 品鉴四维
 * ------------------------------------------------------------------ */
const tasting = {
  id: 'tasting',
  title: '品鉴四维：香、味、汤、底',
  goal: '让观众隔着屏幕也能「想象出味道」',
  weight: 2.8,
  minMinutes: 0,
  build(ctx) {
    const { r, mountain, product } = ctx;
    const aroma = (mountain?.aroma || []).join('、') || '花果香清雅';
    const taste = (mountain?.taste || []).join('、') || '汤感顺滑、回甘稳定';
    const soup = mountain?.soup || '汤色明亮';
    const leaf = mountain?.leaf || '叶底柔软有弹性';
    const cards = [
      { title: '闻香', desc: `${aroma}。温杯后投茶，先闻干香，再闻热香。` },
      { title: '入口', desc: `${taste}。第一口别急着咽，让茶汤在舌面停一下。` },
      { title: '看汤', desc: `${soup}。出汤要快，前三泡控制在五秒上下。` },
      { title: '看叶底', desc: `${leaf}。叶底骗不了人，泡开后一眼就知道料好不好。` },
    ];
    const firstTaste = (mountain?.taste || [])[0] || '甜润';
    return [
      S({
        type: 'tasting',
        kicker: '品鉴',
        title: `${mountain?.name || product.name || '这款茶'} · 四个维度`,
        cards,
        table: {
          headers: ['维度', '表现'],
          rows: [
            ['香气', aroma],
            ['滋味', taste],
            ['汤色', soup],
            ['叶底', leaf],
          ],
        },
        scriptClusters: [
          [
            L('接下来这四句，你记下来，以后自己去试茶也是这么four步。'.replace('four', '四')),
            L(`先闻香——${aroma}。`),
            L(`再入口——${taste}。`),
            L(`看汤色——${soup}。`),
            L(`看叶底——${leaf}。`),
          ],
          [
            L(`重点说第一口。${firstTaste}这个感觉是从舌面两侧往舌根走的。`, '重音'),
            L('你喝的时候注意，如果苦涩停在舌头中间下不去，那多半是料或者工艺有问题。'),
            pick(r, [
              L('好茶的标准不是「不苦」，而是苦能化得开，化开之后能回甜。'),
              L('所以别听人说「一点都不苦」就买，苦化不化得开才是关键。'),
            ]),
          ],
          [
            L('我现在把这泡茶端到镜头前，你看一下汤色。', '拿起公道杯'),
            L('看到没有，通透，没有浑浊。'),
            L('评论区打个「看到了」，我看看有多少人跟我在一个频率上。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 09 冲泡
 * ------------------------------------------------------------------ */
const brewing = {
  id: 'brewing',
  title: '冲泡演示',
  goal: '教会观众，降低「买回去不会泡」的顾虑',
  weight: 2,
  minMinutes: 25,
  build(ctx) {
    const { r, mountain, product } = ctx;
    const tip = mountain?.brewTips || '水温 95-100℃，投茶 7-8 克，前三泡快速出汤。';
    return [
      S({
        type: 'steps',
        kicker: '冲泡',
        title: '这样泡，味道出得来',
        steps: [
          { title: '备器', desc: '盖碗 120ml，或紫砂壶，先温杯' },
          { title: '投茶', desc: '7-8 克，约 1:15 的茶水比' },
          { title: '醒茶', desc: '沸水快冲快出，第一泡不喝，用来润茶' },
          { title: '出汤', desc: '前三泡 5 秒内出汤，之后逐泡加 5 秒' },
          { title: '续水', desc: '老茶耐泡，可续至 10 泡以上' },
        ],
        footnote: tip,
        scriptClusters: [
          [
            L('很多人买回去说味道不对，八成是泡法的问题。'),
            L('我说一下我自己的泡法，你照着试。'),
            L('盖碗一百二十毫升，投茶七到八克，先温杯。'),
            L('第一泡沸水快冲快出，这泡不喝，叫醒茶。'),
          ],
          [
            L('前三泡五秒内出汤，千万别闷。'),
            L('第四泡开始每泡加五秒，这样味道是往上走的，不会一下掉下来。'),
            pick(r, [
              L('水很重要，能用矿泉水就别用自来水，硬水会把香气压住。'),
              L('烧开之后稍微等一下再冲，水温太高会把嫩芽烫熟，汤会发涩。'),
            ]),
          ],
          [
            L(`这款我自己的经验是：${tip}`, '看提示卡'),
            L('你按这个泡，如果还是觉得不对，评论区说，我帮你分析。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 10 避坑 / 防伪
 * ------------------------------------------------------------------ */
const pitfall = {
  id: 'pitfall',
  title: '避坑指南',
  goal: '用「教你防坑」建立信任，顺便劝退假货需求',
  weight: 2,
  minMinutes: 30,
  build(ctx) {
    const { r, mountain, product } = ctx;
    const who = mountain?.name || product.mountainName || product.name || '这个山头';
    const base = mountain?.pitfalls?.length
      ? mountain.pitfalls
      : [
          `同名的${who}满街都是，价格差得多，多半是原料等级或产地范围不一样`,
          '虚报树龄是常见做法，老树小树价格差一截',
          '湿仓做旧冒充老茶，喝起来有霉味、汤色发暗',
          '包装写得很足，但没有任何可核对的原料信息',
        ];
    return [
      S({
        type: 'points',
        kicker: '避坑',
        title: `买${who}，这几个坑要绕开`,
        bullets: base,
        quote: '我宁可你不买，也别买错',
        scriptClusters: [
          [
            L('这一段可能有人不爱听，但我还是要讲。'),
            L(`买${who}，第一，价格低得离谱的要小心。`),
            L('原料是有成本的，低到不符合常理，那就有别的东西在替它买单。'),
          ],
          [
            ...base.slice(0, 3).map((p, i) => L(`第${'一二三四五'[i + 1]}，${p.replace(/^同名的/, '')}`)),
          ],
          [
            pick(r, [
              L('所以你在别处买也行，我不介意。但你得会看这几条。'),
              L('我讲这些不是吓你，是想让你以后买茶有判断力。'),
            ]),
            L('评论区如果有人说自己踩过坑，可以说出来，大家一起避。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 11 对比
 * ------------------------------------------------------------------ */
const compare = {
  id: 'compare',
  title: '横向对比',
  goal: '给出参照系，让价格有落点',
  weight: 1.8,
  minMinutes: 30,
  build(ctx) {
    const { mountain, product } = ctx;
    const who = mountain?.name || product.name || '本品';
    const taste = (mountain?.taste || []).slice(0, 2).join('、') || '汤感顺滑';
    return [
      S({
        type: 'compare',
        kicker: '对比',
        title: `${who} 和市面常见的区别`,
        left: {
          title: '本品',
          items: [
            `原料来自${mountain?.area || mountain?.region || '核心产区'}`,
            `风格：${taste}`,
            '批次可溯源，原料信息公示',
            '不拼配，或拼配比例公开',
          ],
        },
        right: {
          title: '低价同名产品常见做法',
          items: [
            '用周边产区原料顶替',
            '拼配后统一按山头名出售',
            '年份与树龄无据可查',
            '靠包装和话术撑价格',
          ],
        },
        scriptClusters: [
          [
            L('光说好没有参照，我拿市面上常见的做法对比一下。'),
            L(`左边是这款，原料来自${mountain?.area || mountain?.region || '核心产区'}，风格是${taste}。`),
            L('右边是你在别处容易碰到的情况。'),
          ],
          [
            L('注意，我不是说别家的茶不能喝。'),
            L('我是说，同一个名字下面的东西，可以差很远。'),
            L('所以买之前，问清楚原料在哪、哪一年、什么等级。', '看镜头'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 12 产品介绍
 * ------------------------------------------------------------------ */
const productIntro = {
  id: 'product',
  title: '产品介绍',
  goal: '把卖点落在具体参数上',
  weight: 2.6,
  minMinutes: 0,
  build(ctx) {
    const { r, product, mountain } = ctx;
    const points = [
      ...(mountain?.sellingPoints || []),
      ...(mountain?.taste || []).map((t) => `喝起来${t}`),
    ].slice(0, 4);
    const rows = [
      ['品名', product.name],
      ['类型', product.type],
      ['年份', product.year],
      ['规格', product.spec],
      ['产区', [mountain?.region, mountain?.area].filter(Boolean).join(' · ') || product.mountainName],
      ['建议人群', (mountain?.audience || []).join('、')],
    ].filter((row) => row[1]);
    return [
      S({
        type: 'product',
        kicker: '本场茶品',
        title: product.name || '本场茶品',
        bullets: points.length ? points : ['原料清楚，批次可核对', '汤感顺滑，回甘稳定', '支持七天无理由'],
        table: { headers: ['参数', '内容'], rows },
        scriptClusters: [
          [
            L(`好，回到今天这饼茶——${product.name}。`),
            ...points.slice(0, 3).map((p) => L(p)),
          ],
          [
            L('参数我一条条念给你，你对着看。'),
            ...rows.slice(0, 5).map((row) => L(`${row[0]}：${row[1]}。`)),
          ],
          [
            pick(r, [
              L('这些信息如果你在别的地方看不到，那就要多问一句。'),
              L('我给的都是能核对的，不是形容词。'),
            ]),
            L('想看的，我一会儿把镜头拉到茶饼上，你自己看条索。', '拿起茶饼'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 13 溯源凭证
 * ------------------------------------------------------------------ */
const proof = {
  id: 'proof',
  title: '溯源与凭证',
  goal: '把「信任」变成可核对的东西',
  weight: 1.6,
  minMinutes: 40,
  purposes: ['newlaunch', 'promo', 'mixed', 'thanks'],
  build(ctx) {
    const { product, mountain } = ctx;
    return [
      S({
        type: 'cards',
        kicker: '凭证',
        title: `凭什么信这饼茶 · ${product.name}`,
        cards: [
          { title: '原料溯源', desc: `茶农与初制所信息可提供，${mountain?.name || '产区'}实际到访记录` },
          { title: '检测报告', desc: '农残与理化指标按批次送检，报告可查' },
          { title: '入库记录', desc: `批次号与入库时间留档，${product.year || '当年'}起在本地干仓存放` },
          { title: '售后', desc: '七天无理由退换，喝着不对可直接退' },
        ],
        scriptClusters: [
          [
            L('信任这件事，不能靠嘴说，得靠能查的东西。'),
            L('原料是从哪个茶农、哪个初制所拿的，我能说清楚。'),
            L('检测报告按批次出的，你问我要，我发给你看。'),
          ],
          [
            L('还有一点很重要：仓储。'),
            L(`这批从${product.year || '入库那年'}起就放在我自己的干仓，湿度控着，没有异味。`),
            L('你收到如果觉得仓储不对，七天无理由，直接退。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 14 价格锚点
 * ------------------------------------------------------------------ */
const price = {
  id: 'price',
  title: '价格与价值',
  goal: '把总价拆成每泡成本，让价格有落点',
  weight: 2.4,
  minMinutes: 0,
  build(ctx) {
    const { r, product, mountain } = ctx;
    const gram = parseGram(product.spec) || 357;
    const servings = Math.round(gram / 8);
    const unit = product.price ? product.price / servings : null;
    const perCup = unit ? Math.round(unit) : null;
    const anchors = [];
    if (product.comparePrice && product.price) {
      anchors.push({ label: '日常价', value: `¥${yuan(product.comparePrice)}` });
    }
    if (product.price) anchors.push({ label: '今晚直播间', value: `¥${yuan(product.price)}` });
    if (perCup) anchors.push({ label: '折合每泡', value: `约 ¥${perCup}` });
    return [
      S({
        type: 'price',
        kicker: '价格',
        title: product.price ? `今晚 ¥${yuan(product.price)}` : '价格说明',
        price: product.price ? `¥${yuan(product.price)}` : '',
        comparePrice: product.comparePrice ? `¥${yuan(product.comparePrice)}` : '',
        anchors,
        bullets: [
          perCup ? `一饼${gram}g，按8g一泡算能喝${servings}泡，每泡约${perCup}元` : '',
          product.gift ? `赠：${product.gift}` : '',
          product.stock ? `库存：${product.stock}` : '',
        ].filter(Boolean),
        scriptClusters: [
          [
            L('价格我不绕弯子。'),
            product.price ? L(`今晚是${yuan(product.price)}一饼。`) : L('价格在下方链接里，我念一遍。'),
            product.comparePrice
              ? L(`日常是${yuan(product.comparePrice)}，今晚这个数只在这场用。`)
              : L('这个价格只在这场有效。'),
          ],
          [
            perCup
              ? L(`有人觉得贵，我们算一下：一饼${gram}克，一泡8克，能喝${servings}泡。`)
              : L('我们算一笔账。'),
            perCup ? L(`折下来一泡${perCup}块钱。`) : '',
            pick(r, [
              L('一杯奶茶的钱，喝一泡能溯源的老树茶，你觉得哪个值。'),
              L('一泡茶的钱，比一杯咖啡还低，但它能让你坐一下午。'),
            ]),
          ],
          [
            L('我不劝你多买。先买一饼，喝得对再回来。'),
            L('喝不对，七天无理由，运费我承担。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 15 限量机制
 * ------------------------------------------------------------------ */
const urgency = {
  id: 'urgency',
  title: '库存与机制',
  goal: '给出真实的稀缺性，不做虚假限时',
  weight: 1.2,
  minMinutes: 30,
  purposes: ['promo', 'newlaunch', 'mixed', 'thanks'],
  build(ctx) {
    const { product, mountain } = ctx;
    return [
      S({
        type: 'cards',
        kicker: '库存',
        title: `这批茶的真实情况 · ${product.name}`,
        cards: [
          { title: '产量', desc: mountain?.treeAge ? `${mountain.treeAge}，单株产量有限，这批只做了这么些` : '这批按实际收货量上架，卖完为止' },
          { title: '库存', desc: product.stock || '数量以直播间库存显示为准' },
          { title: '规格与价格', desc: `${product.spec || '规格以商品页为准'}${product.price ? '，直播间 ' + product.price + ' 元' : ''}` },
          { title: '不补货说明', desc: '原料批次不可复制，同款下一批风味会有差异' },
        ],
        scriptClusters: [
          [
            L('说清楚库存，不搞虚的。'),
            L(product.stock ? `这批${product.stock}。` : '这批是按实际到货量上的。'),
            L('卖完就是卖完，我不会用虚假倒计时催你。'),
          ],
          [
            L('但我也实话告诉你，同一个山头的原料，不同批次味道是不一样的。'),
            L('你这次喝着喜欢，下一批可能就不完全一样，这不是我藏私，是茶本身就这样。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 16 答疑
 * ------------------------------------------------------------------ */
const faq = {
  id: 'faq',
  title: '常见问题答疑',
  goal: '处理下单前的顾虑',
  weight: 2.2,
  minMinutes: 25,
  build(ctx) {
    const { r, mountain, product, kbFaq } = ctx;
    const questions = [
      {
        q: '会不会很苦？',
        a: `${(mountain?.taste || []).join('、') || '汤感顺滑'}，入口苦能化开，化开之后回甜。`,
      },
      {
        q: '新手喝得惯吗？',
        a: (mountain?.audience || []).includes('新手入门')
          ? '可以，第一泡快出汤，味道会比较轻，容易接受。'
          : '建议从快出汤开始，觉得浓就减少投茶量。',
      },
      {
        q: '能存吗？',
        a: '干仓通风、避光、无异味的环境即可，生茶有转化空间，熟茶建议三五年内喝完。',
      },
      {
        q: '送人合适吗？',
        a: (mountain?.audience || []).includes('送礼')
          ? '合适，包装可提供，也能附上原料信息卡。'
          : '可以，但建议先自己喝过再送，讲得出味道更有面子。',
      },
      {
        q: '怎么辨真假？',
        a: mountain?.pitfalls?.[0] || '看叶底和汤色，再问原料批次，答不上来的就要谨慎。',
      },
      {
        q: '发什么快递、多久到？',
        a: '默认顺丰或京东，下单后当天或次日发出，偏远地区以物流信息为准。',
      },
    ];
    const extra = (kbFaq || []).slice(0, 2).map((f) => ({ q: f.q, a: f.a }));
    const list = [...questions, ...extra].slice(0, 5);
    return [
      S({
        type: 'faq',
        kicker: '答疑',
        title: '评论区问得比较多的几个问题',
        faq: list,
        scriptClusters: [
          [
            L('我把评论区常见的问题集中回答一下。'),
            ...list.slice(0, 3).map((f) => L(`有人问${f.q}${f.a}`)),
          ],
          [
            ...list.slice(3, 5).map((f) => L(`还有人问${f.q}${f.a}`)),
            L('还有别的问题，打在评论区，我看到就回。', '看评论区'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 17 科普加餐
 * ------------------------------------------------------------------ */
const knowledge = {
  id: 'knowledge',
  title: '知识加餐',
  goal: '科普场专用：把品类常识讲透',
  weight: 2.4,
  minMinutes: 35,
  purposes: ['knowledge'],
  build(ctx) {
    const { relatedProducts } = ctx;
    const picks = (relatedProducts || []).slice(0, 4);
    const cards = picks.length
      ? picks.map((p) => ({ title: p.name, desc: (p.points || [])[0] || p.summary || '' }))
      : [
          { title: '生普与熟普', desc: '生普自然陈化，熟普人工渥堆发酵，风味走向完全不同。' },
          { title: '古树与台地', desc: '树龄与密度不同，汤感的厚度、耐泡度差别明显。' },
          { title: '干仓与湿仓', desc: '仓储决定后期转化，湿仓快但容易有杂味。' },
          { title: '饼砖沱龙珠', desc: '形态不同，紧压程度影响转化速度。' },
        ];
    return [
      S({
        type: 'cards',
        kicker: '知识加餐',
        title: '顺带讲几个常识',
        cards,
        scriptClusters: [
          [
            L('趁喝着的功夫，讲几个常识，你以后买茶用得上。'),
            ...cards.slice(0, 3).map((c) => L(`${c.title}：${c.desc}`)),
          ],
          [
            L('这些不是玄学，都是能自己验证的。'),
            L('你买两泡对比着喝，差别喝得出来。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 18 老客答谢
 * ------------------------------------------------------------------ */
const thanks = {
  id: 'thanks',
  title: '老客答谢',
  goal: '答谢场专用：给复购理由',
  weight: 2,
  minMinutes: 25,
  purposes: ['thanks'],
  build(ctx) {
    const { meta, product } = ctx;
    return [
      S({
        type: 'cards',
        kicker: '答谢',
        title: '今天这场是给老客的',
        cards: [
          { title: '复购价', desc: product.price ? `老客回购按 ¥${yuan(product.price)} 结算` : '老客复购有专属价格' },
          { title: '优先发货', desc: '老客订单当天优先打包发出' },
          { title: '专属茶样', desc: '下单随包裹附本季新茶样，先试再买' },
          { title: '反馈有回音', desc: '喝到问题直接找我，不用走客服流程' },
        ],
        scriptClusters: [
          [
            L(`今天这场不对外推，主要是给一直在我这儿买茶的朋友。`),
            L('你们这几年买过什么、喜欢什么口感，我大概有印象。'),
            L('所以今天这场我挑的是你们回头率比较高的方向。'),
          ],
          [
            L('老规矩，复购价我放在链接里，不搞先涨后降那一套。'),
            L('有想试的新茶，直接说，我给你配茶样。'),
            L(`我是${meta.host}，谢谢你们还在。`),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 19 下单引导
 * ------------------------------------------------------------------ */
const cta = {
  id: 'cta',
  title: '下单引导',
  goal: '把「想买」变成「会买」',
  weight: 1.4,
  minMinutes: 0,
  build(ctx) {
    const { meta, product } = ctx;
    return [
      S({
        type: 'cta',
        kicker: '怎么买',
        title: '想喝的，这样下单',
        bullets: [
          '点下方购物车，选择规格后提交',
          product.gift ? `备注区写上「${product.gift}」，赠品随单发出` : '下单备注「直播间」，方便我优先安排',
          '收到先开一泡试，不合适七天无理由',
          '有问题在评论区说，或者私信客服',
        ],
        scriptClusters: [
          [
            L('好，想喝的现在可以下手了。'),
            L('点下面购物车，选规格，提交就行。'),
            product.gift
              ? L(`记得备注区写上「${product.gift}」，这样赠品才跟得上。`)
              : L('下单备注一下「直播间」，我这边优先给你安排。'),
          ],
          [
            L('收到之后别急着存，先开一泡。'),
            L('喝着对，你再来；喝着不对，七天无理由，退回来就行。'),
            L('不用有压力。'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 20 收尾
 * ------------------------------------------------------------------ */
const ending = {
  id: 'end',
  title: '收尾与预告',
  goal: '锁住关注，为下一场铺路',
  weight: 1,
  minMinutes: 0,
  build(ctx) {
    const { r, meta, product } = ctx;
    return [
      S({
        type: 'end',
        kicker: '收尾',
        title: '今晚就到这儿',
        subtitle: pick(r, [
          '谢谢陪我到最后的朋友',
          '慢慢喝，别急着买',
          '茶是喝的，不是囤的',
        ]),
        bullets: [
          '没听够的，关注一下，下场接着讲',
          meta.nextTopic ? `下一场预告：${meta.nextTopic}` : '下一场主题会在主页提前发',
          '今天讲的资料我整理成一份，评论区留言「要资料」我发你',
        ],
        scriptClusters: [
          [
            L('时间差不多了，今晚就讲到这儿。'),
            L(product.price ? '链接我留着，想好了再下单，不用现在决定。' : '有想了解的，评论区留言。'),
          ],
          [
            L('关注一下，下一场我们接着讲。'),
            L('慢慢喝，不着急。', '收尾，语气放轻'),
          ],
        ],
      }),
    ];
  },
};

/* ------------------------------------------------------------------ *
 * 信任与溯源（§1）
 *
 * 直播间的信任不是靠形容词建立的，是靠「你能核对的硬信息」：
 * 坐标、树龄结构、采摘标准、初制所、毛茶编号、检测报告。
 * 这些字段没有就整页不出 —— 与其编一页空的，不如不讲。
 * ------------------------------------------------------------------ */
const traceability = {
  id: 'traceability',
  title: '信任与溯源',
  goal: '用可核对的信息建立信任',
  weight: 2.0,
  minMinutes: 0,
  requires: 'mountain',
  purposes: ['knowledge', 'newlaunch', 'mixed'],
  build(ctx) {
    const { r, meta, product, mountain } = ctx;
    if (!mountain) return [];

    const rows = [
      ['坐标', mountain.coordinates],
      ['村寨', mountain.village || mountain.area],
      ['海拔', mountain.altitude],
      ['树龄结构', mountain.treeAgeStructure],
      ['采摘标准', mountain.pickStandard],
      ['初制所', mountain.factory],
      ['毛茶编号', mountain.batchNo],
      ['检测报告', (mountain.labReport || []).join('；')],
      ['合作年限', mountain.partnerYears],
    ].filter(([, v]) => hasContent(v));

    // 一条硬信息都没有 → 这一章不出（不要为了凑页数编内容）
    const story = hasContent(mountain.whyThisPlot) ? String(mountain.whyThisPlot).trim() : '';
    /* 出页门槛：**溯源专属**字段至少填了 2 个。
       不能拿「村寨（回退到 area）、海拔」这种一直有值的老字段算数 ——
       否则你什么都没填，这页也会带着两行空壳出来（实测踩过）。 */
    const ownFields = [
      mountain.coordinates,
      mountain.village,
      mountain.treeAgeStructure,
      mountain.pickStandard,
      mountain.factory,
      mountain.batchNo,
      (mountain.labReport || []).join(''),
      mountain.partnerYears,
    ].filter(hasContent).length;
    if (ownFields < 2 && !story) return [];

    const out = [];
    if (rows.length) {
      out.push(
        S({
          type: 'table',
          kicker: '信任与溯源',
          title: `${mountain.name} · 我的料从哪来`,
          table: { headers: ['项目', '内容'], rows },
          footnote: '这些信息你都可以拿去核对，对不上我负责',
          scriptClusters: [
            [
              L(`先说清楚料是哪儿的，${mountain.coordinates ? '坐标是' + mountain.coordinates + '，' : ''}${mountain.village ? '村寨在' + mountain.village + '。' : ''}`),
              mountain.altitude ? L(`海拔${mountain.altitude}。`) : '',
              mountain.treeAgeStructure ? L(`树龄结构上，${mountain.treeAgeStructure}。`) : '',
            ],
            [
              mountain.pickStandard ? L(`我采的是${mountain.pickStandard}。`) : '',
              mountain.factory ? L(`初制在${mountain.factory}做的。`) : '',
              mountain.batchNo ? L(`这一批毛茶编号${mountain.batchNo}，你可以拿这个号跟我对。`) : '',
            ],
            [
              mountain.labReport?.length ? L(`检测报告我放在这儿：${mountain.labReport.join('；')}。`) : '',
              mountain.partnerYears ? L(`这家的茶我收了${mountain.partnerYears}。`) : '',
              L('我说这些不是让你马上信，是给你留一条能查的路。'),
            ],
          ],
        })
      );
    }

    if (story) {
      const paras = story.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      out.push(
        S({
          type: 'cards',
          kicker: '选料逻辑',
          title: `我为什么选这块地`,
          cards: paras.slice(0, 4).map((p, i) => ({
            title: ['第一次喝到', '为什么是这块地', '和茶农的合作', '我的判断'][i] || `第${i + 1}点`,
            desc: p,
          })),
          footnote: hasContent(mountain.partnerYears) ? `合作${mountain.partnerYears}` : '',
          scriptClusters: [
            [L(paras[0] || '')],
            paras.slice(1).map((p) => L(p)),
          ].filter((c) => c.some(Boolean)),
        })
      );
    }

    /* 历史沿革：谁命名的茶王树、哪年进的村、老照片是什么年代。
       和「选料逻辑」分开两页 —— 那页讲「我为什么选它」，这页讲「这块地发生过什么」：
       前者建立信任，后者制造话题。 */
    if (hasContent(mountain.history)) {
      const paras = String(mountain.history).trim().split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      out.push(
        S({
          type: 'cards',
          kicker: '历史沿革',
          title: `${mountain.name} · 这些年的事`,
          cards: paras.slice(0, 4).map((p, i) => ({
            title: ['最早的一次', '一路记下来', '最近这些年的变化', '还会继续'][i] || `第${i + 1}段`,
            desc: p,
          })),
          footnote: '照片和录像都在，讲的时候可以直接翻出来',
          scriptClusters: [
            paras.slice(0, 2).map((p) => L(p)),
            paras.slice(2, 4).map((p) => L(p)),
          ].filter((c) => c.some(Boolean)),
        })
      );
    }
    return out;
  },
};

/* ------------------------------------------------------------------ *
 * 工艺与滋味（§2 的后半）
 *
 * 为什么不做通用的「萎凋→杀青→揉捻→晒青→蒸压」流程图：
 * 那是任何一本普洱入门书上都有的东西，观众看完不会记住你，
 * 而且它跟你的料没关系。真正有价值的是**这块地的工艺怎么改变了滋味** ——
 * 杀青轻重、揉捻轻重、晒青程度，每个山头做法不同、结果也不同。
 * 所以这一页完全由知识库里的「工艺影响」驱动，没填就不出。
 * ------------------------------------------------------------------ */
const craftEffect = {
  id: 'craft-effect',
  title: '工艺与滋味',
  goal: '讲清这块地的做法如何塑造了滋味',
  weight: 1.6,
  minMinutes: 0,
  requires: 'mountain',
  purposes: ['knowledge', 'newlaunch', 'mixed'],
  build(ctx) {
    const { r, mountain } = ctx;
    if (!mountain) return [];
    const items = (mountain.craftEffect || []).map((x) => String(x).trim()).filter((x) => hasContent(x));
    if (!items.length) return [];

    // `杀青偏轻: 苦涩保留更多，前段冲击强` → 拆成两列
    const rows = items.map((x) => {
      const m = x.match(/^([^：:]{1,20})[：:]\s*([\s\S]+)$/);
      return m ? [m[1].trim(), m[2].trim()] : null;
    });
    const structured = rows.filter(Boolean);
    const hasTwoCols = structured.length >= 2;

    /* 不足两条结构化内容时，别出**单列表格**。
       实测踩过：知识库里只写了一条自由叙述（没有 `工序: 影响` 的结构），
       表格退化成一列，在窄列版式里正文只占左边 8% 宽度、中间一大片空白，
       页码检查直接把它判成空白页 —— 观感上确实是坏的。
       这种情况改用 points，让文字铺满版面。 */
    if (!hasTwoCols) {
      return [
        S({
          type: 'points',
          kicker: '工艺与滋味',
          title: `${mountain.name} · 做法是怎么进到汤里的`,
          bullets: items,
          footnote: '同一片叶子，做法不同，前中后段的表现就不一样',
          scriptClusters: [
            [L(`${mountain.name}的做法上，有几处是直接影响滋味的。`)],
            items.map((x) => L(x)),
          ],
        }),
      ];
    }

    return [
      S({
        type: 'table',
        kicker: '工艺与滋味',
        title: `${mountain.name} · 做法是怎么进到汤里的`,
        table: { headers: ['工艺处理', '对滋味的影响'], rows: structured },
        footnote: '同一片叶子，做法不同，前中后段的表现就不一样',
        scriptClusters: [
          [
            L(`${mountain.name}的做法上，有几处是直接影响滋味的。`),
            ...structured.slice(0, 2).map(([k, v]) => L(`${k}——${v}`)),
          ],
          [
            ...structured.slice(2, 4).map(([k, v]) => L(`${k}，结果就是${v}`)),
            L('所以你喝到的不是「山头」两个字，是这一整套做法最后落在杯子里的样子。'),
          ].filter(Boolean),
        ],
      }),
    ];
  },
};

export const BLOCKS = [
  cover,
  hook,
  credibility,
  traceability,
  mountainProfile,
  craftEffect,
  terroir,
  tasting,
  brewing,
  pitfall,
  compare,
  productIntro,
  proof,
  price,
  urgency,
  faq,
  knowledge,
  thanks,
  cta,
  ending,
];

export const BLOCK_MAP = new Map(BLOCKS.map((b) => [b.id, b]));

export const PURPOSES = {
  newlaunch: { label: '新品首发', desc: '第一次上架，重点是讲清楚来历与卖点' },
  promo: { label: '大促逼单', desc: '转化优先，知识与价格并重' },
  knowledge: { label: '知识科普', desc: '内容优先，弱化推销' },
  thanks: { label: '老客答谢', desc: '复购与回馈为主' },
  mixed: { label: '常规带货', desc: '节奏均衡的标准场' },
};

export const AUDIENCES = {
  newbie: { label: '新手茶友', desc: '刚接触普洱，需要通俗解释' },
  regular: { label: '日常口粮客', desc: '关注性价比与稳定口感' },
  veteran: { label: '老茶客', desc: '关注山场、树龄、年份与转化' },
  gift: { label: '送礼/商务', desc: '关注包装、体面与来源可靠' },
};

export const STYLES = {
  practical: { label: '实在直给', desc: '少铺垫，直接讲干货与价格' },
  storyteller: { label: '山场叙事', desc: '多讲山场、工艺与人的关系' },
  professional: { label: '专业测评', desc: '术语偏多，结构化对比' },
  warm: { label: '亲切陪伴', desc: '像朋友聊天，节奏放松' },
};

/** 每个用途默认启用的段落顺序。 */
export const PURPOSE_FLOW = {
  newlaunch: [
    'cover', 'hook', 'credibility', 'mountain-profile', 'terroir',
    'tasting', 'product', 'proof', 'price', 'urgency', 'faq', 'cta', 'end',
  ],
  promo: [
    'cover', 'hook', 'mountain-profile', 'tasting', 'product', 'proof',
    'price', 'urgency', 'pitfall', 'faq', 'cta', 'end',
  ],
  knowledge: [
    // 知识科普场按「七章」组织：信任与溯源 → 山头档案与工艺 → 品鉴体系 →
    // 前中后段 → 转化方向 → 价格体系 → 对比与避坑。
    // 不发单款产品的价（这类场次是来讲明白的，不是来卖货的）。
    'cover', 'hook', 'credibility', 'traceability',
    // 山头档案与工艺：地理身份 → 气候生态 → 为什么是这个味 → 工艺怎么影响滋味。
    // 不放通用的「萎凋→…→仓储」工艺流程图（那是入门书内容，跟你的料没关系）。
    'mountain-profile', 'terroir', 'craft-effect',
    'tasting', 'brewing',
    'compare', 'pitfall', 'faq', 'cta', 'end',
  ],
  thanks: [
    'cover', 'hook', 'credibility', 'thanks', 'product', 'proof',
    'price', 'urgency', 'faq', 'cta', 'end',
  ],
  mixed: [
    'cover', 'hook', 'mountain-profile', 'terroir', 'tasting',
    'product', 'proof', 'price', 'pitfall', 'faq', 'cta', 'end',
  ],
};
