/**
 * 风格：电子杂志 × 电子墨水
 *
 * 出处：guizang-ppt-skill 风格 A（杂志墨水），主题色取
 *   `references/themes.md` 的 🌿 森林墨（Forest Ink）—— 与已定稿样稿
 *   `ppt-lab/design-demos/A-杂志墨水.html` 完全同一套 hex，没有自定义颜色。
 *
 * 设计语言（三种字体分工是这套风格的灵魂）：
 *   衬线（.tt 标题 / .big 数字 / 页码外的中文大字）压住版面，
 *   非衬线（正文、描述、列表）负责读，
 *   等宽（kicker / 标签 / 页脚 / 编号）承担元数据。
 * 暖白纸感、大量留白、极细分隔线、无阴影、无浮动卡片、无渐变、无 emoji。
 *
 * 明暗节奏：封面 / 行动 / 收尾三页深色（.slide.dark），正文一律浅色。
 * 深色页只用在「做一个决定」的时刻，中间 18 页全是纸面，翻页才有呼吸。
 *
 * 舞台、翻页、缩放、进度、打印、基准字号由 shell.mjs 提供，这里一律不重写。
 * 所有尺寸走 cqw / cqh / em；cqw 只出现在 .page 内部（写在 .slide 上会解析到视口）。
 */

export const meta = {
  id: 'magazine',
  label: '电子杂志 × 电子墨水',
  desc: '衬线大字 + 暖白纸感，山林人文调',
  source: 'guizang-ppt-skill 风格 A · 森林墨',
  swatches: ['#1a2e1f', '#f5f1e8', '#b98a3c'],
  darkHint: false,
};

export const css = `
/* ── 主题：🌿 森林墨（themes.md 原样） ───────────────────────────────
   可读性下限是硬约束，所以纸色上的金/绿都取「够深」的那一档：
   --tea  #7a5a1e  在 paper 上 5.03:1（#b98a3c 只有 2.64:1，只能当色块/分隔线）
   --leaf #4e6b45  在 paper 上 5.60:1（#8fbf8a 只有 1.85:1）
   深色页反过来用浅金 #c9a45c（ink 上 5.36:1）与浅绿 #a8c9a0（8.33:1）。 */
:root{
  --ink:#1a2e1f;        --ink-rgb:26,46,31;
  --paper:#f5f1e8;      --paper-rgb:245,241,232;
  --paper-tint:#ece7da;
  --ink-tint:#253d2c;
  --tea:#7a5a1e;        --tea-lt:#c9a45c;   --gold:#b98a3c;
  --leaf:#4e6b45;       --leaf-lt:#a8c9a0;
  --rule:#d5cfbf;       --hairline-dark:#3b5741;
  --ink-2:#3f4d41;      --ink-3:#635d51;
  --paper-2:#d8d0bd;    --paper-3:#b6ad9a;
  --font-serif:"Noto Serif SC","Source Han Serif SC","Source Han Serif CN","Songti SC",STSong,SimSun,"Microsoft YaHei UI","Microsoft YaHei",Georgia,serif;
  --font-sans:"Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif;
  --font-mono:"IBM Plex Mono","SFMono-Regular",Consolas,"Liberation Mono",Menlo,"Microsoft YaHei UI","Noto Sans SC",monospace;
}

.slide{font-family:var(--font-sans);background:var(--paper);color:var(--ink)}
/* 正文容器：内容按自身尺寸排，块高上限已经写在各版式的 max-height 里，
   所以短内容不会被拉成一根根散落的横线，长内容也不会溢出页面。 */
.body{flex:1;min-height:0;overflow:hidden;position:relative}
/* 深色页只改纸与墨，其余组件靠这层变量自适应 */
.slide.dark{
  background:var(--ink);color:var(--paper);
  --rule:var(--hairline-dark);--ink-2:var(--paper-2);--ink-3:var(--paper-3);
  --tea:var(--tea-lt);--leaf:var(--leaf-lt);
}

/* ── 页眉组件外观（结构由外壳给，这里只定外观） ─────────────────── */
.kicker{font-family:var(--font-mono);font-weight:500;color:var(--tea);text-transform:uppercase}
.s-title{font-family:var(--font-serif);font-weight:700;font-size:1.45em;line-height:1.16}
.rule{background:var(--rule)}
.rule i{background:var(--gold);height:2px}
.slide.dark .rule i{background:var(--tea-lt)}
.s-sub{color:var(--ink-3);line-height:1.5}
.foot{font-family:var(--font-mono);color:var(--ink-3)}

/* ── 通用零件 ───────────────────────────────────────────────── */
/* 等宽小标签：页眉 kicker、编号、页脚、封底落款都走它 */
.lab{font-family:var(--font-mono);font-size:.72em;letter-spacing:.16em;text-transform:uppercase;
  color:var(--tea);line-height:1.4}
/* 结论条钉在版心底部：它是收口，不是段落的一部分，所以不跟着上面的内容浮。
   底边留出 2.8em 给绝对定位的页脚，两者不会打架。 */
.quote{position:absolute;left:0;right:0;bottom:2.8em;flex:none;padding:1em 1.3em;
  background:var(--paper-tint);color:var(--ink);font-family:var(--font-serif);
  font-size:.95em;line-height:1.5}
.slide.dark .quote{background:var(--ink-tint);color:var(--paper)}
.dnote{position:absolute;left:0;right:0;bottom:0;flex:none;font-size:.72em;line-height:1.5;
  color:var(--ink-3)}
/* 页码/进度一律不画：外壳有圆点，页面里再放一遍就成了两个页码 */

/* ── 封面（深色） ───────────────────────────────────────────── */
.cover-top{display:flex;justify-content:space-between;align-items:baseline;gap:2em;flex:none}
.cover-top .vol{font-family:var(--font-mono);font-size:.72em;letter-spacing:.22em;
  text-transform:uppercase;color:var(--paper-3)}
.cover-body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;
  gap:.55em;padding-bottom:1.4em}
.cover-title{font-family:var(--font-serif);font-weight:700;font-size:3.9em;line-height:1.06;
  letter-spacing:.005em;color:var(--paper);overflow-wrap:anywhere}
.cover-rule{width:5.4em;height:3px;background:var(--gold);margin:.55em 0 .3em;flex:none}
.cover-sub{font-size:1em;color:var(--paper-2);line-height:1.55;overflow-wrap:anywhere}
.cover-meta{flex:none;display:flex;flex-wrap:wrap;gap:.5em 1.5em;padding-top:1.6cqh;
  border-top:1px solid var(--hairline-dark);
  font-family:var(--font-mono);font-size:.72em;letter-spacing:.14em;color:var(--paper-3)}

/* ── 要点（左索引 / 右正文，一线到底） ─────────────────────── */
/* 版式块的统一节奏：**内容多高就多高**（flex:0 0 auto），再用 margin-block:auto
   在版心里垂直居中；max-height 只作为溢出兜底。
   踩过的坑：写成 flex:1 + max-height，块会被拉到上限高度，
   而它的内容轨道仍旧居中 —— 画面上是「一块空盒子」，不是「居中排的内容」。

   内容偏多时由 [data-density="tight"] 主动降一档行距与留白（见下方每个块的
   tight 规则），而不是靠 overflow:hidden 把字裁掉：裁掉的是内容，看不见的丢字
   比溢出更糟。块内 overflow 一律 visible，真排不下就顶到 .body 的 overflow:hidden
   之外被验收脚本抓住。 */
.list{flex:0 0 auto;margin-block:auto;display:flex;flex-direction:column;
  max-height:34em}
.li{display:flex;align-items:baseline;gap:1.3em;flex:none;min-height:3.1em;
  border-bottom:1px solid var(--rule);padding:.85em 0}
.li:first-child{border-top:1px solid var(--rule)}
.li .no{flex:0 0 2.4em;font-family:var(--font-mono);font-size:.72em;letter-spacing:.14em;
  color:var(--tea)}
.li .tx{flex:1;min-width:0;font-size:1.05em;line-height:1.5;color:var(--ink)}
/* 要点 ≥7 条：行距与内边距各降一档，正文仍 ≥1.03em ≈ 20.8px */
.list[data-density="tight"] .li{padding:.55em 0}
.list[data-density="tight"] .li .tx{font-size:1.03em;line-height:1.45}

/* ── 卡片（靠对齐与细线成组，不做圆角/阴影/浮动） ───────────── */
.cards{flex:0 0 auto;display:grid;gap:1.5cqw 1.8cqw;margin-block:auto;align-content:start}
/* 卡片 ≥6 张：卡片间距与描述行距各收一档 */
.cards[data-density="tight"]{gap:1.1cqw 1.5cqw}
.cards[data-density="tight"] .card h4{margin:.4em 0 .35em;font-size:1.1em}
.cards[data-density="tight"] .card p{line-height:1.45}
.card{border-top:1px solid var(--rule);padding-top:1.1em;display:flex;flex-direction:column;
  min-width:0;overflow:hidden}
.card .no{font-family:var(--font-mono);font-size:.72em;letter-spacing:.2em;color:var(--tea);flex:none}
.card h4{margin:.5em 0 .45em;font-family:var(--font-serif);font-size:1.15em;font-weight:700;
  line-height:1.3;color:var(--ink);flex:none}
.card p{margin:0;font-size:.95em;line-height:1.55;color:var(--ink-2)}

/* ── 清单（等宽标签 / 纸面正文） ───────────────────────────── */
.rows{flex:0 0 auto;margin-block:auto;display:flex;flex-direction:column;
  max-height:32em}
.row{display:grid;grid-template-columns:1.3fr 2.7fr;gap:1.6em;align-items:baseline;
  flex:none;min-height:3.2em;padding:1.05em .3em;border-bottom:1px solid var(--rule)}
.row:first-child{border-top:1px solid var(--rule)}
.row .no{font-family:var(--font-mono);font-size:.72em;letter-spacing:.14em;color:var(--tea);
  margin-right:.9em}
.row .k{font-size:1em;color:var(--ink-3);line-height:1.4}
.row .v{font-size:1.05em;color:var(--ink);line-height:1.5}
/* 清单 ≥7 行：行高与内边距各降一档 */
.rows[data-density="tight"] .row{min-height:2.7em;padding:.7em .3em}
.rows[data-density="tight"] .row .v{font-size:1.03em;line-height:1.42}

/* ── 对比（同色同字号，右侧只靠纸色退后一档） ─────────────────
   踩过的坑：右侧曾把正文改成 --ink-3，与 paper-tint 混合后正好落在
   4.5:1 的边界上（4.50 被判失败）。降级只用纸色，
   文字颜色保持一致 —— 对比度不打折，语义照样分得清。 */
.cmp{flex:0 0 auto;display:grid;gap:2.4cqw;margin-block:auto;justify-content:center;
  align-items:stretch;max-height:26em}
.cmp .col{display:flex;flex-direction:column;min-width:0}
.cmp .col.alt{background:var(--tint,var(--paper-tint));padding:1.2em 1.4em 1.4em}
.slide.dark .cmp .col.alt{--tint:var(--ink-tint)}
.cmp .col.alt .head{color:var(--ink-2)}
.cmp .head{font-family:var(--font-serif);font-weight:700;font-size:1.2em;line-height:1.3;
  padding-bottom:.6em;border-bottom:1px solid var(--rule);margin-bottom:.2em}
.cmp ul{margin:0;padding:0;list-style:none}
.cmp li{font-size:1em;line-height:1.5;color:var(--ink-2);padding:.85em 0 .85em 1.1em;
  position:relative;border-bottom:1px solid var(--rule)}
.cmp li:last-child{border-bottom:0}
.cmp li::before{content:"";position:absolute;left:0;top:1.38em;width:.42em;height:.42em;
  background:var(--tea)}
.cmp .col.alt li::before{background:var(--ink-3)}
/* 对比每侧 ≥5 条：行距收 0.1，条目内边距减半 */
.cmp[data-density="tight"] li{padding:.6em 0 .6em 1.1em;line-height:1.42}
.cmp[data-density="tight"] li::before{top:1.2em}

/* ── 步骤（横向流水线：细线 + 编号 + 标题 + 说明） ─────────── */
.steps{flex:0 0 auto;display:grid;gap:1.6cqw;margin-block:auto;align-items:start;
  max-height:22em}
.step{display:flex;flex-direction:column;min-width:0}
.step .no{font-family:var(--font-serif);font-style:italic;font-size:1.1em;color:var(--tea);
  line-height:1;padding-bottom:.55em}
.step h5{margin:0;font-size:1.05em;font-weight:700;color:var(--ink);line-height:1.35;
  padding-top:.7em;border-top:1px solid var(--ink)}
.step p{margin:.5em 0 0;font-size:.95em;line-height:1.55;color:var(--ink-2)}
.arrow{align-self:start;width:1.3em;height:.8em;flex:none;margin-top:1.35em}
.arrow line,.arrow polyline{stroke:var(--tea);stroke-width:1.6;fill:none;vector-effect:non-scaling-stroke}
.steps .arrow{display:block}
/* 步骤 ≥7 步：列更窄，标题与说明各收一档行距（每条仍 ≥0.95em 描述 / 1em 标题） */
.steps[data-density="tight"]{gap:1.1cqw}
.steps[data-density="tight"] .step h5{font-size:1em;line-height:1.28;padding-top:.55em}
.steps[data-density="tight"] .step p{font-size:.95em;line-height:1.45;margin-top:.4em}
.steps[data-density="tight"] .step .no{font-size:1em;padding-bottom:.4em}
.steps[data-density="tight"] .arrow{width:1em;margin-top:1.2em}

/* ── 答疑（Q 用衬线大字，A 用非衬线正文） ───────────────────── */
.faqs{flex:0 0 auto;margin-block:auto;display:flex;flex-direction:column;
  max-height:38em}
.faq{display:grid;grid-template-columns:3em 1fr;gap:1.4em;align-items:baseline;flex:none;
  padding:1.15em 0;border-bottom:1px solid var(--rule)}
.faq:first-child{border-top:1px solid var(--rule)}
.faq .q{font-family:var(--font-serif);font-weight:700;font-size:1em;color:var(--tea);
  line-height:1.8}
.faq .bd{min-width:0}
.faq .qq{font-family:var(--font-serif);font-weight:700;font-size:1.05em;line-height:1.4;
  color:var(--ink);margin-bottom:.4em}
.faq .aa{font-size:.95em;line-height:1.55;color:var(--ink-2)}
/* 答疑 ≥6 问：内边距与答案行距各收一档，问句保持衬线大字 */
.faqs[data-density="tight"] .faq{padding:.65em 0}
.faqs[data-density="tight"] .faq .qq{font-size:1.05em;margin-bottom:.25em}
.faqs[data-density="tight"] .faq .aa{font-size:.95em;line-height:1.42}

/* ── 价格（深色价签 + 浅色锚点） ───────────────────────────── */
.price{flex:0 0 auto;display:grid;grid-template-columns:40% 1fr;gap:2.4cqw;
  margin-block:auto;align-content:center;align-items:start;max-height:30em}
.price .box{background:var(--ink);color:var(--paper);padding:2em 1.6em;display:flex;
  flex-direction:column;justify-content:center;min-width:0}
.price .box .lab{color:var(--tea-lt)}
.price .big{font-family:var(--font-serif);font-weight:700;font-size:2.9em;line-height:1.06;
  color:var(--paper);margin-top:.2em;overflow-wrap:anywhere}
.price .was{font-family:var(--font-mono);font-size:.72em;letter-spacing:.1em;color:var(--paper-3);
  margin-top:1em;text-decoration:line-through}
.price .right{display:flex;flex-direction:column;gap:.4em;min-width:0}
.anchor{display:grid;grid-template-columns:1.3fr 2.7fr;gap:1.4em;align-items:baseline;
  padding:1em 1.2em;background:var(--paper-tint)}
.anchor .k{font-family:var(--font-mono);font-size:.72em;letter-spacing:.12em;color:var(--ink-3);
  line-height:1.7}
.anchor .v{font-family:var(--font-serif);font-weight:700;font-size:1.25em;color:var(--ink);
  overflow-wrap:anywhere}
.pbul{font-size:1em;line-height:1.5;color:var(--ink-2);padding:.65em 0 .65em 1.1em;position:relative}
.pbul::before{content:"";position:absolute;left:0;top:1.2em;width:.42em;height:.42em;
  background:var(--tea)}
/* 价格页锚点 ≥4 个或要点 ≥5 条：锚点与要点各自收一档 */
.price[data-density="tight"] .anchor{padding:.7em 1.2em}
.price[data-density="tight"] .anchor .v{font-size:1.15em}
.price[data-density="tight"] .pbul{padding:.5em 0 .5em 1.1em;line-height:1.45}
.price[data-density="tight"] .pbul::before{top:1.05em}

/* ── 产品（左：要点 / 右：清单） ───────────────────────────── */
.prod{flex:0 0 auto;display:grid;grid-template-columns:51% 1fr;gap:2.2cqw;
  margin-block:auto;align-content:center;align-items:start;max-height:32em}
.prod .left{display:flex;flex-direction:column;justify-content:center;min-width:0}
.prod ul{margin:.9em 0 0;padding:0;list-style:none}
.prod li{font-size:1.05em;line-height:1.5;color:var(--ink);padding:.85em 0 .85em 1.1em;
  position:relative;border-bottom:1px solid var(--rule)}
.prod li:first-child{border-top:1px solid var(--rule)}
.prod li::before{content:"";position:absolute;left:0;top:1.38em;width:.42em;height:.42em;
  background:var(--tea)}
.prod .right{background:var(--paper-tint);padding:1.4em 1.5em;display:flex;flex-direction:column;
  justify-content:center;min-width:0}
.prow{display:grid;grid-template-columns:1fr 2fr;gap:1.2em;align-items:baseline;
  padding:.72em 0;border-bottom:1px solid var(--rule)}
.prow:last-child{border-bottom:0}
.prow .k{font-size:.72em;color:var(--ink-3);letter-spacing:.06em;line-height:1.7}
.prow .v{font-size:1em;color:var(--ink);line-height:1.5}
/* 产品页要点 ≥5 条或清单 ≥7 行：两边各收一档 */
.prod[data-density="tight"] li{padding:.6em 0 .6em 1.1em;line-height:1.45}
.prod[data-density="tight"] li::before{top:1.28em}
.prod[data-density="tight"] .prow{padding:.55em 0}
.prod[data-density="tight"] .prow .v{line-height:1.42}

/* ── 行动（深色）：三行式议程 ─────────────────────────────── */
.cta{flex:0 0 auto;margin-block:auto;display:flex;flex-direction:column;
  max-height:30em}
.cta-r{display:flex;align-items:baseline;gap:1.6em;flex:none;min-height:3.6em;padding:1.1em 0;
  border-bottom:1px solid var(--hairline-dark)}
.cta-r:first-child{border-top:1px solid var(--hairline-dark)}
.cta-r .no{flex:0 0 2.6em;font-family:var(--font-mono);font-size:.72em;letter-spacing:.16em;
  color:var(--tea-lt)}
.cta-r .tx{flex:1;min-width:0;font-size:1.05em;line-height:1.5;color:var(--paper)}
/* 行动 ≥5 步：行高与内边距各降一档 */
.cta[data-density="tight"] .cta-r{min-height:3em;padding:.85em 0}
.cta[data-density="tight"] .cta-r .tx{font-size:1.03em;line-height:1.42}

/* ── 收尾（深色）：居中，落款用等宽 ───────────────────────── */
.end{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;overflow:hidden}
.end-title{font-family:var(--font-serif);font-weight:700;font-size:2.5em;line-height:1.16;
  color:var(--paper);overflow-wrap:anywhere}
.end-rule{width:4.6em;height:3px;background:var(--tea-lt);margin:1.3em 0}
.end-sub{font-size:1.05em;color:var(--paper-2);line-height:1.6;overflow-wrap:anywhere}
.end-bul{margin-top:1.8em;font-family:var(--font-mono);font-size:.72em;letter-spacing:.12em;
  color:var(--paper-3);line-height:2}
`;

/* ──────────────────────────────── 渲染 ──────────────────────────────── */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const slideId = (s) => `s-${String(s.id || s.index).replace(/[^\w-]/g, '')}`;

/** 口播稿落到 data-notes，不显示在页面上 */
const notesAttr = (s) =>
  s.script && s.script.length
    ? ` data-notes="${esc(s.script.map((l) => (l.cue ? `〔${l.cue}〕` : '') + (l.text || '')).join('\n'))}"`
    : '';

const open = (s, cls = '', extra = '') =>
  `<section class="slide ${cls}${s.kicker ? '' : ' plain'}" data-slide-id="${slideId(s)}" data-type="${esc(
    s.type
  )}"${notesAttr(s)}${extra}>`;
const page = (inner, style = '') => `<div class="page"${style}>${inner}</div>`;

/* 页脚：品牌/段落名在左，产品名在右。
   页码由外壳的圆点承载 —— 页内**不放**页码（契约硬约束 4，style-smoke 会检查）。 */
const foot = (s, ctx) => {
  const m = ctx.deck.meta || {};
  const left = [m.brand, s.sectionTitle].filter(Boolean).join(' · ');
  const right = s.productName && m.productCount > 1 ? s.productName : '';
  return `<div class="foot"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;
};

/** 页眉：kicker 为空串时**不回退**成别的文字，只把标题上移一位 */
const head = (s) => {
  const k = s.kicker ? `<div class="kicker"><i></i><span>${esc(s.kicker)}</span></div>` : '';
  const sub = s.subtitle ? `<div class="s-sub">${esc(s.subtitle)}</div>` : '';
  return `${k}<h2 class="s-title">${esc(s.title)}</h2><div class="rule"><i></i></div>${sub}`;
};

const arrow = (cls = '') =>
  `<svg class="arrow ${cls}" viewBox="0 0 20 12" aria-hidden="true" focusable="false"><line x1="0" y1="6" x2="14" y2="6"></line><polyline points="9,1 15,6 9,11"></polyline></svg>`;

const quoteBlock = (q) => (q ? `<div class="quote">${esc(q)}</div>` : '');
const noteBlock = (t) => (t ? `<div class="dnote">${esc(t)}</div>` : '');

/**
 * 密度开关：条目数超过阈值时挂 data-density="tight"，
 * 由 CSS 把该块的行距/内边距收一档 —— 宁可排版紧一点，也不裁字。
 */
const dense = (n, limit) => (n >= limit ? ' data-density="tight"' : '');

/**
 * 卡片数 → 列数 / 行数。
 * 5–6 张走三列（3+2 / 3+3）：四列时描述会掉到第三行，
 * 网格两行加起来顶破版心（实测 6 张四列时溢出 8px）。三列更宽，两行放得下。
 * 行数用列数算出来的实际值显式写死：让「3 + 2」自然留白，
 * 而不是用 :nth-child 去猜（猜错就凭空多出一行，卡片被压扁）。
 */
function cardShape(n) {
  const cols = n <= 1 ? 1 : n === 2 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  return { cols, rows };
}

function cardsBlock(cards, q) {
  const list = cards || [];
  const { cols, rows } = cardShape(list.length || 1);
  return `<div class="cards"${dense(list.length, 6)} style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${list
    .map(
      (x, i) =>
        `<div class="card"><span class="no">${String(i + 1).padStart(2, '0')}</span><h4>${esc(
          x.title
        )}</h4><p>${esc(x.desc)}</p></div>`
    )
    .join('')}</div>${quoteBlock(q)}`;
}

/** 步骤：横向流水线，列间用细线箭头，不是等分四格 */
function stepsBlock(steps) {
  const list = steps || [];
  const cols = Math.max(1, list.length * 2 - 1); // 步骤列 + 箭头列
  return `<div class="steps"${dense(list.length, 7)} style="grid-template-columns:repeat(${cols},auto)">${list
    .map(
      (x, i) =>
        (i ? arrow() : '') +
        `<div class="step"><span class="no">${String(i + 1).padStart(2, '0')}</span><h5>${esc(
          x.title
        )}</h5><p>${esc(x.desc)}</p></div>`
    )
    .join('')}</div>`;
}

/** 清单：等宽标签 + 纸面正文，一行为一条 */
const rowsBlock = (rows) =>
  `<div class="rows"${dense((rows || []).length, 7)}>${(rows || [])
    .map(
      (r, i) =>
        `<div class="row"><div class="k"><span class="no">${String(i + 1).padStart(2, '0')}</span>${esc(
          r[0]
        )}</div><div class="v">${esc(r[1])}</div></div>`
    )
    .join('')}</div>`;

/* ── 各 type 的页体 ─────────────────────────────────────────── */

const BODIES = {
  points: (s) =>
    `<div class="list"${dense((s.bullets || []).length, 7)}>${(s.bullets || [])
      .map(
        (t, i) =>
          `<div class="li"><span class="no">${String(i + 1).padStart(2, '0')}</span><div class="tx">${esc(
            t
          )}</div></div>`
      )
      .join('')}</div>${quoteBlock(s.quote)}${noteBlock(s.footnote)}`,

  cards: (s) => cardsBlock(s.cards, s.quote) + noteBlock(s.footnote),
  hook: (s) => cardsBlock(s.cards, s.quote) + noteBlock(s.footnote),
  tasting: (s) => cardsBlock(s.cards, s.quote) + noteBlock(s.footnote),

  table: (s) => `${rowsBlock(s.table?.rows || [])}${noteBlock(s.footnote)}`,

  compare: (s) => {
    const col = (side, alt) =>
      side
        ? `<div class="col${alt ? ' alt' : ''}"><div class="head">${esc(side.title)}</div><ul>${(
            side.items || []
          )
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}</ul></div>`
        : '';
    const n = Math.max((s.left?.items || []).length, (s.right?.items || []).length);
    return `<div class="cmp"${dense(n, 5)} style="grid-template-columns:repeat(${
      s.left && s.right ? 2 : 1
    },1fr)">${col(s.left, false)}${col(s.right, true)}</div>${noteBlock(s.footnote)}`;
  },

  steps: (s) => stepsBlock(s.steps) + noteBlock(s.footnote),

  faq: (s) =>
    `<div class="faqs"${dense((s.faq || []).length, 6)}>${(s.faq || [])
      .map(
        (f) =>
          `<div class="faq"><div class="q">Q</div><div class="bd"><div class="qq">${esc(
            f.q
          )}</div><div class="aa">${esc(f.a)}</div></div></div>`
      )
      .join('')}</div>`,

  price: (s) => {
    const anchors = (s.anchors || [])
      .map((a) => `<div class="anchor"><div class="k">${esc(a.label)}</div><div class="v">${esc(a.value)}</div></div>`)
      .join('');
    const bul = (s.bullets || []).map((b) => `<div class="pbul">${esc(b)}</div>`).join('');
    const tight = (s.anchors || []).length >= 4 || (s.bullets || []).length >= 5;
    return `<div class="price"${tight ? ' data-density="tight"' : ''}><div class="box"><div class="lab">直播间价格</div>${
      s.price ? `<div class="big">${esc(s.price)}</div>` : ''
    }${
      s.comparePrice ? `<div class="was">日常价 ${esc(s.comparePrice)}</div>` : ''
    }</div><div class="right">${anchors}${bul}</div></div>${noteBlock(s.footnote)}`;
  },

  product: (s) => {
    const li = (s.bullets || []).map((b) => `<li>${esc(b)}</li>`).join('');
    const rows = (s.table?.rows || [])
      .map((r) => `<div class="prow"><div class="k">${esc(r[0])}</div><div class="v">${esc(r[1])}</div></div>`)
      .join('');
    const tight = (s.bullets || []).length >= 5 || (s.table?.rows || []).length >= 7;
    return `<div class="prod"${tight ? ' data-density="tight"' : ''}><div class="left"><div class="lab">${
      s.productName ? esc(s.productName) : '本场茶品'
    } · 值得记住的地方</div><ul>${li}</ul></div><div class="right">${rows}</div></div>${noteBlock(
      s.footnote
    )}`;
  },

  cta: (s) =>
    `<div class="cta"${dense((s.bullets || []).length, 5)}>${(s.bullets || [])
      .map(
        (t, i) =>
          `<div class="cta-r"><span class="no">${String(i + 1).padStart(2, '0')}</span><div class="tx">${esc(
            t
          )}</div></div>`
      )
      .join('')}</div>${quoteBlock(s.quote)}`,
};

/**
 * 未知 type 的兜底：历史存档里会有旧类型，绝不能渲染成空白页。
 * 顺序按 CONTRACT：「有 cards 用卡片 / 有 table 用清单 / 否则用要点」，
 * 中间插入 faq / steps / compare / price，最后兜到要点。
 */
function fallback(s) {
  if ((s.cards || []).length) return BODIES.cards(s);
  if (s.table && (s.table.rows || []).length) return BODIES.table(s);
  if ((s.faq || []).length) return BODIES.faq(s);
  if ((s.steps || []).length) return BODIES.steps(s);
  if (s.left && s.right) return BODIES.compare(s);
  if (s.price || (s.anchors || []).length) return BODIES.price(s);
  return BODIES.points(s);
}

/** 一点内容都没有时，给一页诚实的空状态，而不是白屏 */
const EMPTY_BODY = `<div class="list"><div class="li"><span class="no">00</span><div class="tx">这一页没有内容</div></div></div>`;

export function slide(s, ctx) {
  /* ── 封面：深色 ── */
  if (s.type === 'cover') {
    const m = ctx.deck.meta || {};
    const year = String(m.date || '').slice(0, 4);
    const vol = [year ? `VOL.${year}` : '', 'FOREST INK'].filter(Boolean).join(' / ');
    const meta = (s.meta || []).length
      ? s.meta
      : [m.host && `主讲 ${m.host}`, m.brand, m.date, m.durationMin && `约 ${m.durationMin} 分钟`].filter(
          Boolean
        );
    return `${open(s, 'dark', ' data-layout="cover"')}
  ${page(
    `<div class="cover-top"><div class="kicker">${
      s.kicker ? `<span>${esc(s.kicker)}</span>` : '<span>&nbsp;</span>'
    }</div><div class="vol">${esc(vol)}</div></div>
    <div class="cover-body">
      <h1 class="cover-title">${esc(s.title)}</h1>
      <div class="cover-rule"></div>
      ${s.subtitle ? `<div class="cover-sub">${esc(s.subtitle)}</div>` : ''}
    </div>
    ${
      meta.length
        ? `<div class="cover-meta">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`
        : ''
    }`
  )}
</section>`;
  }

  /* ── 收尾：深色 ── */
  if (s.type === 'end') {
    return `${open(s, 'dark', ' data-layout="end"')}
  ${page(
    `<div class="end">
      <div class="end-title">${esc(s.title)}</div>
      <div class="end-rule"></div>
      ${s.subtitle ? `<div class="end-sub">${esc(s.subtitle)}</div>` : ''}
      ${
        (s.bullets || []).length
          ? `<div class="end-bul">${(s.bullets || []).map((b) => `<div>${esc(b)}</div>`).join('')}</div>`
          : ''
      }
    </div>`
  )}
</section>`;
  }

  /* ── 正文：浅色；只有「行动」一页转深色 ── */
  const fn = BODIES[s.type] || fallback;
  let body;
  try {
    body = fn(s);
  } catch {
    body = fallback(s);
  }
  const dark = s.type === 'cta';
  const hasBody = body && body.replace(/<[^>]*>/g, '').trim().length > 0;
  return `${open(s, dark ? 'dark' : '', ` data-layout="${esc(s.type)}"`)}
  ${page(
    `${head(s)}<div class="body">${hasBody ? body : EMPTY_BODY}</div>${dark ? '' : foot(s, ctx)}`
  )}
</section>`;
}
