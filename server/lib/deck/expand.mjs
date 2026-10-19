/**
 * 扩写引擎：让口播稿长度随时长伸缩。
 *
 * 内容块自带 2-3 簇稿子，只够 10 分钟左右的场。要撑起 60-120 分钟，
 * 必须从知识库字段里「长」出更多段落，同时避免跨段落重复。
 *
 * 三个机制：
 *   1) factClusters —— 把知识库每个字段展开成一段可念的话
 *   2) beatClusters —— 直播间通用节拍（互动、类比、场景、售后……）按段落打标签
 *   3) TAIL 变体库  —— 段落收尾句不写死，从多个说法里挑，
 *                      这样「多趟生成 + 逐行去重」能真的产出不同句子（容量关键）
 */
import { pick, charCount, makeRng } from './copy.mjs';

const L = (text, cue = '') => ({ text: String(text).trim(), cue });

/** 知识库字段自带句末标点，嵌入模板前先去掉，避免「。。」。 */
const clean = (s) =>
  String(s ?? '')
    .replace(/[\s\u3000]+$/g, '')
    .replace(/[。．.!！?？,，;；、：:]+$/g, '')
    .trim();

/* ------------------------------------------------------------------ *
 * 收尾句变体库：同一段落换一种说法，避免整场稿子出现重复句式
 * ------------------------------------------------------------------ */
const TAIL = {
  insight: [
    '这句话你可以记着，等下自己喝的时候对照一下。',
    '你按这个标准去比，就不会被话术带走。',
    '这个点记下来，买茶的时候用得上。',
    '记住这一条，比听十句夸奖都实在。',
    '你下次买茶，拿这一条去问店家就行。',
    '这个判断标准不需要工具，舌头就能验证。',
    '听懂这一句，你在别处买茶也不容易吃亏。',
    '这条经验我用了很多年，一直没变过。',
  ],
  trust: [
    '我不希望你是听我说完就买，而是你喝出来之后再决定。',
    '我说这些不是让你现在就下单，是让你有判断力。',
    '买不买都行，关键是你知道自己在买什么。',
    '我把话说明白，你自己判断合不合适。',
    '这些我都愿意讲清楚，因为经得起问。',
    '你今天哪怕不买，带着这个判断标准走也不亏。',
    '我不要你冲动消费，冲动买回去的茶通常喝不完。',
    '我更希望你喝完再回来，而不是听我说完就付钱。',
  ],
  advice: [
    '遇到这种情况，直接换一家就行，不用争。',
    '碰到这种说法，你心里先打个问号。',
    '这种时候别犹豫，问三个问题答不上来就放弃。',
    '越是催你下单的，越要多看两眼。',
    '这种情况在市场上不罕见，所以问清楚很重要。',
    '你可以直接把这段话拿去问店家，看对方怎么答。',
    '这一条是防坑的关键，比价格更值得花时间。',
    '价格可以谈，来源不能含糊。',
  ],
  knowledge: [
    '这类常识你多听几次，自己就有判断力了。',
    '这些不是玄学，都能自己验证。',
    '你记住这一条，以后选茶会轻松很多。',
    '基础的东西最有用，很多人就是绕不过这一步。',
    '听完这些，你再去看商品页，能看出不少问题。',
    '这种知识不需要背，多喝几次自然就懂了。',
    '我讲这些都是能落地的，不是空话。',
    '懂原理之后，你就不太需要别人推荐了。',
  ],
  tasteTail: [
    '你第一次喝可能抓不住，泡到第三泡再回来体会一下。',
    '这个特征在对比着喝的时候更容易分辨。',
    '刚接触可能不明显，多喝两次就有感觉了。',
    '你注意一下从入口到回甘的这个过程。',
    '这个感受是这款茶的底子，不是泡法做出来的。',
    '记不住没关系，喝的时候自然能对上。',
    '你拿它和别的茶对冲一次，差别马上就出来了。',
    '这个方向是山场给的，后期很难靠工艺补上。',
  ],
  scene: [
    '这茶适合什么时候喝？我自己的习惯是下午三四点，办公室里泡一泡。',
    '周末在家没事，烧水泡一泡，能坐一下午。',
    '吃完饭半小时以后泡一泡，比喝饮料舒服。',
    '来客人的时候泡这个，话题自然就有了。',
    '早上到工位先泡一泡，一天的状态都不一样。',
    '出差带几颗龙珠，酒店里也能喝。',
  ],
  analogy: [
    '一杯奶茶的钱，喝一泡能溯源的老树茶。',
    '一泡茶的成本，比一杯咖啡还低。',
    '这个价格折下来，比点外卖的饮料便宜。',
    '算到每泡，你可能会觉得和想象的不一样。',
    '同样的钱，花在原料上比花在包装上值。',
  ],
  interact: [
    '评论区打一下你平时喝什么茶，我看看跟今晚这款像不像。',
    '在场的有喝过生普的吗？打个「喝过」，我心里有个数。',
    '你们平时买茶看什么？产地、价格还是口感？打出来我看看。',
    '有喝过这个山头的朋友吗？说说你的感受。',
    '进来晚的朋友打个「在」，我重复一下前面讲的重点。',
    '觉得有用的话打个「学到了」，我就知道该往细里讲还是往快里讲。',
  ],
  invite: [
    '有问题的现在就可以打出来，我讲完这段就集中回答。',
    '别怕问题太基础，基础问题往往是最多人想问的。',
    '想问什么直接打，我看到就回，不用等我点名。',
    '评论区的问题我都会看，重复的我会一起答。',
    '有拿不准的茶也可以发出来，我帮你一起看。',
  ],
  warn2: [
    '买茶这件事，信息越透明越好，不愿意讲清楚的本身就是信号。',
    '一个愿意让你看叶底、看报告的店家，比一百句保证有用。',
    '你多问一句，就能筛掉一大批不靠谱的货。',
    '不懂没关系，愿意讲清楚的人才是可以合作的。',
  ],
};

const T = (r, bank, fallback) => L(pick(r, TAIL[bank]) || fallback);

function tasteExplain(t) {
  const MAP = {
    甜: '那个甜是从舌面两侧往回走的，不是入口的甜',
    苦: '苦味出现得快，但化得也快，不会一直停在舌头上',
    涩: '涩感集中在两颊，几秒之后就转成生津',
    香: '香气是往上走的，喝完还能在口腔里停一会儿',
    厚: '汤感是压在舌头上的，不是水一样滑过去',
    稠: '茶汤挂杯明显，转一圈杯壁上有痕迹',
    回甘: '回甘不是马上来的，通常要等十几秒',
    生津: '生津的位置在舌底两侧，越喝越明显',
    喉韵: '咽下去之后喉咙是打开的，有往下走的凉意',
    冰糖: '冰糖甜的特点是干净，没有杂味垫底',
    霸气: '劲道足，前面几泡会比较有冲击力',
    柔: '入口没有棱角，像是顺着喉咙滑下去',
    陈: '陈香是仓储给的，闻起来像老木头的味道',
    果: '果香偏熟果，不是那种很冲的香精味',
    花: '花香比较细，要温杯之后才闻得清楚',
    蜜: '蜜香偏甜，和汤里的甜是两回事',
    兰: '兰花香是清冷的方向，不甜腻',
    烟: '轻微的烟韵是工艺带来的，不是焦味',
    野: '带一点野气，说明茶树生长的环境比较原始',
    岩: '有类似矿石的底味，这跟土壤关系很大',
    胶: '胶质感明显，喝起来有点厚度',
    水: '水路细，喝下去没有粗糙的感觉',
    韵: '余韵长，喝完过几分钟嘴里还有味道',
    醇: '汤感醇和，刺激感低，适合慢慢喝',
    滑: '入口顺滑，没有明显的收敛感',
    浓: '浓度高，出汤时间要往后压',
    鲜: '新茶的鲜爽感明显，前几泡最突出',
  };
  for (const key of Object.keys(MAP)) {
    if (String(t).includes(key)) return MAP[key];
  }
  return '这个感觉要多泡几次才抓得准，一般在第三泡之后最明显';
}

/* --------------------------- 事实扩写 --------------------------- */

function factClusters(ctx) {
  const out = [];
  const mountain = ctx.mountain || {};
  const product = ctx.product || {};
  const r = ctx.r;
  const name = mountain.name || product.name || '这款茶';

  (mountain.taste || []).forEach((t) => {
    out.push({
      key: `taste:${t}`,
      tags: ['tasting', 'product', 'terroir', 'compare'],
      lines: [L(`${name}的${t}，我具体说一下是什么感觉。`), L(`${tasteExplain(t)}。`), T(r, 'tasteTail')],
    });
  });

  (mountain.aroma || []).forEach((a) => {
    out.push({
      key: `aroma:${a}`,
      tags: ['tasting', 'terroir', 'mountain-profile'],
      lines: [
        L(`香气上主要是${a}。`),
        L('闻香有个顺序：先闻干的，温杯投茶之后再闻热的，最后闻杯底的挂杯香。'),
        L(`${a}这个方向冷下来之后会淡一些，这是正常的。`),
      ],
    });
  });

  if (mountain.soup) {
    out.push({
      key: 'soup',
      tags: ['tasting', 'product'],
      lines: [
        L(`汤色是${clean(mountain.soup)}。`),
        L('汤色能看出两件事：原料干不干净，仓储有没有问题。'),
        L('浑浊、发暗的汤色，要么是工艺没做好，要么是仓储受了潮。'),
      ],
    });
  }

  if (mountain.leaf) {
    out.push({
      key: 'leaf',
      tags: ['tasting', 'craft', 'proof'],
      lines: [
        L(`泡开以后看叶底，${clean(mountain.leaf)}。`),
        L('叶底是最难造假的，它藏不住树龄和工艺。'),
        L('店家愿意让你看叶底，基本可以放心一半。'),
      ],
    });
  }

  (mountain.pitfalls || []).forEach((p) => {
    out.push({
      key: `pitfall:${p}`,
      tags: ['pitfall', 'faq', 'proof'],
      lines: [L(`再说一个要提醒你的点：${clean(p)}。`), T(r, 'advice'), T(r, 'warn2')],
    });
  });

  (mountain.sellingPoints || []).forEach((s) => {
    out.push({
      key: `sell:${s}`,
      tags: ['product', 'tasting', 'price'],
      lines: [L(`${clean(s)}。`), T(r, 'insight'), T(r, 'trust')],
    });
  });

  if (mountain.terroir) {
    out.push({
      key: 'terroir-deep',
      tags: ['terroir', 'mountain-profile', 'knowledge'],
      lines: [
        L(`把${name}的山场再讲细一点：${clean(mountain.terroir)}。`),
        L('山场不是玄学，它最后都会落到你嘴里的感受上。'),
        L('同一条山脉，隔一道山梁，味道就可能完全是两个方向。'),
      ],
    });
  }

  if (mountain.altitude) {
    out.push({
      key: 'altitude',
      tags: ['mountain-profile', 'terroir', 'knowledge'],
      lines: [
        L(`海拔${clean(mountain.altitude)}，这个高度对茶影响很大。`),
        L('海拔高的地方气温低，芽叶长得慢，长得慢就意味着物质积累更充分。'),
        L('所以同一品种，高山茶和小树茶喝起来厚度是两回事。'),
      ],
    });
  }

  if (mountain.treeAge || mountain.treeType) {
    out.push({
      key: 'treeage',
      tags: ['mountain-profile', 'terroir', 'knowledge', 'craft'],
      lines: [
        L(`树种和树龄这块，${[mountain.treeType, mountain.treeAge].filter(Boolean).map(clean).join('，')}。`),
        L('树龄影响的是耐泡度和汤感的厚度，不是香气的高低。'),
        L('所以别被「老树」两个字直接带走，还是要喝。'),
      ],
    });
  }

  if (mountain.soil) {
    out.push({
      key: 'soil',
      tags: ['terroir', 'mountain-profile'],
      lines: [
        L(`土壤是${clean(mountain.soil)}。`),
        L('土壤决定了茶树能吸到什么矿物质，这东西最后会体现在汤的底味上。'),
        L('这也是为什么同样工艺，不同山头的茶味道走得不一样。'),
      ],
    });
  }

  if (mountain.brewTips) {
    out.push({
      key: 'brew',
      tags: ['brewing', 'faq', 'product'],
      lines: [
        L(`冲泡参数我再说一遍：${clean(mountain.brewTips)}。`),
        L('第一泡快出汤，是为了醒茶，不喝。'),
        L('觉得太浓先减少投茶量，不要靠缩短时间硬压。'),
      ],
    });
  }

  if (mountain.grade) {
    out.push({
      key: 'grade',
      tags: ['mountain-profile', 'price', 'compare'],
      lines: [
        L(`市场定位上，${name}属于${clean(mountain.grade)}。`),
        L('定位高意味着价格区间宽，也意味着冒充的多。'),
        T(r, 'advice'),
      ],
    });
  }

  (ctx.relatedProducts || []).slice(0, 6).forEach((item) => {
    const leads = [
      `顺带讲一个常识——${item.name}：`,
      `说到这儿补一句，${item.name}这回事是这样的：`,
      `再讲个你可能没注意的点，${item.name}：`,
      `这里插一句常识，${item.name}——`,
    ];
    (item.points || []).slice(0, 3).forEach((point, pi) => {
      out.push({
        key: `kp:${item.id}:${pi}`,
        tags: pi === 0 ? ['knowledge', 'faq', 'craft', 'compare'] : ['knowledge', 'craft'],
        lines: [
          L(`${pick(r, leads)}${clean(point)}。`),
          pi === 0 && item.summary ? L(`${clean(item.summary)}。`) : T(r, 'knowledge'),
          T(r, 'knowledge'),
        ],
      });
    });
  });

  if (ctx.relatedProducts?.length) {
    out.push({
      key: 'kp:summary',
      tags: ['knowledge', 'faq', 'any'],
      lines: [
        L('刚才这几个常识，比今晚卖什么更重要。'),
        L('你把这些记住了，以后在哪儿买茶都不容易被绕。'),
        T(r, 'knowledge'),
      ],
    });
  }

  /* 同产区横向对比：直播里「拿邻居做参照」既好讲又容易被记住。
     标签放宽到 any，否则没有 compare / knowledge 段落的场次用不上这些内容。 */
  const peers = (ctx.kb?.mountains || [])
    .filter((p) => p.id !== mountain.id && p.region && p.region === mountain.region)
    .slice(0, 6);
  const PEER_TAGS = ['compare', 'terroir', 'knowledge', 'mountain-profile', 'product', 'faq', 'any'];

  peers.forEach((peer) => {
    const mineTaste = (mountain.taste || []).slice(0, 2).join('、') || '汤感顺滑';
    const peerTaste = (peer.taste || []).slice(0, 2).join('、') || '风格另走一路';
    out.push({
      key: `peer:${peer.id}`,
      tags: PEER_TAGS,
      lines: [
        L(`同产区还有${peer.name}，风格和${name}不是一个方向。`),
        L(`${peer.name}偏${peerTaste}；${name}偏${mineTaste}，这就是山场差别。`),
        peer.priceRange
          ? L(`价格上${peer.name}大概是${clean(peer.priceRange)}，你可以横向比一下。`)
          : L('两个都喝过之后，你自己就能分出偏好。'),
        T(r, 'insight'),
      ],
    });
  });

  peers.slice(0, 4).forEach((peer) => {
    if (peer.terroir) {
      out.push({
        key: `peer-terroir:${peer.id}`,
        tags: PEER_TAGS,
        lines: [
          L(`顺便说下${peer.name}的山场：${clean(peer.terroir)}。`),
          L(`所以${peer.name}喝起来是${(peer.taste || []).join('、') || '另一个方向'}。`),
          T(r, 'knowledge'),
        ],
      });
    }
    if (peer.pitfalls?.length) {
      out.push({
        key: `peer-pitfall:${peer.id}`,
        tags: ['compare', 'pitfall', 'knowledge', 'faq', 'product', 'any'],
        lines: [
          L(`买${peer.name}同样要注意：${clean(peer.pitfalls[0])}。`),
          L('同一个产区的坑往往是相似的，你学会一个就能套用。'),
          T(r, 'advice'),
        ],
      });
    }
    if (peer.brewTips) {
      out.push({
        key: `peer-brew:${peer.id}`,
        tags: ['brewing', 'compare', 'knowledge', 'faq', 'product', 'any'],
        lines: [
          L(`冲泡上${peer.name}是${clean(peer.brewTips)}。`),
          L('不同山头的出汤节奏要微调，这个得自己试两次。'),
          T(r, 'knowledge'),
        ],
      });
    }
  });

  return out;
}

/* --------------------------- 通用节拍 --------------------------- */

function beatClusters(ctx) {
  const r = ctx.r;
  const meta = ctx.meta;
  const product = ctx.product || {};
  const mountain = ctx.mountain || {};
  const price = product.price;
  const out = [];

  const add = (key, tags, lines) => out.push({ key, tags, lines: lines.filter((l) => l && l.text) });

  add('beat:intro', ['cover', 'hook', 'agenda'], [
    L(`我是${meta.host}，做茶这些年，最怕的就是把话说满。`),
    L('今晚我只讲我确定的东西，不确定的我会直接说不确定。'),
  ]);

  add('beat:interact-1', ['any'], [L(pick(r, TAIL.interact)), L('看到我会念出来，不用刷屏。')]);
  add('beat:interact-2', ['any'], [L(pick(r, TAIL.invite)), T(r, 'advice')]);

  add('beat:imagine', ['tasting', 'product', 'terroir'], [
    L('你现在没法隔着屏幕喝到，我描述一下：'),
    L('茶汤入口先是有点收敛，然后从舌根往回泛甜，喉咙那块是打开的。'),
    L('你按这个感觉去找，喝到类似的就是对的。'),
  ]);

  add('beat:scene', ['any', 'product'], [L(pick(r, TAIL.scene)), L('不需要什么仪式感，盖碗加一壶开水就够了。')]);

  add('beat:compare-drink', ['price', 'urgency'], [
    L('我们换个算法：一杯奶茶现在多少钱？一杯咖啡多少钱？'),
    L(pick(r, TAIL.analogy)),
    L('我不是说别喝奶茶，只是这笔钱花在哪儿，你可以自己算。'),
  ]);

  add('beat:value', ['price'], [
    L('价格这件事我一直是明着来的。'),
    L('原料成本、加工、仓储、运费，加起大概是什么数，我心里清楚。'),
    L('我能给你的价格，是算得过来的价格。'),
  ]);

  add('beat:after-sale', ['cta', 'faq', 'proof', 'any'], [
    L('售后我说清楚：收到七天之内，不满意可以直接退。'),
    L('不用编理由，说一句「喝不惯」就行。'),
    L('我宁愿你退回来，也不想你留着一饼不喜欢的茶。'),
  ]);

  add('beat:storage', ['faq', 'knowledge', 'proof'], [
    L('存茶这件事没有想象中复杂。'),
    L('避光、通风、无异味、湿度别太高，放纸箱里就行。'),
    L('别放冰箱，别和有味道的东西放一起，这两条记住就够了。'),
  ]);

  add('beat:newbie', ['faq', 'knowledge', 'any'], [
    L('新手我多讲一句：不要一上来就买贵的。'),
    L('先买一饼口粮茶，把泡法练熟，再往上加预算。'),
    L('不然好茶你也喝不出好来，那钱就白花了。'),
  ]);

  add('beat:experience', ['credibility', 'any', 'pitfall'], [
    L(
      pick(r, [
        '我自己刚入行的时候也买过假茶，花了钱还不好意思说。',
        '以前我也信过包装上的话，后来才发现包装最容易做。',
        '头几年我也追过名头，交了不少学费才明白要看原料。',
      ])
    ),
    L('所以现在我看茶只看三件事：原料、工艺、仓储。'),
    L('包装好不好看，排在这三件事后面。'),
  ]);

  add('beat:time', ['any'], [
    L('时间差不多了，我把节奏收一下。'),
    L('还想细讲的部分，我等下再展开。'),
  ]);

  add('beat:follow', ['cta', 'end', 'any'], [
    L('觉得今晚讲得实在的，点个关注。'),
    L('我这边固定开播，讲的都是能自己验证的东西。'),
    L('下一场我会提前在主页发预告。'),
  ]);

  add('beat:quality', ['proof', 'product', 'cta'], [
    L('我再说一次我这边的标准：原料说得清、工艺不糊弄、仓储没毛病。'),
    L('这三条有一条不满足，这茶就不会出现在我这儿。'),
    L('我不敢说别的地方怎么样，我只能保证我这边的标准。'),
  ]);

  add('beat:gift-scene', ['product', 'price', 'faq'], [
    L('送人这块也讲一句。'),
    L('送茶最怕的是对方不懂，白瞎了东西。'),
    L('建议附一张原料信息卡，把产区、年份、泡法写上，收礼的人才有感觉。'),
  ]);

  add('beat:craft-detail', ['craft', 'knowledge'], [
    L('工艺这块最容易偷工减料的是干燥。'),
    L('晒青和烘青成本差很多，喝起来也是两回事。'),
    L('晒青的茶有活性、放得住；烘青香是高，但后面没什么变化。'),
  ]);

  add('beat:ask-back', ['faq', 'pitfall', 'any'], [
    L('我反过来问一句：你们平时怎么判断一饼茶值不值？'),
    L('打在评论区，我挑几个说说我的看法。'),
  ]);

  if (price) {
    add('beat:price-anchor', ['price', 'urgency'], [
      L(`这个价格是${price}，直播间期间有效。`),
      L('活动结束我就恢复日常价，不会一直挂着。'),
      L('我也不会搞虚假倒计时，卖完就是卖完。'),
    ]);
  }

  if (mountain.audience?.length) {
    add('beat:audience', ['product', 'faq'], [
      L(`这款茶比较适合${mountain.audience.join('、')}。`),
      L('如果你不属于这几类，也不用勉强，喝茶是自己舒服最重要。'),
    ]);
  }

  add('beat:water', ['brewing', 'knowledge', 'faq'], [
    L('水质对味道的影响，比很多人想的大。'),
    L('硬水会把香气压住，泡出来发闷；能用矿泉水就别用自来水。'),
    L('实在只有自来水，至少烧开放凉一分钟再用。'),
  ]);

  add('beat:vessel', ['brewing', 'knowledge'], [
    L('器具不用讲究。盖碗最方便，也最能反映茶本来的味道。'),
    L('紫砂壶会把香气收掉一点，但汤会更顺，看你喜欢哪个方向。'),
    L('玻璃杯也能泡，就是出汤不好控制，容易闷苦。'),
  ]);

  add('beat:raw-ripe', ['knowledge', 'faq', 'compare'], [
    L('生普和熟普的区别，一句话说清楚：生普靠时间转化，熟普靠工艺发酵。'),
    L('生普新的时候偏鲜爽，放几年往陈香走；熟普出厂就温和，适合马上喝。'),
    L('两个没有高下，只有习惯问题。'),
  ]);

  add('beat:vintage', ['knowledge', 'faq', 'proof'], [
    L('年份这块我提醒一句：不是越老越好。'),
    L('老茶的前提是当年工艺过关、仓储干净，否则放十年也只是变旧。'),
    L('所以有人拿「老」当卖点，你先问它这些年存在哪儿。'),
  ]);

  add('beat:humidity', ['knowledge', 'proof', 'faq'], [
    L('仓储最容易出问题的是湿度。'),
    L('太干转化慢，太湿容易长霉，中间那个区间才舒服。'),
    L('你收到茶如果闻着有霉味或者仓味很冲，直接退，别犹豫。'),
  ]);

  add('beat:packing', ['cta', 'faq', 'product'], [
    L('包装和物流我也说一下。'),
    L('茶饼会先用食品级纸包好，再加防撞，外面纸箱。'),
    L('路上压到的概率很低，万一有破损拍照片给我，直接补发。'),
  ]);

  add('beat:recap', ['any'], [
    L('这一段我小结一下，方便你记。'),
    L('核心就一句话：形制可以模仿，味道模仿不了。'),
  ]);

  add('beat:transition', ['any'], [
    L('接下来这块比较关键，我讲慢一点。'),
    L('你可以把这段记下来，回头验证我说的对不对。'),
  ]);

  add('beat:slow', ['any', 'price'], [
    L('不着急下单，先听我说完。'),
    L('买茶这件事，冲动买的基本都会后悔。'),
  ]);

  add('beat:question', ['faq', 'any'], [
    L('我猜有人想问：为什么同款的茶，别家能便宜那么多？'),
    L('这个问题很好回答，你把两饼茶泡开看叶底就知道了。'),
  ]);

  add('beat:gift-package', ['product', 'price'], [
    L('需要礼盒装的提前跟我说一声，我这边可以配。'),
    L('礼盒不加价，但要单独打包，发货会晚一天。'),
  ]);

  add('beat:repeat-buy', ['cta', 'thanks'], [
    L('老客这边我记着，复购直接说上次买的哪款就行。'),
    L('不用重新介绍，我知道你要的是什么方向。'),
  ]);

  add('beat:honest-limit', ['proof', 'any'], [
    L('有一点我必须实话实说：我没法保证你喝到的和我喝到的一模一样。'),
    L('运输、水质、泡法都会影响感受，这是茶的特性。'),
    L('我能保证的是原料和批次没换，剩下那部分靠你自己调。'),
  ]);

  add('beat:budget', ['price', 'product', 'faq'], [
    L('预算这块我给个参考，不同价位追求的东西不一样。'),
    L('口粮价位先求稳定和干净，往上再求厚度和层次。'),
    L('别一步跨太大，舌头跟不上，钱也浪费。'),
  ]);

  add('beat:compare-same', ['compare', 'price', 'knowledge'], [
    L('同价位的茶怎么选？我一般先看原料等级，再看工艺稳定性。'),
    L('两个都差不多的时候，选仓储更干净的那个。'),
    L('品牌和包装放在最后考虑，它们不代表茶本身。'),
  ]);

  add('beat:season', ['knowledge', 'faq', 'craft'], [
    L('春茶、秋茶的区别，喝起来是能分的。'),
    L('春茶内含物质足，汤感厚、耐泡；秋茶香气高一些，但厚度差一点。'),
    L('不是说秋茶不好，是方向不一样，看你想要什么。'),
  ]);

  add('beat:listen', ['any', 'tasting'], [
    L('你现在如果不方便说话，就先听，回头再看回放。'),
    L('我讲的内容整理一下还是有用的，不用非得当场决定。'),
  ]);

  add('beat:honest-price', ['price', 'proof'], [
    L('贵的茶不一定适合你，便宜的也不一定差。'),
    L('关键是这个价位对应的是什么原料，说清楚了就不算贵。'),
    L('我最怕的是花了大价钱买了个故事。'),
  ]);

  add('beat:order-steps', ['cta'], [
    L('下单流程我说一遍，避免手忙脚乱。'),
    L('先点购物车，选规格，确认地址，最后提交。'),
    L('有赠品的记得在备注里写一下，不然可能会漏。'),
  ]);

  add('beat:first-cup', ['tasting', 'brewing', 'any'], [
    L('我教你一个判断的方法：第一口先含着，别急着咽。'),
    L('让茶汤在舌面上停两秒，注意两侧和舌根的变化。'),
    L('好的茶，苦和涩都是会走掉的。'),
  ]);

  return out;
}

/* --------------------------- 扩展选择 --------------------------- */

/** 多趟生成内容池：每趟换一个随机种子，让带变体的句子产生不同说法。 */
export function buildPool(ctx, passes = 3) {
  const pool = [];
  for (let i = 0; i < passes; i++) {
    const c = i === 0 ? ctx : { ...ctx, r: makeRng(`${ctx.meta?.seed || 'seed'}|alt${i}`) };
    const part = [...factClusters(c), ...beatClusters(c)];
    for (const cluster of part) pool.push({ ...cluster, key: `${cluster.key}#${i}` });
  }
  return pool;
}

/**
 * 从池里挑段落补字数。
 * 关键点：
 *  - 只接受与当前段落标签有交集的簇，或标了 any 的通用簇（避免串味）
 *  - 去重必须逐行做：不同簇之间常常只有收尾句相同，
 *    整簇比对会漏掉这种重叠，导致同一页出现重复句
 *  - 段落完整性守卫：剩下不到一半新句子时整簇丢弃，避免半截段落
 */
function pickFromPool(pool, slide, usedKeys, usedTexts, needChars) {
  const tags = new Set([slide.sectionId, slide.type, 'any']);
  const candidates = pool
    .filter((c) => !usedKeys.has(c.key))
    .map((c) => {
      const overlap = c.tags.filter((t) => tags.has(t)).length;
      const isAny = c.tags.includes('any');
      if (!overlap && !isAny) return null;
      return { c, score: overlap * 3 + (isAny ? 0.5 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const out = [];
  let n = 0;
  for (const { c } of candidates) {
    if (usedKeys.has(c.key)) continue;
    const fresh = usedTexts ? c.lines.filter((l) => !usedTexts.has(l.text)) : c.lines;
    usedKeys.add(c.key);
    if (fresh.length < Math.ceil(c.lines.length / 2)) continue;
    if (usedTexts) fresh.forEach((l) => usedTexts.add(l.text));
    out.push(...fresh);
    n += fresh.reduce((s, l) => s + charCount(l.text), 0);
    if (n >= needChars) break;
  }
  return out;
}

/** 单次扩展（不需要跨调用去重时使用）。 */
export function expandClusters(ctx, slide, needChars, used, opts = {}) {
  if (needChars <= 0) return [];
  const pool = opts.pool || buildPool(ctx, opts.passes || 3);
  return pickFromPool(pool, slide, used || new Set(), null, needChars);
}

/**
 * 每个产品一个扩写器：同一场直播过不同款茶时，通用节拍可以自然地再说一遍，
 * 所以去重表按产品隔离，这样长场次的稿子容量能线性增长。
 */
export function makeExpander(ctx, passes = 4) {
  const pool = buildPool(ctx, passes);
  const usedKeys = new Set();
  const usedTexts = new Set();
  const fn = (slide, needChars) => pickFromPool(pool, slide, usedKeys, usedTexts, needChars);
  /** 把内容块自带的行登记进去重表，否则扩写会再补一遍同样的话。 */
  fn.reserve = (lines) => {
    for (const l of lines || []) if (l?.text) usedTexts.add(l.text);
  };
  return fn;
}
