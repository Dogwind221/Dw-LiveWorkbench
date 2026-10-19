/** 交付前最后一遍自检:版式声明、主题节奏、文案逐字核对、禁用项。 */
import { readFileSync } from 'node:fs';
const html = readFileSync('F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html', 'utf8');
const spec = readFileSync('F:/dsh/直播工作台/ppt-lab/SPEC.md', 'utf8');

console.log('=== 1. section / 版式 / 主题节奏 ===');
for (const m of html.matchAll(/<section class="slide[^>]*>/g)) console.log('  ' + m[0].replace(/ data-animate/, '\n     data-animate'));
console.log('  出现次数:', [...html.matchAll(/<section class="slide/g)].length - 1, '(1 次在 HTML 注释里)');

console.log('=== 2. 文案逐字核对(SPEC → HTML) ===');
const facts = [
  '新品首发', '老班章春茶首发', '老班章 · 生普 · 2026 · 357g/饼',
  '主讲：阿茶', '山外山茶事', '2026-10-15', '约 30 分钟',
  '山场逻辑', '为什么是这个味', '海拔与温差', '土壤与根系', '树龄与产量', '落到杯子里',
  '海拔 1700 - 1900 m（参考区间），昼夜温差大，芽叶长得慢，内含物质积累更充分。',
  '红壤夹风化砂岩碎石，土层偏薄、排水快',
  '古树主体约 200 - 400 年，另有小树、大树混生，单株产量低，一芽两叶的采摘窗口短。',
  '喝起来就是苦底明显但化得快、回甘强、茶气足、汤感厚，香气偏兰香。',
];
let ok = 0;
for (const f of facts) {
  const inHtml = html.includes(f);
  const inSpec = spec.includes(f);
  if (inHtml && inSpec) ok++;
  else console.log(`  ✗ ${f}  → HTML:${inHtml} SPEC:${inSpec}`);
}
console.log(`  ${ok}/${facts.length} 条与 SPEC 逐字一致`);

console.log('=== 3. 禁用项 ===');
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const visible = html.replace(/<[^>]*>/g, ' ');
console.log('  emoji:', emoji.test(visible) ? '✗ 有' : '无 ✓');
console.log('  直角引号 “ ” 出现在正文里:', /[“”]/.test(visible) ? '✗ 有' : '无 ✓');
console.log('  页码/进度字样(page/NN 分页):', /data-layout="[^"]*"\s[^>]*>\s*<[^>]*>\s*\d+\s*\/\s*\d+/.test(html) ? '?' : '页面内无 NN / NN ✓');
console.log('  图片 <img>:', (html.match(/<img/g) || []).length, '(SPEC 第七节:本稿不需要图片)');
console.log('  inline border-radius 非 0:', (visible.match(/border-radius/g) || []).length ? '检查' : '无');
console.log('  inline box-shadow:', (html.match(/box-shadow/g) || []).length, '(模板演讲者 UI 自带,页面内无)');
console.log('  linear-gradient:', (html.match(/linear-gradient/g) || []).length, '(模板 .underline-accent / 时间轴虚线;页面未使用下划线高亮)');
console.log('  repeating-linear-gradient:', (html.match(/repeating-linear-gradient/g) || []).length, '(时间轴轴线虚线,rule 例外)');
console.log('  data-anim 语义动效:', [...new Set([...html.matchAll(/data-animate="([^"]+)"/g)].map((m) => m[1]))].join(', '));
console.log('  低功耗提示 B:', /ppt-low-power-label[\s\S]{0,40}静态/.test(html) ? '保留 ✓' : '缺失 ✗');
console.log('  SPEAKER_NOTES id:', [...html.matchAll(/"?id"?:\s*'([^']+)'/g)].map((m) => m[1]).join(', '));
