/**
 * 文案体检：扫生成出来的方案里有没有半角引号（契约要求中文用「」）。
 *
 * 为什么单独立一个：直引号来自生成引擎的文案模板与事实拼装，不在任何风格模块里。
 * 光看某个风格渲出来的页面，很容易以为「就那一处」——实测六种场次共 133 处、
 * 散落在 blocks.mjs / expand.mjs 的几十个模板里。这里把五种 purpose 全跑一遍摊平了扫，
 * 任何新增文案重新引入直引号都会被这条拦住。
 *
 * 用法：node scripts/copy-smoke.mjs
 */
import { buildDeck } from '../server/lib/deck/build.mjs';

const PURPOSES = ['newlaunch', 'promo', 'knowledge', 'thanks', 'mixed'];

function collect(d) {
  const out = [];
  const push = (v, where) => {
    if (typeof v === 'string' && v) out.push({ where, v });
  };
  for (const s of d.slides) {
    const at = `p${s.index}/${s.type}`;
    [['title', s.title], ['subtitle', s.subtitle], ['kicker', s.kicker], ['quote', s.quote], ['footnote', s.footnote]].forEach(
      ([k, v]) => push(v, `${at}.${k}`)
    );
    (s.bullets || []).forEach((x, i) => push(x, `${at}.bullets[${i}]`));
    (s.cards || []).forEach((c, i) => { push(c.title, `${at}.cards[${i}].title`); push(c.desc, `${at}.cards[${i}].desc`); });
    (s.steps || []).forEach((c, i) => { push(c.title, `${at}.steps[${i}].title`); push(c.desc, `${at}.steps[${i}].desc`); });
    (s.faq || []).forEach((c, i) => { push(c.q, `${at}.faq[${i}].q`); push(c.a, `${at}.faq[${i}].a`); });
    ((s.table && s.table.rows) || []).forEach((r, i) => r.forEach((v, j) => push(v, `${at}.table[${i}][${j}]`)));
    if (s.left) { push(s.left.title, at + '.left.title'); (s.left.items || []).forEach((x, i) => push(x, `${at}.left[${i}]`)); }
    if (s.right) { push(s.right.title, at + '.right.title'); (s.right.items || []).forEach((x, i) => push(x, `${at}.right[${i}]`)); }
    (s.script || []).forEach((l, i) => push(l.text, `${at}.script[${i}]`));
  }
  return out;
}

console.log('\n=== 文案体检（半角引号 / 版式覆盖） ===');
let total = 0;
const bad = [];
const types = new Set();
/** 用户明确要求「在所有场次的 PPT 里都不要出现」的内容。删过一次，加个防线防止回流。 */
const FORBIDDEN = ['生茶是怎么做出来的', '熟茶是怎么做出来的', '工艺：从鲜叶到茶饼'];
const forbiddenHits = [];

for (const purpose of PURPOSES) {
  const d = buildDeck({
    topic: '文案体检',
    host: '阿茶',
    brand: '山外山茶事',
    durationMin: 60,
    purpose,
    audience: 'veteran',
    products: [
      { name: '老班章古树春茶', mountainName: '老班章', type: '生普', spec: '357g/饼', price: 2680, comparePrice: 3280 },
      { name: '冰岛老寨春茶', mountainName: '冰岛', type: '生普', spec: '200g/饼', price: 1980 },
    ],
  });
  d.slides.forEach((s) => types.add(s.type));
  const texts = collect(d);
  total += texts.length;
  const hits = texts.filter((t) => /["']/.test(t.v));
  bad.push(...hits.map((h) => ({ purpose, ...h })));
  // 用户明确说过「这个模块在所有场次的 PPT 里都不要」，删过一次，加防线防回流
  const all = JSON.stringify(d.slides);
  for (const f of FORBIDDEN) {
    if (all.includes(f)) forbiddenHits.push(`${purpose}: ${f}`);
  }
  console.log(`  ${purpose.padEnd(10)} ${String(d.slides.length).padStart(2)} 页  ${String(texts.length).padStart(3)} 条文案  半角引号 ${hits.length}`);
}

const uniq = [...new Map(bad.map((b) => [b.v, b])).values()];
console.log(`\n共 ${total} 条文案，命中半角引号 ${bad.length} 条`);
for (const b of uniq.slice(0, 8)) console.log(`  · [${b.where}] ${b.v.slice(0, 60)}`);
if (uniq.length > 8) console.log(`  … 另有 ${uniq.length - 8} 条不重复文案`);

console.log(`\n引擎能产出的版式：${[...types].sort().join(', ')}（${types.size} 种）`);

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${!cond && extra ? ' → ' + extra : ''}`);
};
ok(bad.length === 0, '  中文文案无半角引号（统一用「」）');
ok(
  forbiddenHits.length === 0,
  '  已删除的模块没有回流（生茶/熟茶是怎么做出来的）',
  forbiddenHits.slice(0, 4).join(' | ')
);
ok(types.size >= 13, `  引擎能产出全部 13 种版式（实际 ${types.size}）`, [...types].join(','));

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
