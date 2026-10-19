import { readFileSync } from 'node:fs';
const file = process.argv[2] || 'F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html';
const s = readFileSync(file, 'utf8');
const lines = s.split('\n');
console.log('=== 带 vw / vh 的行 ===');
lines.forEach((l, i) => { if (/\d(vw|vh)\b/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 200)); });
console.log('=== <section class="slide"> ===');
[...s.matchAll(/<section class="slide[^>]*>/g)].forEach(m => console.log('  ' + m[0]));
console.log('=== 关键规则 ===');
for (const key of ['#deck{position:fixed', '.slide{', 'container-type:size', 'translateX(${-idx*100})', 'deck.style.width']) {
  const i = s.indexOf(key);
  console.log('[' + key + '] ' + (i < 0 ? 'NOT FOUND' : s.slice(i, i + 220).replace(/\n\s*/g, ' ')));
}
console.log('=== 残留占位 ===');
for (const k of ['[必填]', '[选填]', 'Deck Title', 'NN / NN', 'data-layout="P2']) {
  console.log(k + ': ' + (s.split(k).length - 1));
}
