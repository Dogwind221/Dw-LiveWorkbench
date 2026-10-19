/* ==========================================================================
   幻灯片预览渲染器

   目标：在浏览器里还原 python-pptx 渲染出来的版式，
   让用户在导出前就看到成品长什么样。

   ⚠️ 这里和 pipelines/build_pptx.py 是一对：任何一侧改了版式，另一侧必须同步，
   否则预览就是在骗人。两边共用同一套设计变量：
     页面底色 #FAF7F2 / 墨绿 #14302A / 主绿 #2C5A4C / 茶金 #B98A3C
     分隔线 #E7E0D4 / 幽灵序号 #E4DCCB
   ========================================================================== */
(function () {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** 茶叶叶形纹样：和 PPT 里用 freeform 画的是同一套形状语言。 */
  const leafSvg = (style) =>
    `<svg class="s-leaf" viewBox="0 0 200 220" preserveAspectRatio="none" style="${style}" aria-hidden="true">
      <path d="M100,6 C158,54 162,138 100,214 C38,138 42,54 100,6 Z" fill="currentColor"/>
    </svg>`;

  /**
   * 页眉 + 正文容器的**开始**标签。
   *
   * ⚠️ 它开了 `.pad` 和 `.s-body` 两层，必须由 HEAD_CLOSE 配对关闭。
   * 早期版本把这层闭合交给字符串末尾几个「多余」的 `</div>`，结果 `.slide`
   * 自己从来没被闭合，后面的幻灯片全被嵌套进第一张里（版式直接炸掉）。
   * 所以这里显式配对：headOpen(s) … HEAD_CLOSE。
   */
  const HEAD_CLOSE = '</div></div>';

  const head = (s) => {
    const kicker = s.kicker ? `<div class="s-kicker"><i></i><span>${esc(s.kicker)}</span></div>` : '';
    const sub = s.subtitle ? `<div class="s-sub">${esc(s.subtitle)}</div>` : '';
    return `<div class="pad${s.kicker ? '' : ' no-kicker'}">
      ${kicker}
      <div class="s-title">${esc(s.title)}</div>
      <div class="s-rule"><i></i></div>
      ${sub}
      <div class="s-body">`;
  };

  const ghost = (n) => `<div class="s-ghost">${String(n).padStart(2, '0')}</div>`;

  function bodyPoints(s) {
    const items = (s.bullets || [])
      .map((t, i) => `<div class="s-item">${ghost(i + 1)}<div class="s-itemtext">${esc(t)}</div></div>`)
      .join('');
    const q = s.quote ? `<div class="s-quote">${esc(s.quote)}</div>` : '';
    return `<div class="s-list${q ? ' with-quote' : ''}">${items}</div>${q}`;
  }

  function bodyCards(s) {
    const cards = s.cards || [];
    const n = cards.length || 1;
    const cols = n <= 3 ? n : 2;
    const inner = cards
      .map(
        (c, i) =>
          `<div class="s-card"><div class="s-tick"></div>${ghost(i + 1)}<h4>${esc(c.title)}</h4><p>${esc(c.desc)}</p></div>`
      )
      .join('');
    const q = s.quote ? `<div class="s-quote tint">${esc(s.quote)}</div>` : '';
    return `<div class="s-cards${q ? ' with-quote' : ''}" style="grid-template-columns:repeat(${cols},1fr)">${inner}</div>${q}`;
  }

  /** 编辑式清单：标签 / 值 / 细分隔线，取代色块表格 */
  function bodyTable(s) {
    const rows = (s.table && s.table.rows) || [];
    return `<div class="s-rows">${rows
      .map((r) => `<div class="s-row"><div class="s-rowlab">${esc(r[0])}</div><div class="s-rowval">${esc(r[1])}</div></div>`)
      .join('')}</div>`;
  }

  function bodyCompare(s) {
    const col = (side, bad) => {
      if (!side) return '';
      const items = (side.items || []).map((i) => `<li>${esc(i)}</li>`).join('');
      return `<div class="s-col${bad ? ' bad' : ''}"><header>${esc(side.title)}</header><ul>${items}</ul></div>`;
    };
    return `<div class="s-compare">${col(s.left, false)}${col(s.right, true)}</div>`;
  }

  function bodySteps(s) {
    const steps = s.steps || [];
    const dense = steps.length >= 5;
    const inner = steps
      .map((st, i) => `<div class="s-step"><div class="c">${i + 1}</div><h5>${esc(st.title)}</h5><p>${esc(st.desc)}</p></div>`)
      .join('');
    const fn = s.footnote ? `<div class="s-quote tint">${esc(s.footnote)}</div>` : '';
    return `<div class="s-steps${dense ? ' dense' : ''}">${inner}</div>${fn}`;
  }

  function bodyFaq(s) {
    return `<div class="s-faqs">${(s.faq || [])
      .map(
        (f) =>
          `<div class="s-faqitem"><div class="s-qbadge">Q</div><div class="s-faqtext"><div class="q">${esc(
            f.q
          )}</div><div class="a">${esc(f.a)}</div></div></div>`
      )
      .join('')}</div>`;
  }

  function bodyPrice(s) {
    const anchors = (s.anchors || [])
      .map((a) => `<div class="s-anchor"><div class="k">${esc(a.label)}</div><div class="v">${esc(a.value)}</div></div>`)
      .join('');
    const bul = (s.bullets || []).map((b) => `<div class="s-pricebul">${esc(b)}</div>`).join('');
    const box = `<div class="s-pricebox">
      <div class="lab">直播间价格</div>
      ${s.price ? `<div class="big">${esc(s.price)}</div>` : ''}
      ${s.comparePrice ? `<div class="was">日常价 ${esc(s.comparePrice)}</div>` : ''}
      <div class="note">直播期间有效，结束后恢复日常价</div></div>`;
    return `<div class="s-price">${box}<div class="s-priceright"><div class="s-anchors">${anchors}</div>${bul}</div></div>`;
  }

  function bodyProduct(s) {
    const li = (s.bullets || []).slice(0, 4).map((b) => `<li>${esc(b)}</li>`).join('');
    const rows = ((s.table && s.table.rows) || [])
      .map((r) => `<div class="prow"><div class="k">${esc(r[0])}</div><div class="v">${esc(r[1])}</div></div>`)
      .join('');
    return `<div class="s-product">
      <div class="left"><div class="tick"></div><div class="lab">这款茶值得记住的地方</div><ul>${li}</ul></div>
      <div class="right">${rows}</div></div>`;
  }

  function bodyCta(s) {
    return (s.bullets || [])
      .map((t, i) => `<div class="s-cta-item"><div class="n">${i + 1}</div><div class="t">${esc(t)}</div></div>`)
      .join('');
  }

  const BODIES = {
    points: bodyPoints,
    cards: bodyCards,
    hook: bodyCards,
    tasting: bodyCards,
    table: bodyTable,
    compare: bodyCompare,
    steps: bodySteps,
    faq: bodyFaq,
    price: bodyPrice,
    product: bodyProduct,
    cta: bodyCta,
  };

  /** 版式回退：按内容挑版式，避免新增类型（或历史存档里的旧类型）在预览里变成空白页。 */
  function resolveBody(s) {
    const t = s.type;
    if (BODIES[t]) return BODIES[t];
    if ((s.cards || []).length) return bodyCards;
    if ((s.faq || []).length) return bodyFaq;
    if ((s.steps || []).length) return bodySteps;
    if (s.table) return bodyTable;
    if (s.left && s.right) return bodyCompare;
    if (s.price || (s.anchors || []).length) return bodyPrice;
    return bodyPoints;
  }

  /**
   * 注意：`.idx` 和 `.notes` 必须放在 `.slide` 内部。
   * 它们是绝对定位的，放在外面会以更外层的包含块定位；而且 `.slide .notes`
   * 这样的选择器也匹配不到兄弟节点——之前备注面板一直不显示就是这个原因。
   */
  function renderSlide(s) {
    const type = s.type || 'points';
    const idx = String(s.index || 0).padStart(2, '0');
    const notesHtml = (s.script || [])
      .map((l) => (l.cue ? `<b>〔${esc(l.cue)}〕</b>${esc(l.text)}` : esc(l.text)))
      .join('<br>');
    const tail = `<div class="idx">${idx}</div><div class="notes">${notesHtml}</div>`;

    if (type === 'cover') {
      return `<div class="slide st-cover" data-sid="${s.id}">
        ${leafSvg('right:-8%;top:6%;width:48%;height:76%;color:rgba(255,255,255,.07)')}
        ${leafSvg('right:1%;bottom:-6%;width:24%;height:40%;color:rgba(226,196,140,.10)')}
        <div class="spine"></div>
        <div class="ring r1"></div><div class="ring r2"></div><div class="dot"></div>
        ${s.kicker ? `<div class="pill">${esc(s.kicker)}</div>` : ''}
        <div class="s-title">${esc(s.title)}</div>
        <div class="s-rule solo"><i></i></div>
        ${s.subtitle ? `<div class="s-sub">${esc(s.subtitle)}</div>` : ''}
        <div class="cover-meta">${(s.meta || []).map((m) => `<div>${esc(m)}</div>`).join('')}</div>
        ${tail}</div>`;
    }

    if (type === 'cta') {
      return `<div class="slide st-cta" data-sid="${s.id}">
        <div class="spine"></div>
        ${leafSvg('right:-6%;top:8%;width:40%;height:66%;color:rgba(255,255,255,.06)')}
        <div class="pad"><div class="s-kicker"><i></i><span>${esc(s.kicker || '')}</span></div>
        <div class="s-title">${esc(s.title)}</div></div>
        <div class="cta-body">${bodyCta(s)}</div>
        ${tail}</div>`;
    }

    if (type === 'end') {
      return `<div class="slide st-end" data-sid="${s.id}">
        ${leafSvg('left:24%;top:6%;width:52%;height:66%;color:rgba(255,255,255,.06)')}
        <div class="ring"></div>
        <div class="leafmark">${leafSvg('width:100%;height:100%;color:#E2C48C')}</div>
        <div class="s-title">${esc(s.title)}</div>
        ${s.subtitle ? `<div class="s-sub">${esc(s.subtitle)}</div>` : ''}
        ${
          (s.bullets || []).length
            ? `<div class="endbul">${(s.bullets || []).map((b) => `<div>${esc(b)}</div>`).join('')}</div>`
            : ''
        }
        ${tail}</div>`;
    }

    const fn = resolveBody(s);
    const foot = `<div class="s-foot"><span>${esc(s.sectionTitle || '')}</span><span>${idx}</span></div>`;
    // 根节点用 st-<type> 命名空间：s-* 留给正文布局类，
    // 否则 .slide s-product 会和正文的 .s-product 撞名，把幻灯片根节点变成两列 grid
    return `<div class="slide st-${type}" data-sid="${s.id}">${head(s)}${fn(s)}${HEAD_CLOSE}${foot}${tail}</div>`;
  }

  /** 按段落分组渲染整份方案。 */
  function renderDeck(deck) {
    const sections = deck.sections || [];
    const slides = deck.slides || [];
    return sections
      .map((sec, i) => {
        const ss = slides.filter((s) => s.sectionId === sec.id);
        if (!ss.length) return '';
        return `<div class="deck-section">
          <div class="section-head">
            <span class="n">${String(i + 1).padStart(2, '0')}</span>
            <span class="t">${esc(sec.title)}</span>
            <span class="g">${esc(sec.goal)} · 计划 ${sec.minutes} 分钟 · ${ss.length} 页</span>
          </div>
          <div class="slides">${ss.map((s) => `<div class="slide-wrap">${renderSlide(s)}${slideTools(s)}</div>`).join('')}</div>
        </div>`;
      })
      .join('');
  }

  function slideTools(s) {
    return `<div class="slide-tools">
      <span class="chip grey">${s.type}</span>
      <span class="chip">${s.minutes} 分钟</span>
      <span class="chip amber">${(s.script || []).length} 句口播</span>
      <button class="btn sm ghost" data-toggle-notes="${s.id}">看备注</button>
    </div>`;
  }

  window.SlidePreview = { renderSlide, renderDeck, esc };
})();
