/**
 * 方向 B · 瑞士国际主义 —— 由 Skill 模板生成交付页。
 *
 * 做三件事(全部可核对,任何一步匹配不到就抛错,不静默降级):
 *  1) SPEC 第五节要求「每页 1920×1080 固定尺寸 + 等比缩放 + letterbox」。
 *     Skill 的 template-swiss.html 是 100vw/100vh 的视口铺满模型 —— 窗口不是 16:9 时会被拉伸变形。
 *     这里把 #deck 改成「16:9 舞台盒」(#deck 仍留在 body 下,演讲者模式选择器不受影响),
 *     并把**页面内部**的 vw/vh 全部改写为 cqw/cqh(容器查询单位,参照物是 .slide),
 *     于是布局永远按 16:9 计算,窗口非 16:9 时只加边、不变形。
 *     #nav / #hint / 演讲者 UI / canvas.bg 属于舞台之外的外壳,保持视口单位不动。
 *  2) 换 <title>,插 2 页正文,换 SPEAKER_NOTES(示例页与示例备注一并删除)。
 *  3) 输出到 ppt-lab/design-demos/B-瑞士国际.html
 *
 * 主题色:选用 themes-swiss.md 的 🔵 克莱因蓝 IKB —— 与模板默认 :root 完全一致,
 *         因此这一项是「核对」而非「替换」(见下方 assertTheme)。
 *
 * 用法: node ppt-lab/_content/build-B.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SKILL = 'C:/Users/ASUS/.agents/skills/guizang-ppt-skill';
const TPL = `${SKILL}/assets/template-swiss.html`;
const SLIDES = 'F:/dsh/直播工作台/ppt-lab/_content/slides-B.html';
const OUT = 'F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html';

let html = readFileSync(TPL, 'utf8');
const slidesHtml = readFileSync(SLIDES, 'utf8').trimEnd();
const log = [];

/* ───────────────────────── 0 · 主题色核对(IKB) ───────────────────────── */
const IKB = {
  '--paper': '#fafaf8', '--paper-rgb': '250,250,248',
  '--ink': '#0a0a0a', '--ink-rgb': '10,10,10',
  '--grey-1': '#f0f0ee', '--grey-2': '#d4d4d2', '--grey-3': '#737373',
  '--accent': '#002FA7', '--accent-rgb': '0,47,167', '--accent-on': '#ffffff',
};
for (const [k, v] of Object.entries(IKB)) {
  const hit = html.includes(`${k}:${v};`);
  if (!hit) throw new Error(`主题色核对失败: ${k} 不是 ${v}`);
}
log.push('主题色 = themes-swiss.md 的 🔵 IKB 克莱因蓝,模板 :root 已与预设逐项一致(核对通过,无需替换)');

/* ───────────────────────── 1 · <title> ───────────────────────── */
function swapAll(needle, replacement, label, expected = 1) {
  const n = html.split(needle).length - 1;
  if (n !== expected) throw new Error(`${label}: 期望匹配 ${expected} 处,实际 ${n} 处`);
  html = html.split(needle).join(replacement);
}

swapAll('<title>[必填] 替换为 PPT 标题 · Deck Title</title>',
  '<title>老班章春茶首发 · 山外山茶事 · 瑞士国际主义</title>', 'title');

/* ───────────────────────── 2 · <style> 手术 ───────────────────────── */
const s0 = html.indexOf('<style>');
const s1 = html.indexOf('</style>');
if (s0 < 0 || s1 < 0) throw new Error('找不到 <style> 块');
let css = html.slice(s0 + '<style>'.length, s1);

const keep = [];
/** 把一段 CSS 冻结为占位符,单位转换不碰它 */
function protectText(text) { keep.push(text); return `\u0000K${keep.length - 1}\u0000`; }
function replaceOnce(needle, replacement, label) {
  const n = css.split(needle).length - 1;
  if (n !== 1) throw new Error(`style swap ${label}: 匹配 ${n} 处`);
  css = css.replace(needle, () => protectText(replacement));
}

/* 2a · 舞台盒:#deck 由「视口铺满 + 按页数展开」改成「16:9 letterbox 盒 + 横向轨道」 */
replaceOnce(
  '#deck{position:fixed;inset:0;width:10000vw;height:100vh;display:flex;flex-wrap:nowrap;transition:transform .9s cubic-bezier(.77,0,.175,1);z-index:10;will-change:transform}',
  `/* ── SPEC §5:16:9 固定舞台(1920×1080 比例)+ 等比缩放 letterbox ──
     #deck 就是舞台盒:取窗口内能容纳的最大 16:9 尺寸并居中,超出部分由 body 底色留边。
     inset:0 + margin:auto 负责居中,不用 transform(transform 留给翻页位移)。
     注意:这里绝不能加 overflow:hidden。横向轨道的其余页在 #deck 本地坐标里位于盒子右侧,
     一旦裁切,translateX 把页面移进视口也仍然是空白(实测过,第 2 页整页白)。
     视口级裁切交给 html,body{overflow:hidden}。 */
  #deck{position:fixed;inset:0;margin:auto;width:min(100vw,177.7778vh);height:min(56.25vw,100vh);display:flex;flex-wrap:nowrap;transition:transform .9s cubic-bezier(.77,0,.175,1);z-index:10;will-change:transform}`,
  '#deck 舞台盒');

/* 2b · .slide:铺满舞台 + 声明为容器(cqw/cqh 的参照物) */
replaceOnce('width:100vw;height:100vh;flex:0 0 100vw;',
  'width:100%;height:100%;flex:0 0 100%;container-type:size;', '.slide 尺寸/容器');
replaceOnce('padding:5.5vh 5vw 7vh 5vw;',
  'padding:0;', '.slide 自身 padding(canvas-mode 下由 .canvas-card 接管留白)');

/* 2c · 舞台外的外壳保持视口单位(只有这三条规则带单位) */
replaceOnce('canvas.bg{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block;opacity:.55;mix-blend-mode:multiply;pointer-events:none}',
  'canvas.bg{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block;opacity:.55;mix-blend-mode:multiply;pointer-events:none}',
  'canvas.bg(视口单位保留)');
replaceOnce('#nav{position:fixed;left:50%;bottom:2vh;transform:translateX(-50%);z-index:30;display:flex;gap:10px;padding:0;background:transparent;border:0}',
  '#nav{position:fixed;left:50%;bottom:2vh;transform:translateX(-50%);z-index:30;display:flex;gap:10px;padding:0;background:transparent;border:0}',
  '#nav(视口单位保留)');
replaceOnce('#hint{position:fixed;bottom:2.4vh;right:2.5vw;z-index:30;display:flex;align-items:center;gap:.65em;font-family:var(--mono);font-size:14px;letter-spacing:.14em;text-transform:uppercase;opacity:.4}',
  '#hint{position:fixed;bottom:2.4vh;right:2.5vw;z-index:30;display:flex;align-items:center;gap:.65em;font-family:var(--mono);font-size:14px;letter-spacing:.14em;text-transform:uppercase;opacity:.4}',
  '#hint(视口单位保留)');
{
  const a = css.indexOf('/* ============ 演讲者模式 ============ */');
  const b = css.indexOf('/* ============ /演讲者模式 ============ */');
  if (a < 0 || b < 0 || b < a) throw new Error('找不到演讲者模式 CSS 区块');
  const bEnd = b + '/* ============ /演讲者模式 ============ */'.length;
  css = css.slice(0, a) + protectText(css.slice(a, bEnd)) + css.slice(bEnd);
}

/* 2d · 删掉 900px 响应式降级:固定舞台下不存在「小屏重排」 */
{
  const mi = css.indexOf('@media (max-width:900px){');
  if (mi < 0) throw new Error('找不到末尾 900px 响应式块');
  let depth = 0, end = -1;
  for (let i = css.indexOf('{', mi); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('900px 响应式块括号不闭合');
  css = css.slice(0, mi) +
    '/* 固定 16:9 舞台:取消响应式降级,布局永远按 1920×1080 的比例计算 */' +
    css.slice(end + 1);
}

/* 2e · 舞台内部单位换算 vw/vh → cqw/cqh */
const beforeVw = (css.match(/vw\b/g) || []).length;
const beforeVh = (css.match(/vh\b/g) || []).length;
css = css.replace(/vw\b/g, 'cqw').replace(/vh\b/g, 'cqh');
const afterVw = (css.match(/vw\b/g) || []).length;
const afterVh = (css.match(/vh\b/g) || []).length;

css = css.replace(/\u0000K(\d+)\u0000/g, (_, i) => keep[Number(i)]);
html = html.slice(0, s0 + '<style>'.length) + css + html.slice(s1);
log.push(`舞台内单位换算:vw ${beforeVw}→${afterVw} 处、vh ${beforeVh}→${afterVh} 处(剩下的都在 #nav/#hint/演讲者 UI/canvas.bg 等舞台外外壳上)`);

/* ───────────────────────── 3 · 翻页 JS(舞台几何) ───────────────────────── */
swapAll("deck.style.width=(total*100)+'vw';",
  '/* 16:9 固定舞台:#deck 即舞台盒,宽度由 CSS 的 min() 决定,不再按页数展开 */', 'deck 宽度赋值');
swapAll('translateX(${-idx*100}vw)', 'translateX(${-idx*100}%)', '翻页位移');
/* 横向轨道里非当前页仍然留在 DOM 中(离屏 1920px),对辅助技术属于噪音;
   标记 aria-hidden 后,离屏页既不会被读屏读到,也不会被「可见性测量」当成越界。 */
swapAll('function go(n,opts={}){',
  `/* 初始:只有第 1 页对辅助技术可见 */
slides.forEach((s,i)=>s.setAttribute('aria-hidden', i===0 ? 'false' : 'true'));

function go(n,opts={}){`, 'go() 前的 aria-hidden 初始化');
swapAll('window.__currentSlideIndex = idx;',
  `window.__currentSlideIndex = idx;
  slides.forEach((s,i)=>s.setAttribute('aria-hidden', i===idx ? 'false' : 'true'));`, 'go() 内的 aria-hidden 切换');

/* ───────────────────────── 4 · 插页 + 备注 ───────────────────────── */
{
  const start = html.indexOf('<!-- SLIDES_HERE');
  if (start < 0) throw new Error('找不到 SLIDES_HERE 占位');
  const navIdx = html.indexOf('<div id="nav">');
  if (navIdx < 0) throw new Error('找不到 #nav');
  const lastSection = html.lastIndexOf('</section>', navIdx);
  if (lastSection < 0) throw new Error('找不到示例页结尾');
  html = html.slice(0, start) + slidesHtml + '\n\n' + html.slice(lastSection + '</section>'.length);
  log.push('已用 2 页正文替换模板示例页(示例页与示例备注中的占位文字全部移除)');
}

const NOTES = [
  {
    id: 'cover', title: '老班章春茶首发', section: '开场', minutes: 0.6,
    purpose: '一页说清本场主角与规格,让刚进直播间的观众立刻知道在卖什么',
    talk: [
      '先报山头与年份,不急着讲价格',
      '把 357g/饼 的规格说清楚,后面不必反复解释',
      '说明本场只讲这一款茶,约 30 分钟',
    ],
    transition: '从「是什么」转到「为什么这个味」',
    cue: '停顿一秒再切页,确认画面已经落到封面',
  },
  {
    id: 'why-this-taste', title: '为什么是这个味', section: '山场逻辑', minutes: 2.2,
    purpose: '把「山场条件 → 树的状态 → 杯中表现」讲成一条因果链,让味道有出处',
    talk: [
      '沿时间线从左往右讲,不要跳着说',
      '海拔与温差、土壤与根系是同一层山场条件,先讲这两条',
      '再说树龄与产量:古树主体约 200 - 400 年,单株产量低,一芽两叶的采摘窗口短',
      '最后落到杯子里:苦底化得快、回甘强、茶气足、汤感厚、香气偏兰香',
      '强调这是同一块地连续发生的结果,而不是四个并列卖点',
    ],
    transition: '味道有出处之后,自然接到工艺与品鉴',
    advance: '每个节点停一拍,让观众看清序号走到 04',
  },
];
{
  const a = html.indexOf('const SPEAKER_NOTES = [');
  const b = html.indexOf('window.__SPEAKER_NOTES__');
  if (a < 0 || b < 0) throw new Error('找不到 SPEAKER_NOTES');
  const body = JSON.stringify(NOTES, null, 2).replace(/\n/g, '\n');
  html = html.slice(0, a) + `const SPEAKER_NOTES = ${body};\n` + html.slice(b);
  log.push('SPEAKER_NOTES 已换成 2 页对应的备注(id 与 data-slide-id 一致)');
}

/* ───────────────────────── 5 · 写盘 + 自检 ───────────────────────── */
const leftovers = ['[必填]', '[选填]', 'Deck Title', 'NN / NN', 'SLIDES_HERE'].filter(k => html.includes(k));
if (leftovers.length) throw new Error('残留占位文字: ' + leftovers.join(', '));

writeFileSync(OUT, html, 'utf8');
log.push(`已写出 ${OUT} (${Buffer.byteLength(html, 'utf8')} bytes)`);
const slideTags = [...html.matchAll(/<section class="slide[^>]*>/g)].map(m => m[0]);
log.push('页面:' + slideTags.map(t => (t.match(/data-layout="([^"]+)"/) || [])[1]).join(' / '));
console.log(log.map(l => '· ' + l).join('\n'));
