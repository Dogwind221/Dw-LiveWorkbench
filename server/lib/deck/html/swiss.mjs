/**
 * 风格：瑞士国际主义（Swiss / International Typographic Style）
 *
 * 出处：guizang-ppt-skill 风格 B（`assets/template-swiss.html` 的设计 token +
 * `references/themes-swiss.md` 的 IKB 克莱因蓝 + 样稿 `ppt-lab/design-demos/B-瑞士国际.html`
 * 已定稿的两页，把它的设计语言推广到全部 13 种 type）。
 *
 * 只导出三样东西：meta（元信息）、css（样式）、slide()（一页的 markup）。
 * 舞台 / 翻页 / 缩放 / 打印 / 基准字号由 shell.mjs 提供，这里一律不碰。
 *
 * 本风格的硬规则（违反一条就掉价）：
 *  1) 全程无衬线（Inter / Helvetica / Noto Sans SC / 微软雅黑），没有衬线兜底
 *  2) 一份 deck 只有一个 accent 色（IKB #002FA7）；深色页上不用第二个高亮色，
 *     accent 只以「实心色块」出现（IKB 在近黑底上对比度低，做文字会不可读）
 *  3) 无渐变 / 无阴影 / 无圆角，所有色块直角纯色（分隔线是 1px 直线）
 *  4) 字号极致对比：正文 1.05em / 卡片描述 .95em / 标签 .75em，
 *     巨型序号用 min(cqw,cqh) 顶到 8 倍以上（见下方各版式的 --no）
 *  5) 大字字重 200-300、小字 500-600（越大越细、越小越粗）
 *  6) 卡片填充类型互斥：一组卡片只用一个填充变体，最多允许一张 card-accent
 *  7) 尺寸全部 cqw / cqh / em（外壳的 1.05cqw 基准在 .page 上，所以 .page 内部一律 em）
 */

export const meta = {
  id: 'swiss',
  label: '瑞士国际主义',
  desc: '无衬线 · 12 列网格 · 单一 IKB 克莱因蓝，信息驱动',
  source: 'guizang-ppt-skill 风格 B · 克莱因蓝（template-swiss.html + B-瑞士国际 样稿）',
  swatches: ['#002FA7', '#fafaf8', '#0a0a0a'],
  darkHint: true,
};

export const css = `
/* ══ 设计 token（取自 template-swiss.html 的 :root，只留 IKB 那一套） ══ */
:root{
  --paper:#fafaf8;          /* 主底：高级灰白 */
  --ink:#0a0a0a;            /* 文字主色：近黑 */
  --ink-2:#525252;          /* 次级文字（6.9:1 on paper） */
  --ink-3:#6b6b6b;          /* 标签/注释（5.1:1 on paper，4.7:1 on grey-1） */
  --grey-1:#f0f0ee; --grey-2:#d4d4d2; --grey-3:#6b6b6b;
  --accent:#002FA7;         /* 唯一强调色：克莱因蓝 */
  --accent-on:#ffffff;      /* accent 上的反色文字（10.7:1） */
  --rule:#d4d4d2;           /* 发丝分割线 */
  --tea:#002FA7;            /* 外壳的进度点/标题短线走同一个 accent */
  --font-mix:"Inter","Helvetica Neue",Helvetica,Arial,"Segoe UI Variable Text","Segoe UI",system-ui,
    "Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;
  --font-mono:"JetBrains Mono","IBM Plex Mono","Cascadia Mono",Consolas,"Courier New",ui-monospace,monospace;
  --font-sans:"Inter","Helvetica Neue",Helvetica,Arial,"Segoe UI",system-ui,sans-serif;
}

/* ══ 页面底色与明暗节奏 ══ */
.slide{font-family:var(--font-mix);color:var(--ink)}
.slide.grey{background:var(--grey-1)}
.slide.dark{background:var(--ink);color:var(--paper);--ink-2:#c9c9c6;--ink-3:#9a9a97;--rule:#2b2b2b}
.slide.accent{background:var(--accent);color:var(--accent-on);
  --ink-2:#e9edfb;--ink-3:#d5dbf7;--rule:rgba(255,255,255,.34)}
/* 深色页左缘的 IKB 立边：整份 deck 的深色页共用一条竖脊（大色块，不用渐变） */
.slide.dark .page::after{content:"";position:absolute;left:0;top:0;bottom:0;width:2.2cqw;
  background:var(--accent);pointer-events:none}

/* ══ 页眉：眉标 / 大标题 / 分割线 / 副标题 ══ */
.kicker{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.18em;
  color:var(--ink-3);gap:.7em}
.kicker i{width:.4em;height:.4em;border-radius:0;background:var(--accent)}
.slide.dark .kicker i{background:var(--paper)}
.slide.dark .kicker{color:var(--ink-3)}
.s-title{font-size:min(3.2cqw,5.6cqh);font-weight:300;line-height:1.06;letter-spacing:-.02em;
  color:var(--ink);margin:.55em 0 0}
/* 深色/满屏 accent 页上标题必须反色，否则近黑底上的近黑字对比度 = 1:1（实测踩过） */
.slide.dark .s-title{color:var(--paper)}
.slide.accent .s-title{color:var(--accent-on)}
.rule{margin:1.05em 0 0;height:1px;background:var(--rule)}
.slide .rule i{top:-1px;width:3.2em;height:3px;background:var(--accent)}
.slide.dark .rule i{background:var(--paper)}
.s-sub{font-size:.95em;line-height:1.5;color:var(--ink-2);margin-top:.75em}
.body{margin-top:1.35em}
/* 页脚：外壳承载结构，这里只调对齐（左 6.4cqw 与正文同一条竖轴）与字号下限 */
.slide .foot{left:6.4cqw;right:6.4cqw;bottom:2.8cqh;padding-top:1.2cqh;font-size:.75em;
  letter-spacing:.1em;color:var(--ink-3);border-top:1px solid var(--rule)}

/* ══ 12 列模块网格（瑞士风核心） ══ */
.grid-12{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:2.4cqh 1.2cqw;align-items:stretch}
.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}
.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}

/* ══ 卡片：填充类型互斥（一组卡片只用一个变体，最多一张 accent） ══
   照 template-swiss.html 的 .sub-grid-3-2 骨架：卡片等高铺满内容区，
   编号在格子顶部、描述沉到格子底部（margin-top:auto），靠对齐而不是装饰撑起网格感。 */
.cards{flex:1;min-height:0;align-content:stretch;grid-auto-rows:minmax(0,1fr)}
.card{display:flex;flex-direction:column;min-width:0;padding:1.5em 1.4em}
.card-fill{background:var(--grey-1);color:var(--ink)}
.slide.grey .card-fill{background:#fff}
.card-accent{background:var(--accent);color:var(--accent-on)}
.card-ink{background:var(--ink);color:var(--paper)}
.card-outlined{background:transparent;border:1px solid var(--grey-2)}
.card-no{font-weight:200;font-size:var(--no,4cqw);line-height:.86;letter-spacing:-.05em;
  color:var(--ink);font-variant-numeric:tabular-nums}
.card-t{font-size:1.05em;font-weight:600;line-height:1.3;color:var(--ink);margin-top:.85em}
.card-d{font-size:.95em;line-height:1.55;color:var(--ink-2);margin-top:auto;padding-top:.6em}
.card-accent .card-no{color:rgba(255,255,255,.72)}
.card-accent .card-t{color:var(--accent-on)}
.card-accent .card-d{color:rgba(255,255,255,.88)}

/* ══ 要点台账（巨型序号，S20）：纵向账单式大字，行等分铺满内容区 ══ */
.plist{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
  border-bottom:1px solid var(--rule)}
.pitem{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1.7cqw;align-items:center;
  border-top:1px solid var(--rule);padding:.9em 0;flex:1 1 auto;min-height:0}
.pno{font-weight:200;font-size:var(--no,6cqw);line-height:.88;letter-spacing:-.05em;
  color:var(--ink);font-variant-numeric:tabular-nums}
.pno.hot{color:var(--accent)}
.ptx{font-size:1.05em;line-height:1.45;color:var(--ink-2)}

/* ══ 金句 / 页脚注 ══ */
.quote{flex:none;margin-top:1.5em;background:var(--ink);color:var(--paper);padding:1em 1.3em;
  font-size:1.05em;line-height:1.5;font-weight:400}
.slide.dark .quote{background:var(--grey-1);color:var(--ink)}
.fnote{flex:none;margin-top:1.4em;padding-top:.85em;border-top:1px solid var(--rule);
  font-size:.95em;line-height:1.5;color:var(--ink-3)}

/* ══ 清单（标签 / 值，S21） ══ */
.rows{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
  border-bottom:1px solid var(--rule)}
.row{display:grid;grid-template-columns:minmax(0,4.8em) minmax(0,1fr);gap:1.6cqw;align-items:center;
  border-top:1px solid var(--rule);padding:1.1em 0;flex:1 1 auto;min-height:0}
.rk{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.16em;color:var(--ink-3)}
.rv{font-size:1.05em;line-height:1.45;color:var(--ink)}

/* ══ 对比（S08）：两列 + 中线，只有「本品」这一侧是 accent ══ */
.cmp{flex:1;min-height:0}
.cmp .col{display:flex;flex-direction:column;min-width:0}
.cmp .col.b{padding-left:2.2cqw;border-left:1px solid var(--rule)}
.ch{flex:none;font-size:1.1em;font-weight:600;line-height:1.3;padding:.95em 1.1em}
.ch.a{background:var(--accent);color:var(--accent-on)}
.ch.b{background:var(--grey-1);color:var(--ink)}
.cmp ul{list-style:none;margin:0;padding:0;flex:1;min-height:0;display:flex;flex-direction:column}
.cmp li{position:relative;display:flex;align-items:center;flex:1 1 auto;min-height:0;
  padding:.85em 0 .85em 1.5em;border-top:1px solid var(--rule);
  font-size:1.02em;line-height:1.5;color:var(--ink-2)}
.cmp li::before{content:"";position:absolute;left:0;top:50%;width:.42em;height:.42em;
  transform:translateY(-50%);background:var(--accent)}
.cmp .col.b li::before{background:var(--ink-3)}

/* ══ 步骤（横向时间线，S11）：轴在序号与文字之间，四个节点共用一根线 ══ */
.timeline-h{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.th-row{display:grid;gap:0}
.th-node{min-width:0;padding-right:1.6cqw}
.th-no{font-weight:200;font-size:var(--no,6cqw);line-height:.9;letter-spacing:-.05em;
  color:var(--ink);font-variant-numeric:tabular-nums}
.th-node.accent .th-no{color:var(--accent)}
.th-axis{position:relative;height:.7em;margin:1.1em 0}
.th-axis::before{content:"";position:absolute;left:0;right:-1.6cqw;top:50%;height:1px;
  transform:translateY(-50%);background:var(--rule)}
.th-dot{position:absolute;left:0;top:50%;width:.7em;height:.7em;transform:translateY(-50%);
  background:var(--ink)}
.th-node.accent .th-dot{background:var(--accent)}
.th-t{font-size:1.05em;font-weight:600;line-height:1.3;color:var(--ink)}
.th-d{font-size:.95em;line-height:1.5;color:var(--ink-2);margin-top:.45em}

/* ══ 答疑：问句序号即显示级元素 ══ */
.faqs{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
  border-bottom:1px solid var(--rule)}
.faq{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1.6cqw;align-items:center;
  border-top:1px solid var(--rule);padding:1em 0;flex:1 1 auto;min-height:0}
.fq-no{font-weight:200;font-size:var(--no,3cqw);line-height:1.05;letter-spacing:-.04em;
  color:var(--ink);font-variant-numeric:tabular-nums}
.fq-no.hot{color:var(--accent)}
.fq-q{font-size:1.05em;font-weight:600;line-height:1.35;color:var(--ink)}
.fq-a{font-size:.95em;line-height:1.55;color:var(--ink-2);margin-top:.4em}

/* ══ 价格（S13）：左 IKB 巨数 + 右锚点台账 ══ */
.price{flex:1;min-height:0}
.pbox{background:var(--accent);color:var(--accent-on);padding:2.2em 1.7em;
  display:flex;flex-direction:column;justify-content:center}
.plab{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.2em;
  color:rgba(255,255,255,.84)}
.pbig{font-size:min(9.6cqw,14.4cqh);font-weight:200;line-height:.94;letter-spacing:-.045em;
  color:var(--accent-on);margin-top:.3em;font-variant-numeric:tabular-nums}
.pwas{font-size:1em;line-height:1.4;color:rgba(255,255,255,.82);text-decoration:line-through;
  margin-top:.9em}
.pright{display:flex;flex-direction:column;justify-content:center;min-width:0}
.anchors{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.6cqh 1.4cqw}
.anchor{border-top:2px solid var(--ink);padding-top:.7em;min-width:0}
.ak{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.14em;color:var(--ink-3)}
.av{font-size:var(--az,2.8cqw);font-weight:200;line-height:1.05;letter-spacing:-.035em;
  color:var(--ink);margin-top:.25em;font-variant-numeric:tabular-nums}
.pbul{margin-top:1.8em;display:flex;flex-direction:column;gap:.7em}
.pb{position:relative;padding-left:1.5em;font-size:1.02em;line-height:1.5;color:var(--ink-2)}
.pb::before{content:"";position:absolute;left:0;top:.62em;width:.42em;height:.42em;background:var(--accent)}

/* ══ 产品（左要点 + 右清单，S03） ══ */
.prod{flex:1;min-height:0}
.plead{display:flex;flex-direction:column;justify-content:center;min-width:0}
.plab2{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.18em;
  color:var(--ink-3);margin-bottom:1.4em}
.plead ul{list-style:none;margin:0;padding:0}
.plead li{position:relative;padding-left:1.6em;font-size:1.05em;line-height:1.5;
  color:var(--ink-2);margin-bottom:1.1em}
.plead li:last-child{margin-bottom:0}
.plead li::before{content:"";position:absolute;left:0;top:.6em;width:.45em;height:.45em;
  background:var(--accent)}
.pside{display:flex;flex-direction:column;justify-content:center;padding:1.4em 1.5em}
.prow{display:grid;grid-template-columns:minmax(0,4.6em) minmax(0,1fr);gap:.9em;
  border-top:1px solid var(--rule);padding:.7em 0}
.prow:first-child{border-top:0}
.pk{font-family:var(--font-mono);font-size:.75em;font-weight:600;letter-spacing:.1em;color:var(--ink-3)}
.pv{font-size:.95em;line-height:1.45;color:var(--ink)}

/* ══ 行动（深色台账，第一格用 IKB 实心块当焦点） ══ */
.cta{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
  border-bottom:1px solid var(--rule)}
.citem{display:grid;grid-template-columns:auto minmax(0,1fr);gap:1.8cqw;align-items:center;
  border-top:1px solid var(--rule);padding:.85em 0;flex:1 1 auto;min-height:0}
.cno{font-weight:200;font-size:var(--no,6cqw);line-height:.9;letter-spacing:-.05em;
  color:var(--paper);font-variant-numeric:tabular-nums}
.cno.hot{background:var(--accent);color:var(--accent-on);padding:.02em .1em}
.ctx{font-size:1.12em;line-height:1.45;color:var(--paper)}

/* ══ 封面（IKB 满屏） ══ */
.cover-page{justify-content:flex-start}
.chrome{flex:none;display:flex;justify-content:space-between;gap:2cqw;font-family:var(--font-mono);
  font-size:.75em;font-weight:500;letter-spacing:.16em;color:var(--ink-3)}
.cover-mid{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.cover-title{font-size:var(--cz,min(6.4cqw,11.2cqh));font-weight:300;line-height:1.02;
  letter-spacing:-.03em;color:var(--accent-on);margin-top:.3em}
.cover-rule{width:6.4em;height:4px;background:var(--accent-on);margin:1.1em 0 .9em}
.cover-sub{font-size:1.15em;line-height:1.45;color:var(--ink-2)}
.cover-foot{flex:none;display:flex;justify-content:space-between;gap:2cqw;
  border-top:1px solid rgba(255,255,255,.34);padding-top:1.4em;font-family:var(--font-mono);
  font-size:.75em;letter-spacing:.14em;color:var(--ink-3)}
/* 出血的年代水印：装饰，aria-hidden，验收工具与读屏都跳过 */
.cover-ghost{position:absolute;right:-.02em;bottom:-.18em;font-size:min(24cqw,24cqh);
  font-weight:200;line-height:.78;letter-spacing:-.06em;color:rgba(255,255,255,.13);
  pointer-events:none;user-select:none}

/* ══ 收尾（深色） ══ */
.end-page{justify-content:flex-start}
.end-mid{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.end-title{font-size:min(9cqw,13.5cqh);font-weight:200;line-height:1.04;letter-spacing:-.035em;
  color:var(--paper)}
.end-rule{width:6.4em;height:4px;background:var(--accent-on);margin:1.1em 0 .9em}
.end-sub{font-size:1.15em;line-height:1.45;color:var(--ink-2)}
.end-bul{flex:none}
.end-b{display:flex;flex-direction:column;gap:.7em;border-top:1px solid var(--rule);
  padding-top:1em;min-width:0}
.end-b i{width:.45em;height:.45em;background:var(--accent)}
.end-b p{font-size:1.02em;line-height:1.5;color:var(--ink-2)}
`;

/* ──────────────────────────────── 渲染 ──────────────────────────────── */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * 中文里的直引号 → 「」。
 * 生成引擎的口播/文案里混着 "压舌" 这种直引号，瑞士风排版里必须换成中文引号；
 * 只在引号紧贴中文时替换，避免动到英文缩写、英寸符号与数字。
 */
const zh = (v) =>
  String(v ?? '')
    .replace(/([\u4e00-\u9fff\u3000-\u303f])"([^"]{0,80})"/g, '$1「$2」')
    .replace(/"([^"]{0,80})"([\u4e00-\u9fff\uff0c\u3002\uff01\uff1f\uff1b\uff1a])/g, '「$1」$2');

/** 正文文本：先修引号再转义 */
const tx = (v) => esc(zh(v));

const pad2 = (i) => String(i + 1).padStart(2, '0');
const slideId = (s) => `s-${String(s.id || s.index).replace(/[^\w-]/g, '')}`;

/** 口播稿落到 data-notes，不显示在页面上；PPTX 的演讲者备注另有管道 */
const notesAttr = (s) =>
  s.script && s.script.length
    ? ` data-notes="${esc(s.script.map((l) => (l.cue ? `〔${l.cue}〕` : '') + (l.text || '')).join('\n'))}"`
    : '';

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

const open = (s, cls, layout, opts = {}) => {
  const plain = opts.plain ?? !s.kicker;
  return `<section class="slide ${cls}${plain ? ' plain' : ''}" data-slide-id="${slideId(s)}" data-type="${esc(
    s.type
  )}" data-layout="${esc(layout)}"${opts.attrs || ''}${notesAttr(s)}>`;
};

const page = (inner) => `<div class="page">${inner}</div>`;

/** 页眉：kicker 为空串时**不要**回退成别的文字（外壳会把标题上移）。
 *  眉标只放一个标签：品牌已经在页脚，重复一遍既啰嗦、转 PPTX 时又会和标签
 *  并成同一个文本框（契约 §3.9：靠 flex gap 拉开的多段文字转出来会粘在一起）。 */
function head(s, ctx) {
  const k = `<div class="kicker">${s.kicker ? '<i></i>' : ''}<span>${tx(s.kicker || '')}</span></div>`;
  const sub = s.subtitle ? `<div class="s-sub">${tx(s.subtitle)}</div>` : '';
  return `${k}<h2 class="s-title">${tx(s.title)}</h2><div class="rule"><i></i></div>${sub}`;
}

/** 页脚：不带页码（页码由外壳的圆点承载），只放品牌 · 段落 · 茶品 */
function foot(s, ctx) {
  const left = arr([ctx.deck?.meta?.brand, s.sectionTitle]).join(' · ');
  const right = s.productName && (ctx.deck?.meta?.productCount || 0) > 1 ? s.productName : '';
  return `<div class="foot"><span>${tx(left)}</span><span>${tx(right)}</span></div>`;
}

const fnote = (v) => (v ? `<div class="fnote">${tx(v)}</div>` : '');
const quoteBlock = (q) => (q ? `<div class="quote">${tx(q)}</div>` : '');

/* ── 卡片：hook / cards / tasting 共用 ────────────────────────────────
   一组卡片只用一个填充变体（card-fill），最多把其中一张换成 card-accent；
   卡片序号是显示级元素，用 min(cqw,cqh) 顶到极致字号对比。 */
function cardsBlock(s, accentAt = -1) {
  const cards = arr(s.cards);
  const n = cards.length || 1;
  const cols = n <= 2 ? 2 : n === 3 ? 3 : n === 4 ? 2 : n <= 6 ? 3 : 4;
  const span = cols === 2 ? 6 : cols === 3 ? 4 : 3;
  const noSize = cols === 2 ? 'min(6.4cqw,9.6cqh)' : cols === 3 ? 'min(5cqw,7.4cqh)' : 'min(3.8cqw,5.7cqh)';
  const grid = `<div class="grid-12 cards" style="--no:${noSize}">${cards
    .map(
      (c, i) =>
        `<article class="card span-${span} ${i === accentAt ? 'card-accent' : 'card-fill'}">` +
        `<div class="card-no">${pad2(i)}</div>` +
        `<h4 class="card-t">${tx(c.title)}</h4>` +
        `<p class="card-d">${tx(c.desc)}</p></article>`
    )
    .join('')}</div>`;
  return grid + quoteBlock(s.quote);
}

/* ── 要点：纵向巨数台账（S20） ─────────────────────────────────────── */
function pointsBlock(s) {
  const items = arr(s.bullets);
  const n = items.length;
  const noSize = n <= 4 ? 'min(9.6cqw,14.4cqh)' : n <= 6 ? 'min(5.4cqw,7.9cqh)' : 'min(4.2cqw,6.1cqh)';
  const list = `<div class="plist" style="--no:${noSize}">${items
    .map(
      (t, i) =>
        `<div class="pitem"><div class="pno${i === 0 ? ' hot' : ''}">${pad2(i)}</div>` +
        `<p class="ptx">${tx(t)}</p></div>`
    )
    .join('')}</div>`;
  return list + quoteBlock(s.quote) + fnote(s.footnote);
}

/* ── 清单：标签 / 值 两列台账（S21） ───────────────────────────────── */
function tableBlock(s) {
  const rows = arr(s.table?.rows);
  const body = `<div class="rows">${rows
    .map((r) => `<div class="row"><div class="rk">${tx(r[0])}</div><div class="rv">${tx(r[1])}</div></div>`)
    .join('')}</div>`;
  return body + fnote(s.footnote);
}

/* ── 对比：两列 + 中线（S08） ──────────────────────────────────────── */
function compareBlock(s) {
  const col = (side, cls) =>
    side
      ? `<section class="col span-6 ${cls}"><header class="ch ${cls}">${tx(side.title)}</header><ul>${arr(
          side.items
        )
          .map((i) => `<li>${tx(i)}</li>`)
          .join('')}</ul></section>`
      : '';
  return `<div class="cmp grid-12">${col(s.left, 'a')}${col(s.right, 'b')}</div>`;
}

/* ── 步骤：横向时间线（S11） ───────────────────────────────────────── */
function stepsBlock(s) {
  const steps = arr(s.steps);
  const n = steps.length || 1;
  const noSize = n <= 4 ? 'min(11cqw,16.5cqh)' : n <= 6 ? 'min(9cqw,13.5cqh)' : 'min(6cqw,9cqh)';
  const body = `<div class="timeline-h" style="--no:${noSize}"><div class="th-row" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${steps
    .map(
      (x, i) =>
        `<div class="th-node${i === 0 ? ' accent' : ''}">` +
        `<div class="th-no">${pad2(i)}</div>` +
        `<div class="th-axis"><span class="th-dot"></span></div>` +
        `<h5 class="th-t">${tx(x.title)}</h5><p class="th-d">${tx(x.desc)}</p></div>`
    )
    .join('')}</div></div>`;
  return body + fnote(s.footnote);
}

/* ── 答疑 ─────────────────────────────────────────────────────────── */
function faqBlock(s) {
  const list = arr(s.faq);
  return `<div class="faqs" style="--no:min(2.8cqw,4.2cqh)">${list
    .map(
      (f, i) =>
        `<div class="faq"><div class="fq-no${i === 0 ? ' hot' : ''}">${pad2(i)}</div>` +
        `<div class="fq-bd"><div class="fq-q">${tx(f.q)}</div><div class="fq-a">${tx(f.a)}</div></div></div>`
    )
    .join('')}</div>`;
}

/* ── 价格：左 IKB 巨数 + 右锚点（S13） ─────────────────────────────── */
function priceBlock(s) {
  const anchors = arr(s.anchors);
  const bul = arr(s.bullets);
  return `<div class="grid-12 price">
  <div class="pbox span-6">
    <div class="plab">直播间价格</div>
    ${s.price ? `<div class="pbig">${tx(s.price)}</div>` : ''}
    ${s.comparePrice ? `<div class="pwas">日常价 ${tx(s.comparePrice)}</div>` : ''}
  </div>
  <div class="pright span-6">
    ${
      anchors.length
        ? `<div class="anchors">${anchors
            .map((a) => `<div class="anchor"><div class="ak">${tx(a.label)}</div><div class="av">${tx(a.value)}</div></div>`)
            .join('')}</div>`
        : ''
    }
    ${bul.length ? `<div class="pbul">${bul.map((b) => `<p class="pb">${tx(b)}</p>`).join('')}</div>` : ''}
  </div>
</div>`;
}

/* ── 产品：左要点 + 右清单（S03） ──────────────────────────────────── */
function productBlock(s) {
  const bul = arr(s.bullets);
  const rows = arr(s.table?.rows);
  return `<div class="grid-12 prod">
  <div class="span-7 plead">
    <div class="plab2">要点</div>
    <ul>${bul.map((b) => `<li>${tx(b)}</li>`).join('')}</ul>
  </div>
  <div class="span-5 pside card-fill">
    ${rows
      .map((r) => `<div class="prow"><div class="pk">${tx(r[0])}</div><div class="pv">${tx(r[1])}</div></div>`)
      .join('')}
  </div>
</div>`;
}

/* ── 行动引导（深色台账） ─────────────────────────────────────────── */
function ctaBlock(s) {
  const bul = arr(s.bullets);
  return `<div class="cta" style="--no:min(7.4cqw,11cqh)">${bul
    .map(
      (t, i) =>
        `<div class="citem"><div class="cno${i === 0 ? ' hot' : ''}">${pad2(i)}</div>` +
        `<p class="ctx">${tx(t)}</p></div>`
    )
    .join('')}</div>`;
}

/* ── 封面：IKB 满屏 + 分档限高的中文大标题 ───────────────────────── */
function coverSize(title) {
  const n = [...String(title || '')].length;
  if (n <= 8) return 'min(6.4cqw,11.2cqh)';
  if (n <= 12) return 'min(5.6cqw,9.8cqh)';
  if (n <= 18) return 'min(5cqw,8.8cqh)';
  return 'min(4.6cqw,8.2cqh)';
}

function coverPage(s, ctx) {
  const m = ctx.deck?.meta || {};
  const year = String(m.date || '').slice(0, 4);
  // 封面元信息拼成**两块**（左：主讲 + 时长，右：日期），中间用可见的 · 分隔。
  // 契约 §3.9：同一行靠 gap 拉开的碎片转 PPTX 会并成一个文本框、间隙丢失。
  // s.meta 里本来就带日期，这里剔掉，避免和右侧的日期重复。
  const date = String(m.date || '').trim();
  const left = arr([...arr(s.meta).filter((x) => String(x).trim() !== date), m.durationMin ? `约 ${m.durationMin} 分钟` : '']).join(' · ');
  return `${open(s, 'accent', 'SWISS-COVER', { plain: true })}
  <div class="page cover-page">
    <div class="chrome"><span>${tx(m.brand || '')}</span></div>
    <div class="cover-mid">
      ${s.kicker ? `<div class="kicker"><i></i><span>${tx(s.kicker)}</span></div>` : ''}
      <h1 class="cover-title" style="--cz:${coverSize(s.title)}">${tx(s.title)}</h1>
      <div class="cover-rule"></div>
      ${s.subtitle ? `<div class="cover-sub">${tx(s.subtitle)}</div>` : ''}
    </div>
    <div class="cover-foot"><span>${tx(left)}</span><span>${tx(m.date || '')}</span></div>
    ${year ? `<div class="cover-ghost deco" aria-hidden="true">${esc(year)}</div>` : ''}
  </div>
</section>`;
}

/* ── 收尾（深色） ─────────────────────────────────────────────────── */
function endPage(s, ctx) {
  const bul = arr(s.bullets);
  const m = ctx.deck?.meta || {};
  return `${open(s, 'dark', 'SWISS-CLOSING', { plain: true })}
  <div class="page end-page">
    <div class="chrome"><span>${tx(arr([m.brand, s.kicker]).join(' · '))}</span><span>${tx(m.date || '')}</span></div>
    <div class="end-mid">
      <h2 class="end-title">${tx(s.title)}</h2>
      <div class="end-rule"></div>
      ${s.subtitle ? `<div class="end-sub">${tx(s.subtitle)}</div>` : ''}
    </div>
    ${
      bul.length
        ? `<div class="grid-12 end-bul">${bul
            .map(
              (b, i) =>
                `<div class="span-4 end-b"><i></i><p>${tx(b)}</p></div>`
            )
            .join('')}</div>`
        : ''
    }
  </div>
</section>`;
}

/* ── 未知 type 兜底：按数据形状挑结构，绝不渲染成空白页 ───────────── */
const cardsLayout = (s) => {
  const n = arr(s.cards).length;
  return n === 4 ? 'S19' : n === 3 ? 'S05' : 'S16';
};

function fallback(s) {
  const o = (layout, body, cls = '') => ({ layout, body, cls, attrs: ' data-fallback="1"' });
  if (arr(s.cards).length) return o(cardsLayout(s), cardsBlock(s, s.quote ? -1 : 0));
  if (arr(s.steps).length) return o('S11', stepsBlock(s));
  if (arr(s.faq).length) return o('S20', faqBlock(s));
  if (arr(s.table?.rows).length) return o('S21', tableBlock(s));
  if (s.left || s.right) return o('S08', compareBlock(s));
  if (s.price || arr(s.anchors).length) return o('S13', priceBlock(s));
  if (arr(s.bullets).length) return o('S20', pointsBlock(s));
  // 连正文都没有：用副标题 / 页脚注撑一页陈述，并诚实标出原类型
  const text = s.subtitle || s.footnote || '本页暂无正文内容';
  return o(
    'S03',
    `<div class="plist" style="--no:min(5cqw,7.4cqh)"><div class="pitem">` +
      `<div class="pno hot">01</div><p class="ptx">${tx(text)}</p></div></div>` +
      fnote(`原版式：${s.type || '未标注'}`),
    ''
  );
}

/** 每种 type → 结构（Sxx 登记版式名只做标注，不锁死表达） */
function bodyFor(s) {
  switch (s.type) {
    case 'hook':
      if (arr(s.cards).length) return { layout: 'S05', body: cardsBlock(s, 1), cls: '' };
      break;
    case 'tasting':
      if (arr(s.cards).length) return { layout: 'S19', body: cardsBlock(s, 0), cls: '' };
      break;
    case 'cards':
      if (arr(s.cards).length)
        return { layout: cardsLayout(s), body: cardsBlock(s, s.quote ? -1 : 0), cls: '' };
      break;
    case 'points':
      if (arr(s.bullets).length) return { layout: 'S20', body: pointsBlock(s), cls: '' };
      break;
    case 'table':
      if (arr(s.table?.rows).length) return { layout: 'S21', body: tableBlock(s), cls: '' };
      break;
    case 'compare':
      if (s.left || s.right) return { layout: 'S08', body: compareBlock(s), cls: '' };
      break;
    case 'steps':
      if (arr(s.steps).length) return { layout: 'S11', body: stepsBlock(s), cls: '' };
      break;
    case 'faq':
      if (arr(s.faq).length) return { layout: 'S20', body: faqBlock(s), cls: '' };
      break;
    case 'price':
      if (s.price || arr(s.anchors).length) return { layout: 'S13', body: priceBlock(s), cls: '' };
      break;
    case 'product':
      if (arr(s.bullets).length || arr(s.table?.rows).length)
        return { layout: 'S03', body: productBlock(s), cls: 'grey' };
      break;
    case 'cta':
      if (arr(s.bullets).length) return { layout: 'S20', body: ctaBlock(s), cls: 'dark' };
      break;
    default:
      break;
  }
  const fb = fallback(s);
  return fb;
}

export function slide(s, ctx) {
  if (s.type === 'cover') return coverPage(s, ctx);
  if (s.type === 'end') return endPage(s, ctx);

  const { layout, body, cls = '', attrs = '' } = bodyFor(s);
  return `${open(s, cls, layout, { attrs })}
  ${page(head(s, ctx) + `<div class="body">${body}</div>` + foot(s, ctx))}
</section>`;
}
