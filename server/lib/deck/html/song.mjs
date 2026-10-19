/**
 * 风格：宋版 · 因果链
 *
 * 出处：huashu-design 的「最佳设计师」逻辑 + 杉浦康平《全宇宙誌》的迁移
 *   —— 黑白为骨、只留一色生普汤色作数据色、宋体压黑体、线宽承载因果权重。
 *
 * 这个模块同时是**参考实现**：另两个风格模块按同样的接口写。
 * 只导出三样东西：meta（元信息）、css（样式）、slide()（一页的 markup）。
 * 舞台/翻页/缩放/打印由 shell.mjs 提供，这里一律不碰。
 */

export const meta = {
  id: 'song',
  label: '宋版 · 因果链',
  desc: '黑白为骨 + 宋体大字，把因果讲成结构',
  source: 'huashu-design · 杉浦康平逻辑定制',
  swatches: ['#14110D', '#F2EEE5', '#7A5210'],
  darkHint: false,
};

export const css = `
:root{
  --paper:#F2EEE5; --sheet:#FFFFFF; --ink:#16130F; --ink-2:#4A4238; --ink-3:#5F5647;
  --void:#14110D; --tea:#7A5210; --tea-lt:#C1852A; --leaf:#4E5A45; --rule:#D8D2C4;
  --font-display:"Noto Serif SC","Source Han Serif SC","Source Han Serif CN","Songti SC",STSong,SimSun,"Microsoft YaHei UI","Microsoft YaHei",serif;
  --font-sans:"Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif;
}
.slide{font-family:var(--font-sans);color:var(--ink)}
.slide.void{background:var(--void);color:var(--paper)}

/* 极细纸纹网格：只在封面/深色页透出，正文页保持干净 */
.slide.grid-bg::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;
  background-image:linear-gradient(to right,rgba(176,166,145,.16) 1px,transparent 1px),
                   linear-gradient(to bottom,rgba(176,166,145,.16) 1px,transparent 1px);
  background-size:9.6cqw 9.6cqw}

/* 页眉组件外观 */
.kicker{color:var(--tea)}
.s-title{font-family:var(--font-display);font-size:1.9em;letter-spacing:.01em}
.slide.void .kicker{color:var(--tea-lt)}
.slide.void .s-title{color:var(--paper)}
.s-sub{color:var(--ink-3)}
.slide.void .s-sub{color:#B9AE9C}
.rule{background:var(--rule)}
.slide.void .rule{background:#3A342C}

/* 页脚 */
.foot{color:var(--ink-3)}
.slide.void .foot{color:#8C8375;border-top-color:#3A342C}

/* ── 封面 ───────────────────────────────────────────── */
.cover-body{flex:1;min-height:0;display:flex;align-items:center;position:relative;z-index:1}
.cover-left{flex:1;min-width:0}
.cover-title{font-family:var(--font-display);font-weight:700;font-size:4.5em;line-height:1.04;letter-spacing:.01em}
.cover-rule{width:5.6em;height:4px;background:var(--tea);margin:1.1em 0}
.cover-sub{font-size:1.05em;color:var(--ink-2);letter-spacing:.04em}
/* 对齐 .page 的左右内边距：用 left:0/right:0 会横跨 1920，转 PPTX 时文本框超宽 */
.cover-meta{position:absolute;left:6.4cqw;right:6.4cqw;bottom:0;z-index:1;
  display:flex;flex-wrap:wrap;gap:.2em .5em;font-size:.72em;color:var(--ink-3);letter-spacing:.06em}
/* 幽灵年份：刻意出血的装饰。class="deco" 是契约约定的装饰标记 ——
   转 PPTX 时会用 --skip-class deco 跳过，否则它会变成一个越出画布的文本框。 */
.cover-ghost{position:absolute;right:-2.5cqw;top:52%;transform:translateY(-50%);
  font-family:var(--font-display);font-weight:700;font-size:22em;line-height:1;color:rgba(22,19,15,.055);
  pointer-events:none;user-select:none;z-index:0}
/* 饼形刻度环：357g 饼的 60 等分压印，纯 CSS 几何，不是手绘冒充照片 */
.seal{position:absolute;right:1.2cqw;top:16cqh;width:15.6cqw;height:15.6cqw;border-radius:50%;
  border:1px solid var(--tea);opacity:.85;z-index:1;display:flex;align-items:center;justify-content:center}
.seal::after{content:"";position:absolute;inset:12%;border-radius:50%;border:1px solid var(--rule)}
.seal i{position:absolute;left:50%;top:0;width:1px;height:8px;background:var(--tea);opacity:.5;
  transform-origin:50% 7.8cqw}
.seal span{font-family:var(--font-display);font-size:1.5em;font-weight:700;color:var(--ink)}

/* ── 通用：卡片 ─────────────────────────────────────── */
.cards{flex:1;min-height:0;display:grid;gap:1.6cqw;align-content:center}
.cards.c2{grid-template-columns:repeat(2,1fr)}
.cards.c3{grid-template-columns:repeat(3,1fr)}
.cards.c4{grid-template-columns:repeat(4,1fr)}
.card{border:1px solid var(--rule);background:var(--sheet);padding:1.5em 1.4em;position:relative;
  display:flex;flex-direction:column;justify-content:center;min-width:0}
.card .tick{width:1.9em;height:2px;background:var(--tea);margin-bottom:.75em;flex:none}
.card h4{margin:0 0 .5em;font-size:1.05em;font-weight:700;color:var(--tea);font-family:var(--font-display)}
.card p{margin:0;color:var(--ink-2);font-size:.94em}
.card .ghost{position:absolute;right:.55em;top:.3em;font-family:var(--font-display);font-weight:700;
  font-size:1.5em;color:rgba(22,19,15,.10);pointer-events:none}

/* ── 要点 ───────────────────────────────────────────── */
.list{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.item{display:flex;align-items:center;gap:1.1em;flex:1;min-height:0;border-bottom:1px solid var(--rule)}
.item:last-child{border-bottom:0}
.item .no{font-family:var(--font-display);font-weight:700;font-size:1.15em;color:var(--ink-3);flex:0 0 2.2em;text-align:right}
.item .tx{font-size:1.05em;line-height:1.4;color:var(--ink-2)}

/* 金句条 */
.quote{margin-top:1em;background:var(--void);color:var(--paper);padding:1em 1.3em;border-left:4px solid var(--tea);
  font-size:.98em;font-weight:700;line-height:1.35;flex:none}
.quote.tint{background:#E7E1D5;color:var(--ink);border-left-color:var(--leaf);font-weight:400}

/* ── 清单（标签 / 值） ──────────────────────────────── */
.rows{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;position:relative}
.rows .vline{position:absolute;left:16.5%;top:2%;bottom:2%;width:1px;background:var(--rule)}
.row{display:flex;align-items:center;flex:1;min-height:0;border-bottom:1px solid var(--rule)}
.row:last-child{border-bottom:0}
.row .k{flex:0 0 15%;font-size:.71em;color:var(--ink-3);letter-spacing:.1em;padding-right:1.2em}
.row .v{flex:1;padding-left:1.6em;font-size:1.05em;color:var(--ink);line-height:1.35}

/* ── 对比 ───────────────────────────────────────────── */
.cmp{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:1.8cqw}
.cmp .col{border:1px solid var(--rule);background:var(--sheet);display:flex;flex-direction:column;min-width:0}
.cmp header{background:var(--void);color:var(--paper);padding:1em 1.4em;font-weight:700;font-size:1.05em;flex:none}
.cmp .col.bad header{background:#6B6257}
.cmp ul{margin:0;padding:1.4em;list-style:none;display:flex;flex-direction:column;gap:.9em}
.cmp li{font-size:.98em;line-height:1.45;color:var(--ink-2);padding-left:1.3em;position:relative}
.cmp li::before{content:"";position:absolute;left:0;top:.55em;width:.4em;height:.4em;background:var(--tea)}
.cmp .col.bad li::before{background:#B0A691}

/* ── 步骤 ───────────────────────────────────────────── */
.steps{flex:1;min-height:0;display:flex;align-items:center;gap:1cqw;position:relative}
.steps::before{content:"";position:absolute;left:4%;right:4%;top:3.2em;height:1px;background:var(--rule)}
.step{flex:1;text-align:center;position:relative;min-width:0}
.step .no{width:3em;height:3em;margin:0 auto 1em;background:var(--sheet);border:1px solid var(--rule);
  color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.05em;
  font-family:var(--font-display);position:relative;z-index:1}
.step:first-child .no{background:var(--tea);border-color:var(--tea);color:var(--paper)}
.step h5{margin:0 0 .4em;font-size:1em;color:var(--tea);font-family:var(--font-display)}
.step p{margin:0;font-size:.94em;color:var(--ink-2);line-height:1.4}

/* ── 答疑 ───────────────────────────────────────────── */
.faqs{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.faq{display:flex;gap:1.1em;border-bottom:1px solid var(--rule);padding:1.1em 0;flex:1;min-height:0;align-items:flex-start}
.faq:last-child{border-bottom:0}
.faq .q{flex:0 0 2.1em;height:2.1em;background:var(--tea);color:var(--paper);display:flex;align-items:center;
  justify-content:center;font-weight:700;font-size:.78em;font-family:var(--font-display)}
.faq .bd{flex:1;min-width:0}
.faq .qq{font-size:1em;font-weight:700;color:var(--tea);margin-bottom:.5em;font-family:var(--font-display)}
.faq .aa{font-size:.94em;color:var(--ink-2);line-height:1.5}

/* ── 价格 ───────────────────────────────────────────── */
.price{flex:1;min-height:0;display:grid;grid-template-columns:42% 1fr;gap:1.8cqw}
.price .box{background:var(--void);color:var(--paper);border-left:4px solid var(--tea-lt);
  padding:2em 1.8em;display:flex;flex-direction:column;justify-content:center}
.price .lab{font-size:.71em;color:var(--tea-lt);letter-spacing:.16em;margin-bottom:1em}
.price .big{font-family:var(--font-display);font-size:3.1em;font-weight:700;line-height:1;color:var(--tea-lt)}
.price .was{font-size:1em;color:#9A9184;text-decoration:line-through;margin-top:1em}
.price .note{font-size:.71em;color:#8C8375;margin-top:.9em}
.price .right{display:flex;flex-direction:column;gap:.8em;min-width:0}
.anchor{background:var(--sheet);border:1px solid var(--rule);padding:1em 1.4em}
.anchor .k{font-size:.71em;color:var(--ink-3);letter-spacing:.1em}
.anchor .v{font-family:var(--font-display);font-size:1.5em;font-weight:700;color:var(--tea);margin-top:.15em}
.pbul{font-size:.94em;color:var(--ink-2);padding-left:1.2em;position:relative;line-height:1.4}
.pbul::before{content:"";position:absolute;left:0;top:.5em;width:.4em;height:.4em;background:var(--tea)}

/* ── 产品（左要点 + 右清单） ────────────────────────── */
.prod{flex:1;min-height:0;display:grid;grid-template-columns:51% 1fr;gap:1.6cqw}
.prod .left{border:1px solid var(--rule);background:var(--sheet);padding:1.6em}
.prod .tick{width:1.9em;height:2px;background:var(--tea);margin-bottom:.8em}
.prod .lab{font-size:.71em;color:var(--tea);letter-spacing:.14em;margin-bottom:1.1em}
.prod ul{margin:0;padding:0;list-style:none}
.prod li{font-size:1.02em;color:var(--ink-2);line-height:1.45;margin-bottom:.85em;padding-left:1.2em;position:relative}
.prod li:last-child{margin-bottom:0}
.prod li::before{content:"";position:absolute;left:0;top:.5em;width:.4em;height:.4em;background:var(--tea)}
.prod .right{background:#E7E1D5;padding:1.5em;display:flex;flex-direction:column;justify-content:center}
.prow{display:flex;gap:1em;border-bottom:1px solid var(--rule);padding:.75em 0}
.prow:last-child{border-bottom:0}
.prow .k{flex:0 0 22%;font-size:.71em;color:var(--ink-3);letter-spacing:.08em}
.prow .v{flex:1;font-size:.98em;color:var(--ink);line-height:1.35}

/* ── 行动 / 收尾（深色页） ──────────────────────────── */
.cta-body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:.4em}
.cta-item{display:flex;align-items:center;gap:1.2em;padding:1em 0;border-bottom:1px solid #2E2921}
.cta-item:last-child{border-bottom:0}
.cta-item .no{flex:0 0 2.3em;height:2.3em;background:var(--tea-lt);color:var(--void);display:flex;
  align-items:center;justify-content:center;font-weight:700;font-family:var(--font-display)}
.cta-item .tx{font-size:1.05em;color:var(--paper);line-height:1.4}
.end-body{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.end-title{font-family:var(--font-display);font-size:2.4em;font-weight:700;color:var(--paper)}
.end-rule{width:5em;height:3px;background:var(--tea-lt);margin:1.2em 0}
.end-sub{font-size:1.05em;color:#B9AE9C}
.end-bul{margin-top:1.6em;font-size:.8em;color:#8C8375;line-height:1.8}
`;

/* ──────────────────────────────── 渲染 ──────────────────────────────── */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const slideId = (s) => `s-${String(s.id || s.index).replace(/[^\w-]/g, '')}`;

/** 口播稿落到 data-notes，不显示在页面上；PPTX 的演讲者备注另有管道 */
const notesAttr = (s) =>
  s.script && s.script.length
    ? ` data-notes="${esc(s.script.map((l) => (l.cue ? `〔${l.cue}〕` : '') + (l.text || '')).join('\n'))}"`
    : '';

const foot = (s, ctx) => {
  const left = [ctx.deck.meta?.brand, s.sectionTitle].filter(Boolean).join(' · ');
  // 页码交给外壳的圆点承载，页内不放页码（SPEC 第三节硬约束 4）
  const right = s.productName && ctx.deck.meta?.productCount > 1 ? s.productName : '';
  return `<div class="foot"><span>${esc(left)}</span><span>${esc(right)}</span></div>`;
};

/** 页眉：kicker 为空串时**不要**回退成别的文字，标题上移 */
function head(s) {
  const k = s.kicker ? `<div class="kicker"><i></i><span>${esc(s.kicker)}</span></div>` : '';
  const sub = s.subtitle ? `<div class="s-sub">${esc(s.subtitle)}</div>` : '';
  return `${k}<h2 class="s-title">${esc(s.title)}</h2><div class="rule"><i></i></div>${sub}`;
}

const open = (s, cls, extra = '') =>
  `<section class="slide ${cls}${s.kicker ? '' : ' plain'}" data-slide-id="${slideId(s)}" data-type="${esc(
    s.type
  )}"${notesAttr(s)}${extra}>`;
const page = (inner) => `<div class="page">${inner}</div>`;

function cardsBlock(cards, quote) {
  const n = cards.length || 1;
  const c = n <= 2 ? 'c2' : n === 3 ? 'c3' : 'c4';
  const max = n >= 5 ? 6 : n;
  return `<div class="cards ${c}" style="grid-template-columns:repeat(${Math.min(max, 4)},1fr)${
    n > 4 ? ';grid-template-rows:repeat(2,1fr)' : ''
  }">${cards
    .map(
      (x, i) =>
        `<div class="card"><span class="ghost">${String(i + 1).padStart(2, '0')}</span><div class="tick"></div><h4>${esc(
          x.title
        )}</h4><p>${esc(x.desc)}</p></div>`
    )
    .join('')}</div>${quoteBlock(quote, 'tint')}`;
}

const quoteBlock = (q, cls = '') => (q ? `<div class="quote ${cls}">${esc(q)}</div>` : '');

/* 各 type 的页体 */
const BODIES = {
  points: (s) =>
    `<div class="list">${(s.bullets || [])
      .map(
        (t, i) =>
          `<div class="item"><div class="no">${String(i + 1).padStart(2, '0')}</div><div class="tx">${esc(t)}</div></div>`
      )
      .join('')}</div>${quoteBlock(s.quote)}`,

  cards: (s) => cardsBlock(s.cards || [], s.quote),
  hook: (s) => cardsBlock(s.cards || [], s.quote),
  tasting: (s) => cardsBlock(s.cards || [], s.quote),

  table: (s) => {
    const rows = s.table?.rows || [];
    return `<div class="rows"><div class="vline"></div>${rows
      .map((r) => `<div class="row"><div class="k">${esc(r[0])}</div><div class="v">${esc(r[1])}</div></div>`)
      .join('')}</div>${s.footnote ? `<div class="quote tint">${esc(s.footnote)}</div>` : ''}`;
  },

  compare: (s) => {
    const col = (side, bad) =>
      side
        ? `<div class="col${bad ? ' bad' : ''}"><header>${esc(side.title)}</header><ul>${(side.items || [])
            .map((i) => `<li>${esc(i)}</li>`)
            .join('')}</ul></div>`
        : '';
    return `<div class="cmp">${col(s.left, false)}${col(s.right, true)}</div>`;
  },

  steps: (s) =>
    `<div class="steps">${(s.steps || [])
      .map(
        (x, i) =>
          `<div class="step"><div class="no">${i + 1}</div><h5>${esc(x.title)}</h5><p>${esc(x.desc)}</p></div>`
      )
      .join('')}</div>${s.footnote ? `<div class="quote tint">${esc(s.footnote)}</div>` : ''}`,

  faq: (s) =>
    `<div class="faqs">${(s.faq || [])
      .map(
        (f) =>
          `<div class="faq"><div class="q">Q</div><div class="bd"><div class="qq">${esc(f.q)}</div><div class="aa">${esc(
            f.a
          )}</div></div></div>`
      )
      .join('')}</div>`,

  price: (s) => {
    const anchors = (s.anchors || [])
      .map((a) => `<div class="anchor"><div class="k">${esc(a.label)}</div><div class="v">${esc(a.value)}</div></div>`)
      .join('');
    const bul = (s.bullets || []).map((b) => `<div class="pbul">${esc(b)}</div>`).join('');
    return `<div class="price"><div class="box"><div class="lab">直播间价格</div>${
      s.price ? `<div class="big">${esc(s.price)}</div>` : ''
    }${s.comparePrice ? `<div class="was">日常价 ${esc(s.comparePrice)}</div>` : ''}</div><div class="right">${anchors}${bul}</div></div>`;
  },

  product: (s) => {
    const li = (s.bullets || [])
      .map((b) => `<li>${esc(b)}</li>`)
      .join('');
    const rows = (s.table?.rows || [])
      .map((r) => `<div class="prow"><div class="k">${esc(r[0])}</div><div class="v">${esc(r[1])}</div></div>`)
      .join('');
    return `<div class="prod"><div class="left"><div class="tick"></div><div class="lab">这款茶值得记住的地方</div><ul>${li}</ul></div><div class="right">${rows}</div></div>`;
  },

  cta: (s) =>
    `<div class="cta-body">${(s.bullets || [])
      .map(
        (t, i) =>
          `<div class="cta-item"><div class="no">${i + 1}</div><div class="tx">${esc(t)}</div></div>`
      )
      .join('')}</div>`,
};

/** 未知 type 的兜底：绝不渲染成空白页（历史存档会有旧类型） */
function fallback(s) {
  if ((s.cards || []).length) return BODIES.cards(s);
  if ((s.faq || []).length) return BODIES.faq(s);
  if ((s.steps || []).length) return BODIES.steps(s);
  if (s.table) return BODIES.table(s);
  if (s.left && s.right) return BODIES.compare(s);
  if (s.price || (s.anchors || []).length) return BODIES.price(s);
  return BODIES.points(s);
}

export function slide(s, ctx) {
  if (s.type === 'cover') {
    const year = (ctx.deck.meta?.date || '').slice(0, 4) || '';
    return `${open(s, 'grid-bg', ' data-layout="cover"')}
  <div class="page" style="justify-content:center">
    ${year ? `<div class="cover-ghost deco" aria-hidden="true">${esc(year)}</div>` : ''}
    ${
      year
        ? `<div class="seal deco" aria-hidden="true"><i></i><i style="transform:rotate(90deg)"></i><span>${esc(
            year
          )}</span></div>`
        : ''
    }
    <div class="cover-body">
      <div class="cover-left">
        ${s.kicker ? `<div class="kicker"><i></i><span>${esc(s.kicker)}</span></div>` : ''}
        <div class="cover-title">${esc(s.title)}</div>
        <div class="cover-rule"></div>
        ${s.subtitle ? `<div class="cover-sub">${esc(s.subtitle)}</div>` : ''}
      </div>
    </div>
    ${
      (s.meta || []).length
        ? `<div class="cover-meta">${(s.meta || [])
            .map((m) => `<span>${esc(m)}</span>`)
            .join('<span class="dot">·</span>')}</div>`
        : ''
    }
  </div>
</section>`;
  }

  if (s.type === 'end') {
    return `${open(s, 'void grid-bg', ' data-layout="end"')}
  <div class="page"><div class="end-body">
    <div class="end-title">${esc(s.title)}</div><div class="end-rule"></div>
    ${s.subtitle ? `<div class="end-sub">${esc(s.subtitle)}</div>` : ''}
    ${(s.bullets || []).length ? `<div class="end-bul">${(s.bullets || []).map((b) => `<div>${esc(b)}</div>`).join('')}</div>` : ''}
  </div></div>
</section>`;
  }

  const body = (BODIES[s.type] || fallback)(s);
  const dark = s.type === 'cta';
  const cls = dark ? 'void' : '';
  return `${open(s, cls, ` data-layout="${esc(s.type)}"`)}
  ${page(head(s) + `<div class="body">${body}</div>` + (dark ? '' : foot(s, ctx)))}
</section>`;
}
