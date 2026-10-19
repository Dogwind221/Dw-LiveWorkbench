/**
 * 段落返回多张幻灯片时，**每一张都要出现**。
 *
 * 为什么单独测这一条：buildDeck 里原来写的是 `expandSlides(produced[0], desired)` ——
 * 只取第一张，块里 return 的第二、三张被静默丢掉：不报错、没有日志、
 * 生成的页数看起来也「正常」。实测表现是「知识库字段都填了，气候生态页就是不出来」，
 * 查了很久才定位到调用处。这类静默截断必须用测试钉住。
 *
 * 做法：临时把知识库换成带溯源/气候/工艺数据的版本，生成，断言页面齐、再还原。
 * 用 try/finally 保证任何情况下都还原，不留脏数据。
 *
 * 用法：node scripts/deck-multislide-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataDir } from '../server/lib/paths.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 多租户后知识库在 data/tenants/<id>/ 下；脚本不带上下文 → default 租户
const KB_PATH = path.join(dataDir(), 'knowledge.json');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${!cond && extra ? ' → ' + extra : ''}`);
};

console.log('\n=== 段落多页输出验收 ===\n');

const original = fs.readFileSync(KB_PATH, 'utf8');
let added = [];
try {
  const kb = JSON.parse(original.replace(/^\uFEFF/, ''));
  const m = kb.mountains.find((x) => x.name === '老班章');
  if (!m) throw new Error('测试数据里没有「老班章」');
  // 临时把新字段填上（只存在内存 → 写盘 → 生成 → 还原）
  Object.assign(m, {
    village: '老班章村',
    coordinates: '21.7N 100.4E',
    treeAgeStructure: '古树约40% / 大树35% / 小树25%',
    pickStandard: '头采为主',
    factory: '老班章村初制所',
    batchNo: '2026-LBZ-01',
    labReport: ['农残未检出（2026-04）', '重金属合格'],
    partnerYears: '第5年',
    climate: '亚热带季风，昼夜温差大',
    sunlight: '年均日照约2000小时',
    rainfall: '年降水约1300mm',
    ecology: '村寨周边生态林保留较好',
    companionPlants: ['樟树', '水冬瓜'],
    craftEffect: [
      '杀青偏轻: 苦涩保留更多，前段冲击力强',
      '揉捻偏重: 出味快，中段饱满但耐泡度略降',
      '晒青足: 香气高扬，杯底留香久',
    ],
    whyThisPlot: '第一次喝到是2021年，那口回甘让我记了很久。\n和岩大哥合作到第5年，他家的地块我每年都去看。',
  });
  fs.writeFileSync(KB_PATH, JSON.stringify(kb, null, 2), 'utf8');

  const { buildDeck } = await import('../server/lib/deck/build.mjs');
  const d = buildDeck({
    topic: '多页段落测试',
    host: '主播',
    brand: '本店',
    durationMin: 60,
    purpose: 'knowledge',
    audience: 'veteran',
    products: [{ name: '老班章古树春茶', mountainName: '老班章', type: '生普', spec: '357g/饼', price: 2680 }],
  });

  const kickers = d.slides.map((s) => s.kicker || '');
  const need = [
    ['信任与溯源', '§1 溯源档案（区块返回的第 1 张）'],
    ['选料逻辑', '§1 选料逻辑（区块返回的第 2 张 —— 就是以前会被丢掉的那张）'],
    ['气候与生态', '§2 气候与生态（山头档案区块返回的第 2 张）'],
    ['工艺与滋味', '§2 工艺与滋味'],
  ];
  for (const [k, label] of need) {
    ok(kickers.includes(k), `  ${label}`, `实际页面「${kickers.filter(Boolean).join(', ')}」`);
  }

  // 反向：知识库空着时，这些页一张都不该出现（不能编内容凑页数）
  // ⚠️ 必须先还原文件再生成 —— 否则第二次 buildDeck 读到的还是刚才那份临时数据，
  // 结果「空数据」也满天飞页，测试自己说谎（这一步踩过一次）。
  // ⚠️ 必须自己构造「空」—— 不能假设基线知识库里本来就没这些字段：
  // 真实知识库一旦填过溯源/历史数据，这个负向对照就变成假失败（踩过一次）。
  const blank = JSON.parse(original.replace(/^\uFEFF/, ''));
  const mb = blank.mountains.find((x) => x.name === '老班章');
  for (const k of ['village', 'coordinates', 'treeAgeStructure', 'pickStandard', 'factory',
                   'batchNo', 'labReport', 'partnerYears', 'whyThisPlot', 'history',
                   'climate', 'sunlight', 'rainfall', 'ecology', 'companionPlants', 'craftEffect']) {
    delete mb[k];
  }
  fs.writeFileSync(KB_PATH, JSON.stringify(blank, null, 2), 'utf8');
  const d2 = buildDeck({
    topic: '空数据测试',
    host: '主播',
    brand: '本店',
    durationMin: 60,
    purpose: 'knowledge',
    audience: 'veteran',
    products: [{ name: '老班章古树春茶', mountainName: '老班章', type: '生普', spec: '357g/饼', price: 2680 }],
  });
  const k2 = d2.slides.map((s) => s.kicker || '');
  ok(!k2.includes('信任与溯源') && !k2.includes('气候与生态') && !k2.includes('工艺与滋味') &&
     !k2.includes('选料逻辑') && !k2.includes('历史沿革'),
    '  没填数据的页一张都不出（不编内容凑页数）', k2.filter(Boolean).join(', '));
  ok(!/器皿\s*\/\s*水温|（[^）]*投茶比/.test(JSON.stringify(d2.slides)), '  占位提示不会被当成正文渲染');
} catch (e) {
  ok(false, '  执行过程', e.message);
} finally {
  fs.writeFileSync(KB_PATH, original, 'utf8');
}

// 静态防线：调用处不能再退回只取第一张。
// 先剥掉注释 —— 否则会匹配到解释这个 bug 的那行注释本身（测试自己误报，踩过一次）。
const src = fs
  .readFileSync(path.join(ROOT, 'server', 'lib', 'deck', 'build.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
ok(!/expandSlides\(\s*produced\s*\[/.test(src), '  调用处没有退回「只展开第一张」的写法');

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
