/**
 * 端到端冒烟测试：验证生成引擎、合规检查、PPTX 导出链路。
 * 用法：node scripts/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDeck } from '../server/lib/deck/build.mjs';
import { checkText, loadCompliance } from '../server/lib/compliance.mjs';
import { loadKB, findMountain } from '../server/lib/kb.mjs';
import { exportPptx, exportScript, pptStatus } from '../server/lib/ppt.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${msg}`);
  if (!cond) failures++;
};

const PRODUCTS = [
  { name: '老班章古树春茶', mountainName: '老班章', type: '生普', year: '2026', spec: '357g/饼', price: 2680, comparePrice: 3280, gift: '茶样2泡', stock: '限量80饼', role: '主推款' },
  { name: '冰岛老寨春茶', mountainName: '冰岛', type: '生普', year: '2026', spec: '200g/饼', price: 1980, role: '对比款' },
  { name: '昔归古树春茶', mountainName: '昔归', type: '生普', year: '2025', spec: '357g/饼', price: 880, role: '引流款' },
  { name: '易武麻黑春茶', mountainName: '麻黑', type: '生普', year: '2024', spec: '357g/饼', price: 560, role: '福利款' },
];

console.log('=== 1. 知识库 ===');
const kb = loadKB();
ok(kb.mountains.length >= 30, `山头条目 ${kb.mountains.length} (>=30)`);
ok(kb.products.length >= 20, `茶品词条 ${kb.products.length} (>=20)`);
ok(!!findMountain(kb, '老班章'), 'findMountain("老班章") 命中');
ok(!!findMountain(kb, '班章老寨'), 'findMountain("班章老寨") 别名命中');
ok(!!findMountain(kb, '冰岛'), 'findMountain("冰岛") 命中');

console.log('\n=== 2. 合规词库 ===');
const cmp = loadCompliance();
const wordCount = cmp.categories.reduce((n, c) => n + c.words.length, 0);
ok(wordCount >= 180, `词条 ${wordCount} (>=180)`);
ok(cmp.patterns.length >= 10, `正则 ${cmp.patterns.length} (>=10)`);
ok(cmp.contextRules.length >= 6, `语境规则 ${cmp.contextRules.length} (>=6)`);

console.log('\n=== 3. 合规检查：行业正常表达不得误报 ===');
const clean = [
  '老班章古树春茶 357g/饼 2680元',
  '泡到第三泡再回来体会一下，第一泡快出汤',
  '第一是海拔和温差，长得慢，物质积累就足',
  '树龄影响的是耐泡度和汤感的厚度，不是香气的高低',
  '海拔1700 - 1900 m，树龄约200 - 400 年',
  '这款茶最多能泡十泡，至少也要五泡',
  '建议下午三四点泡一泡，办公室里也能喝',
];
for (const s of clean) {
  const r = checkText(s, { compliance: cmp, whitelist: [] });
  ok(r.total === 0, `无误报: ${s.slice(0, 22)}${r.total ? ' => ' + r.hits.map((h) => h.word).join(',') : ''}`);
}

console.log('\n=== 4. 合规检查：真实违规必须抓到 ===');
const dirty = [
  ['我们保证全网最低价，销量第一', '绝对化'],
  ['喝了能降三高，还能抗癌防癌', '功效宣称'],
  ['加微信下单，私下转账更便宜', '站外导流'],
  ['买茶保值升值，稳赚翻倍', '投资暗示'],
];
for (const [s, label] of dirty) {
  const r = checkText(s, { compliance: cmp, whitelist: [] });
  ok(r.total > 0, `抓到${label}: ${s.slice(0, 18)} => ${r.hits.map((h) => h.word).join(',')}`);
}

console.log('\n=== 5. 生成引擎：时长与覆盖率 ===');
const decks = [];
for (const [durationMin, n] of [[30, 1], [60, 1], [60, 2], [90, 3], [120, 4]]) {
  const deck = buildDeck({
    topic: '普洱名山专场',
    products: PRODUCTS.slice(0, n),
    purpose: 'newlaunch',
    audience: 'veteran',
    durationMin,
    host: '阿茶',
  });
  decks.push(deck);
  const s = deck.meta.stats;
  console.log(
    `  ${durationMin}min/${n}款 -> 页${s.slideCount} 段${s.sectionCount} 逐字稿${s.scriptMinutes}min(${s.verbatimCoverage}%) 互动${s.interactionMinutes}min 排满率${s.fillRate}% 合规${deck.compliance.level}:${deck.compliance.total}`
  );
  ok(s.slideCount >= 8, `  ${durationMin}min 幻灯片 >= 8`);
  ok(s.fillRate >= 85, `  ${durationMin}min 排满率 >= 85% (实际 ${s.fillRate}%)`);
  ok(deck.compliance.counts.high === 0, `  ${durationMin}min 高风险违规为 0 (实际 ${deck.compliance.counts.high})`);
  ok(deck.script.fullText.length > 2000, `  ${durationMin}min 稿子字数合理`);
}

console.log('\n=== 6. 稿子质量：不得出现同页整句重复 ===');
for (const deck of decks) {
  let dupTotal = 0;
  for (const sec of deck.script.sections) {
    const bySlide = new Map();
    for (const l of sec.lines) {
      if (!bySlide.has(l.slideIndex)) bySlide.set(l.slideIndex, []);
      bySlide.get(l.slideIndex).push(l.text);
    }
    for (const [, texts] of bySlide) {
      const dup = texts.filter((t, i) => texts.indexOf(t) !== i);
      dupTotal += dup.length;
    }
  }
  ok(dupTotal === 0, `  ${deck.meta.durationMin}min 同页重复句 ${dupTotal} 条`);
}

console.log('\n=== 7. 页面质量：不得出现重复页 / 空内容页 ===');
for (const deck of decks) {
  // 与引擎 slideSignature 保持一致：副标题/脚注也算视觉内容
  const keys = deck.slides.map((s) =>
    JSON.stringify([
      s.type, s.title, s.subtitle || '', s.footnote || '',
      s.bullets || [], s.cards || [], s.steps || [], s.faq || [],
      (s.table && s.table.rows) || [], s.price || '', s.anchors || [],
    ])
  );
  let dup = 0;
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) if (keys[i] === keys[j]) dup++;
  // 各版式的内容载体不同：封面靠标题、价格页靠价格与锚点，不能只看列表字段
  const selfContained = new Set(['cover', 'price', 'end', 'cta']);
  const empty = deck.slides.filter((s) => {
    if (selfContained.has(s.type)) return !s.title;
    return (
      !(s.bullets || []).length &&
      !(s.cards || []).length &&
      !(s.steps || []).length &&
      !(s.faq || []).length &&
      !s.table
    );
  }).length;
  ok(dup === 0, `  ${deck.meta.durationMin}min 视觉重复页 ${dup} 对`);
  ok(empty === 0, `  ${deck.meta.durationMin}min 空内容页 ${empty} 张`);

  // 版式覆盖：每种 type 依赖的内容字段必须真的有内容，
  // 否则渲染器会静默退化成空白页（hook 曾经踩过这个坑）
  const PRIMARY = {
    agenda: 'bullets',
    points: 'bullets',
    cards: 'cards',
    hook: 'cards',
    tasting: 'cards',
    table: 'table',
    compare: 'left',
    steps: 'steps',
    faq: 'faq',
    price: 'anchors',
    product: 'bullets',
    cta: 'bullets',
  };
  const broken = deck.slides.filter((s) => {
    const field = PRIMARY[s.type];
    if (!field) return !['cover', 'end'].includes(s.type); // 未知类型 = 会退化
    const v = s[field];
    return !v || (Array.isArray(v) && !v.length);
  });
  ok(broken.length === 0, `  ${deck.meta.durationMin}min 版式内容缺失页 ${broken.length} 张${broken.length ? ' → ' + broken.map((s) => s.type).join(',') : ''}`);
}

console.log('\n=== 8. 阶段完整性（新品首发应包含关键段落）===');
const full = decks[2];
const ids = full.sections.map((s) => s.blockId);
for (const need of ['cover', 'hook', 'tasting', 'product', 'price', 'cta', 'end']) {
  ok(ids.includes(need), `  包含段落 ${need}`);
}
ok(full.sections.filter((s) => s.blockId === 'product').length === 2, '  两款茶各有一段产品介绍');

console.log('\n=== 9. PPTX 导出 ===');
const status = pptStatus();
console.log('  Python:', JSON.stringify(status));
ok(status.ok, `  Python + python-pptx 可用 (${status.pptx || status.error})`);

if (status.ok) {
  const deck = decks[2];
  const res = await exportPptx(deck);
  ok(res.ok, `  PPTX 导出成功${res.ok ? '' : ': ' + res.message}`);
  if (res.ok) {
    const size = fs.statSync(res.pptxPath).size;
    ok(res.slides === deck.slides.length, `  页数与方案一致 (${res.slides}/${deck.slides.length})`);
    ok(size > 20000, `  文件大小合理 (${(size / 1024).toFixed(1)} KB)`);
    console.log('  输出:', res.pptxPath);

    // 校验 pptx 内部结构
    const buf = fs.readFileSync(res.pptxPath);
    ok(buf.slice(0, 2).toString() === 'PK', '  是合法 ZIP/PPTX 容器');
    const xml = buf.toString('latin1');
    ok(xml.includes('ppt/slides/slide'), '  包含幻灯片部件');
    ok(xml.includes('notesSlide'), '  包含演讲者备注部件');

    // 版式越界检查：形状不得跑出画布。
    // 刻意的装饰出血由渲染器用 `deco ` 命名标记，检查器会跳过它们，
    // 所以这里不再需要「第 1 页 / 无文字」这类猜测性豁免。
    const py = status.python;
    const checker = path.join(ROOT_DIR, 'pipelines', 'check_layout.py');
    const chk = spawnSync(py, [checker, res.pptxPath, '--json'], { encoding: 'utf8', timeout: 60000 });
    if (chk.status === 0) {
      const rep = JSON.parse(chk.stdout);
      const real = [];
      for (const s of rep.slides) {
        for (const p of s.problems) real.push(`第${s.page}页 ${p.issue}（${p.shape}）`);
      }
      ok(real.length === 0, `  版式越界 ${real.length} 处${real.length ? ' → ' + real.slice(0, 5).join('; ') : ''}`);
    } else {
      ok(false, '  版式检查脚本执行失败');
    }
  }
  const sres = exportScript(deck);
  ok(sres.ok && fs.existsSync(sres.mdPath), '  口播稿 Markdown 导出成功');
  ok(fs.existsSync(sres.txtPath), '  提词器纯文本导出成功');
}

console.log('\n=== 10. 幂等性：同参数重复生成结果一致 ===');
const a = buildDeck({ topic: 'T', productName: 'X', mountainName: '冰岛', type: '生普', durationMin: 30, host: 'A', seed: 'fixed' });
const b = buildDeck({ topic: 'T', productName: 'X', mountainName: '冰岛', type: '生普', durationMin: 30, host: 'A', seed: 'fixed' });
ok(a.script.fullText === b.script.fullText, '  同 seed 稿子完全一致');
ok(a.slides.length === b.slides.length, '  同 seed 页数一致');

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
