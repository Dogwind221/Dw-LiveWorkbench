/**
 * 幻灯片预览的结构测试（不需要浏览器）。
 *
 * 为什么需要：预览是拼字符串生成的 HTML，标签一旦不配对，浏览器会自行"纠正"，
 * 结果往往是后面的幻灯片被嵌套进第一张里 —— 表现为整页宽度爆炸，
 * 而肉眼只看截图很难发现。这类坑已经踩过两次，所以固化成测试。
 *
 * 用法：node scripts/preview-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${extra && !cond ? ' → ' + extra : ''}`);
};

/* slides.js 是浏览器脚本（挂在 window 上），这里给个最小 shim 直接跑 */
const win = {};
globalThis.window = win;
const src = fs.readFileSync(path.join(ROOT, 'web', 'slides.js'), 'utf8');
const fn = new Function('window', `${src}\nreturn window.SlidePreview;`);
const preview = fn(win);

/** 逐标签配对检查：返回不配对的标签统计。 */
function tagBalance(html) {
  const opens = {}, closes = {};
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)(\s[^>]*)?>/g)) {
    const tag = m[1].toLowerCase();
    if (m[2] && /\/\s*$/.test(m[2])) continue; // 自闭合
    if (['br', 'img', 'input', 'hr', 'meta', 'link', 'path', 'circle', 'rect', 'use'].includes(tag)) continue;
    opens[tag] = (opens[tag] || 0) + 1;
  }
  for (const m of html.matchAll(/<\/([a-zA-Z][\w-]*)\s*>/g)) {
    const tag = m[1].toLowerCase();
    closes[tag] = (closes[tag] || 0) + 1;
  }
  const bad = [];
  for (const tag of new Set([...Object.keys(opens), ...Object.keys(closes)])) {
    const o = opens[tag] || 0;
    const c = closes[tag] || 0;
    if (o !== c) bad.push(`${tag}: 开${o}/闭${c}`);
  }
  return bad;
}

console.log('=== 预览结构测试 ===\n');

/* 每种版式都造一张，确保每个分支都被检查到 */
const slides = [
  { id: 's1', index: 1, type: 'cover', title: '封面标题', kicker: '新品首发', subtitle: '副标题', meta: ['主讲：阿茶', '2026-10-15'] },
  { id: 's2', index: 2, type: 'hook', title: '今晚只讲一件事', subtitle: '口味关键词', cards: [{ title: '悬念', desc: '描述一' }, { title: '利益', desc: '描述二' }, { title: '共鸣', desc: '描述三' }] },
  { id: 's3', index: 3, type: 'points', kicker: '关于我', title: '为什么由我来讲', bullets: ['要点一', '要点二', '要点三'], quote: '金句' },
  { id: 's4', index: 4, type: 'table', kicker: '山头档案', title: '老班章', table: { rows: [['产区', '西双版纳'], ['海拔', '1700m']] } },
  { id: 's5', index: 5, type: 'cards', title: '为什么是这个味', cards: [{ title: 'A', desc: 'a' }, { title: 'B', desc: 'b' }, { title: 'C', desc: 'c' }, { title: 'D', desc: 'd' }], quote: '引用' },
  { id: 's6', index: 6, type: 'compare', title: '对比', left: { title: '本品', items: ['一', '二'] }, right: { title: '市面', items: ['三', '四'] } },
  { id: 's7', index: 7, type: 'steps', title: '工艺', steps: [{ title: '采摘', desc: 'x' }, { title: '摊晾', desc: 'y' }, { title: '杀青', desc: 'z' }], footnote: '脚注' },
  { id: 's8', index: 8, type: 'faq', title: '答疑', faq: [{ q: '苦吗', a: '不苦' }, { q: '贵吗', a: '不贵' }] },
  { id: 's9', index: 9, type: 'price', title: '价格', price: '¥2,680', comparePrice: '¥3,280', anchors: [{ label: '每泡', value: '¥60' }], bullets: ['七天无理由'] },
  { id: 's10', index: 10, type: 'product', title: '产品', bullets: ['卖点一', '卖点二'], table: { rows: [['品名', 'X'], ['年份', '2026']] } },
  { id: 's11', index: 11, type: 'cta', kicker: '怎么买', title: '想喝的这样下单', bullets: ['第一步', '第二步'] },
  { id: 's12', index: 12, type: 'end', title: '今晚就到这儿', subtitle: '慢慢喝', bullets: ['关注一下'] },
];

let structureBad = 0;
for (const s of slides) {
  const html = preview.renderSlide(s);
  const bad = tagBalance(html);
  if (bad.length) structureBad++;
  ok(bad.length === 0, `${String(s.type).padEnd(8)} 标签配平`, bad.join(', '));
}
ok(structureBad === 0, `全部 ${slides.length} 种版式标签配平`);
console.log('');

/* 根节点类型标记必须是 st-*，否则会和正文布局类撞名（.slide s-product） */
for (const s of slides) {
  const html = preview.renderSlide(s);
  const m = html.match(/^<div class="slide ([a-z0-9-]+)"/);
  ok(!!m && m[1].startsWith('st-'), `${String(s.type).padEnd(8)} 根类名 ${m && m[1]}（须 st-*）`);
}
console.log('');

/* .idx / .notes 必须在 .slide 内部：它们是绝对定位的，也是曾经一直不显示的根因 */
for (const s of slides) {
  const html = preview.renderSlide(s);
  const closeIdx = html.lastIndexOf('</div>');
  const notesAt = html.indexOf('class="notes"');
  const idxAt = html.indexOf('class="idx"');
  ok(notesAt > 0 && notesAt < closeIdx, `${String(s.type).padEnd(8)} .notes 在 .slide 内`);
  ok(idxAt > 0 && idxAt < closeIdx, `${String(s.type).padEnd(8)} .idx 在 .slide 内`);
}
console.log('');

/* 整份方案：每张幻灯片必须恰好一个 .slide 根，且不能被别的 .slide 包住 */
const deck = {
  sections: [
    { id: 'sec1', title: '第一段', goal: '目标', minutes: 3, slideIds: ['s1'] },
    { id: 'sec2', title: '第二段', goal: '目标', minutes: 3, slideIds: ['s2'] },
  ],
  slides: [
    { ...slides[0], sectionId: 'sec1' },
    { ...slides[1], sectionId: 'sec2' },
  ],
};
const deckHtml = preview.renderDeck(deck);
ok((deckHtml.match(/class="slide st-/g) || []).length === 2, '整份方案渲染出 2 张幻灯片');
ok(tagBalance(deckHtml).length === 0, '整份方案标签配平', tagBalance(deckHtml).join(', '));

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
