/**
 * HTML 幻灯片外壳：把「各风格的页内容」装进一个能用的 deck 运行时。
 *
 * 分工：
 *   shell.mjs  —— 舞台、翻页、缩放、进度、打印（所有风格共用，风格不该重写这些）
 *   <style>.mjs —— 只提供两样东西：css（该风格的样式）+ slide(s, ctx)（一页的 <section>）
 *
 * 这里刻意把两个已经踩过的坑固化进外壳，让任何风格都无法再犯：
 *
 * 1) **裁剪层与位移层必须分开**。同一个元素既 overflow:hidden 又被 translateX，
 *    它的裁剪框会跟着自己平移，要展示的那一页落在裁剪框之外被自己裁掉 ——
 *    症状是「第 2 页整页空白，而 DOM 里文字齐全」，只查 DOM 查不出来。
 *    所以 #deck-stage 负责取 16:9 舞台并裁剪（不位移），#deck 只负责位移。
 *
 * 2) **正文可读性下限**由外壳统一兜底（直播投屏场景）：正文 ≥20px、描述 ≥18px、
 *    标签 ≥14px。各风格可以更大，但不能更小。
 */

/** HTML 转义 */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 属性值转义（比 esc 更严，用于 id/class 这类属性） */
export function attr(v) {
  return esc(v).replace(/'/g, '&#39;');
}

/**
 * 外壳自带的基础样式。
 * 设计基调（纸色、字体、强调色）一律由风格模块的 css 决定；这里只管舞台与运行时。
 */
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0d0d0d}
body{padding:0;-webkit-font-smoothing:antialiased}

/* 舞台：16:9 letterbox，居中 */
#deck-stage{position:fixed;inset:0;margin:auto;width:min(100vw,177.7778vh);height:min(56.25vw,100vh);overflow:hidden;z-index:10;background:var(--paper,#fff)}
#deck{position:absolute;inset:0;display:flex;flex-wrap:nowrap;transition:transform .55s cubic-bezier(.77,0,.175,1);will-change:transform}
#deck.no-anim{transition:none}

/* 一页 */
.slide{width:100%;height:100%;flex:0 0 100%;position:relative;overflow:hidden;container-type:size;
  background:var(--paper,#fff);color:var(--ink,#111);display:flex;flex-direction:column}

/* 承载页面底色的子元素。
   ⚠️ 为什么必须有这一层：转 PPTX 的脚本遍历的是页面的**子元素**，
   .slide 自己身上的 background 采集不到 —— 结果深色页转出来是白底 + 浅字，
   文字几乎不可见（实测杂志风封面就是这样）。工具虽有 --bg 参数，但那是全局单色，
   表达不了逐页明暗节奏。所以把底色复制到一个子元素上，让每页各自的底色都能被采集。
   z-index:-1 让它落在父级背景之上、内容之下，HTML 观感完全不变。 */
.slide-bg{position:absolute;inset:0;background:inherit;z-index:-1;pointer-events:none}

/* 基准字号：1.05cqw ≈ 20px @1920 设计尺寸，并随舞台整体缩放。
   ⚠️ cqw 绝不能写在 .slide 自己身上 —— 那样最近的容器是外层（没有就是视口），
   基准会变成视口宽度的百分比，所有 em 跟着乱掉。写在子元素上才是舞台的 cqw。

   基准要落在 .page 上：直接写在 .slide > * 上是不够的 —— 子元素自己声明的
   font-size（例如 .foot{font-size:.72em}）会以 **父级** 字号为基准重新计算，
   于是那些 em 全部按 body 的 16px 算，而不是按 1.05cqw。实测 .foot 因此只有
   11.4px，跌破 14px 底线。 */
.page{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;
  padding:7.4cqh 6.4cqw 8.4cqh;font-size:1.05cqw;position:relative}
.slide > *{font-size:1.05cqw}
.slide.plain .page{padding-top:5.5cqh}

/* 页眉：眉标 + 标题 + 分隔线（风格可覆写外观，但结构统一） */
.kicker{display:flex;align-items:center;gap:.5em;font-size:.72em;font-weight:700;letter-spacing:.16em;height:1.2em;flex:none}
.kicker i{width:.36em;height:.36em;border-radius:50%;background:currentColor;flex:none}
.s-title{font-size:1.55em;font-weight:700;line-height:1.1;margin:.5em 0 0;flex:none}
.rule{position:relative;height:1px;background:var(--rule,#ddd);margin:1.15em 0 0;flex:none}
.rule i{position:absolute;left:0;top:-1.5px;width:3.2em;height:3px;background:var(--tea,#b98a3c)}
.s-sub{font-size:.78em;margin-top:.8em;flex:none}
/* 标签 / 注释的统一下限类（≈14.5px @1920） */
.slide .micro{font-size:.72em}
.body{flex:1;min-height:0;margin-top:1.4em;display:flex;flex-direction:column}

/* 页脚：放在 .page 内部（这样它继承基准字号；放在 .slide 下会按 16px 算 em）。
   left/right 必须跟 .page 的左右内边距对齐 —— 用 left:0/right:0 会横跨整个 1920，
   转 PPTX 时文本框宽度会超出画布（实测 1932 > 1920）。 */
.foot{position:absolute;left:6.4cqw;right:6.4cqw;bottom:2.6cqh;display:flex;justify-content:space-between;
  gap:2em;font-size:.72em;letter-spacing:.06em;border-top:1px solid var(--rule,#ddd);padding-top:1.4cqh;flex:none}

/* 翻页 UI */
#hint{position:fixed;right:18px;bottom:14px;z-index:30;display:flex;align-items:center;gap:10px;
  font:600 13px/1.4 var(--font-sans,system-ui,sans-serif);color:#8b8b8b;letter-spacing:.04em;
  background:rgba(255,255,255,.72);backdrop-filter:blur(6px);border-radius:999px;padding:7px 13px}
body.dark-hint #hint{background:rgba(0,0,0,.42);color:#cfcfcf}
body.low-power #hint{opacity:1}
#hint kbd{font:inherit;border:1px solid currentColor;border-radius:4px;padding:1px 5px;opacity:.75}
#dots{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:30;display:flex;gap:7px}
#dots span{width:7px;height:7px;background:rgba(128,128,128,.45)}
#dots span.on{background:var(--tea,#b98a3c)}

/* 总览：ESC */
body.overview #deck-stage{width:min(96vw,170.6vh);height:min(54vw,96vh)}
#overview{position:fixed;inset:0;z-index:60;display:none;overflow:auto;padding:4vh 4vw;
  background:rgba(12,12,12,.94)}
body.overview #overview{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px;align-content:start}
#overview button{padding:0;border:0;cursor:pointer;background:none;text-align:left}
#overview .ov-no{font:600 12px/1 var(--font-sans,system-ui,sans-serif);color:#9a9a9a;margin-bottom:6px;display:block}
#overview iframe{width:100%;aspect-ratio:16/9;border:2px solid transparent;background:#fff;pointer-events:none}
#overview button:hover iframe{border-color:var(--tea,#b98a3c)}

/* 平铺模式：供 HTML→PPTX 转换用，必须所有页同时可见（转换脚本会跳过隐藏元素） */
body.flat{overflow:auto}
body.flat #deck-stage{position:static;width:1920px;height:auto;overflow:visible;margin:0}
body.flat #deck{position:static;transform:none!important;flex-direction:column;transition:none}
body.flat .slide{width:1920px;height:1080px;flex:none;margin:0 auto 24px;overflow:hidden}
body.flat #hint,body.flat #dots,body.flat #overview{display:none!important}

/* 打印：一页一张 */
@media print{
  @page{size:landscape;margin:0}
  html,body{overflow:visible;background:#fff}
  #deck-stage{position:static;width:100%;height:auto;overflow:visible;margin:0}
  #deck{position:static;transform:none!important;flex-direction:column;transition:none}
  .slide{width:100%;height:100vh;flex:none;page-break-after:always;break-after:page}
  #hint,#dots,#overview{display:none!important}
}
`;

/** 翻页与缩放的运行时 */
const RUNTIME_JS = `
(function(){
  var deck = document.getElementById('deck');
  var slides = Array.prototype.slice.call(deck.querySelectorAll('.slide'));
  var dots = document.getElementById('dots');
  var i = 0, flat = document.body.classList.contains('flat');

  if (dots) dots.innerHTML = slides.map(function(_, n){ return '<span' + (n===0?' class="on"':'') + '></span>'; }).join('');
  var dotEls = dots ? Array.prototype.slice.call(dots.children) : [];

  function paint(){
    deck.style.transform = 'translateX(' + (-i * 100) + '%)';
    slides.forEach(function(s, n){
      // flat 模式（导出 / 逐页验收用）所有页同时铺在画面里，本来就不存在"当前页"。
      // 这里给其余页打 aria-hidden 会**让验收脚本把它们当装饰跳过** ——
      // 实测后果：字号 / 对比度 / 越界三项只量到第 1 页，后面几十页全是绿的假象。
      if (flat) s.removeAttribute('aria-hidden');
      else s.setAttribute('aria-hidden', n === i ? 'false' : 'true');
    });
    dotEls.forEach(function(d, n){ d.classList.toggle('on', n === i); });
  }
  function go(n){
    if (flat) return;
    i = Math.max(0, Math.min(n, slides.length - 1));
    paint();
  }
  function reveal(){
    // 入场动效统一由外壳负责：只给当前页加 .in，风格自己决定怎么用
    slides.forEach(function(s){ s.classList.remove('in'); });
    if (slides[i]) void slides[i].offsetWidth, slides[i].classList.add('in');
  }

  window.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(i+1); reveal(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(i-1); reveal(); }
    else if (e.key === 'Home') { go(0); reveal(); }
    else if (e.key === 'End') { go(slides.length-1); reveal(); }
    else if (e.key === 'b' || e.key === 'B') { document.body.classList.toggle('low-power'); }
    else if (e.key === 'Escape') { document.body.classList.toggle('overview'); }
  });
  document.addEventListener('click', function(e){
    if (flat || e.target.closest('#hint,#dots,#overview,a,button')) return;
    var x = e.clientX / window.innerWidth;
    if (x > 0.62) { go(i+1); reveal(); } else if (x < 0.38) { go(i-1); reveal(); }
  });

  // 总览里用 iframe 复用同一份文档，但要停在对应页
  var ov = document.getElementById('overview');
  if (ov) {
    ov.addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b) return;
      go(Number(b.dataset.go)); reveal(); document.body.classList.remove('overview');
    });
  }

  paint(); reveal();
  window.__deck = { go: go, reveal: reveal, count: slides.length, current: function(){ return i; } };
})();
`;

/**
 * 渲染整份 HTML。
 *
 * @param {object} deck      DeckSpec
 * @param {object} style     风格模块（含 css 与 slide()）
 * @param {object} [opts]
 * @param {'present'|'flat'} [opts.mode]  flat = 所有页同时可见，供 HTML→PPTX 转换
 * @param {string} [opts.title]
 * @returns {string} 单文件 HTML
 */
export function renderDeckHtml(deck, style, opts = {}) {
  const mode = opts.mode === 'flat' ? 'flat' : 'present';
  const meta = deck.meta || {};
  const title = opts.title || meta.title || '直播方案';
  const slides = deck.slides || [];
  const bodyClass = [mode === 'flat' ? 'flat' : '', style.darkHint ? 'dark-hint' : ''].filter(Boolean).join(' ');

  const sections = slides
    .map((s, n) => {
      const html = style.slide({ ...s, index: s.index ?? n + 1 }, { deck, style, mode, total: slides.length });
      // 把 .slide-bg 插进每个 <section> 的最前面（见上面 CSS 的说明）。
      // 外壳集中做，风格模块不用管，也不会漏。
      // NO_SLIDE_BG=1 可关掉注入 —— 这是给验收脚本做阳性对照用的
      // （关掉后 style-pptx-check 的「逐页比底色」必须报错，否则那个检查是假的）。
      if (process.env.NO_SLIDE_BG) return html;
      return html.replace(/^(<section\b[^>]*>)/, '$1<div class="slide-bg" aria-hidden="true"></div>');
    })
    .join('\n');

  const overview =
    mode === 'flat'
      ? ''
      : `<div id="overview">${slides
          .map(
            (s, n) =>
              `<button type="button" data-go="${n}"><span class="ov-no">${String(n + 1).padStart(2, '0')} · ${esc(
                s.title || s.type
              )}</span></button>`
          )
          .join('')}</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}${style.css || ''}</style>
</head>
<body class="${attr(bodyClass)}">
<div id="deck-stage"><div id="deck">
${sections}
</div></div>
${overview}
<div id="dots"></div>
<div id="hint"><kbd>←</kbd><kbd>→</kbd> 翻页 · <kbd>B</kbd> 静态 · <kbd>ESC</kbd> 总览</div>
<script>${RUNTIME_JS}</script>
</body>
</html>`;
}

export { BASE_CSS, RUNTIME_JS };
