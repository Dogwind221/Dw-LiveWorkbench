/**
 * 知识库文件格式的验收：往返一致性 + 易错写法。
 *
 * 为什么必须有：这套格式是给人手写的，所以「写得随意一点会不会坏」是核心风险。
 * 实测踩过两个真 bug，都是靠这里兜住的：
 *   1. 把中文逗号「，」当列表分隔符 → 一条卖点被切成好几条（内容碎掉）
 *   2. 对整行做冒号规范化 → 正文里的「虚报树龄：」被改成「虚报树龄:」（内容被改）
 * 还有一类更隐蔽的：导出→导入后 id 变了，导致每次比对都「全删全增」。
 *
 * 用法：node scripts/kb-smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderKbFile, parseKbFile, idFromName } from '../server/lib/kb-format.mjs';
import { kbFileStatus, previewKbImport } from '../server/lib/kb-file.mjs';
import { readJson } from '../server/lib/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${!cond && extra ? ' → ' + extra : ''}`);
};

console.log('\n=== 知识库文件格式验收 ===\n');

/* ---------- 1. 往返一致性：导出 → 解析 → 逐字段比 ---------- */
const kb = readJson('knowledge.json', null);
if (!kb) {
  console.log('  读不到 data/knowledge.json');
  process.exit(1);
}

const norm = (o) => {
  const out = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const a = v.map((x) => String(x).trim()).filter(Boolean);
      if (a.length) out[k] = a;
      continue;
    }
    const s = String(v).trim();
    if (s !== '') out[k] = s;
  }
  return out;
};

let roundTripBad = [];
for (const [type, list, sub] of [
  ['mountain', kb.mountains || [], '山头'],
  ['product', kb.products || [], '茶品'],
]) {
  for (const item of list) {
    const text = renderKbFile(type, item);
    const back = parseKbFile(type, text, item.name).data;
    // id 由「按名字复用」保证，这里模拟同一套规则
    back.id = item.id || idFromName(back.name);
    if (JSON.stringify(norm(item)) !== JSON.stringify(norm(back))) {
      const a = norm(item);
      const b = norm(back);
      const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
        (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])
      );
      roundTripBad.push(`${sub}/${item.name}: ${diff.join(',')}`);
    }
  }
}
ok(
  roundTripBad.length === 0,
  `  往返一致：${(kb.mountains || []).length + (kb.products || []).length} 个对象逐字段无变化`,
  roundTripBad.slice(0, 4).join(' | ')
);

/* ---------- 2. 容易写坏的地方 ---------- */
const tricky = `# 测试山头

产区：西双版纳
海拔 1700-1900m
别名: 甲 / 乙 / 丙

// 这是注释，应该被忽略
常见坑:
- 市面低价"班章"多为布朗山其他寨子拼配，不是老班章原料
- 用"班章味"当卖点时，要问清是纯料、拼配还是仅"布朗山系"
卖点: 苦底清楚，但三五秒就化开 / 汤是有点"压舌"的厚 / 喝完喉咙发暖
冲泡: 水温95-100℃，投茶5-6g／100ml盖碗
适合人群: 老茶客 / 收藏 / 送礼

---

虚报树龄：动不动说成百年甚至更久。
`;

const parsed = parseKbFile('mountain', tricky, '测试山头').data;
ok(parsed.region === '西双版纳', '  中文冒号能认');
ok(parsed.altitude === '1700-1900m', '  漏写冒号也能认（按字段名开头匹配）');
ok(JSON.stringify(parsed.alias) === JSON.stringify(['甲', '乙', '丙']), '  行内多值按 ` / ` 切开', JSON.stringify(parsed.alias));
ok(parsed.pitfalls?.length === 2, '  `- ` 逐行写法：两条是一条一条的，没被逗号切开', JSON.stringify(parsed.pitfalls));
ok(
  parsed.pitfalls?.[0]?.includes('拼配，不是老班章原料'),
  '  条目里的中文逗号保留（这是之前踩过的 bug）',
  parsed.pitfalls?.[0]
);
ok(
  parsed.sellingPoints?.length === 3,
  '  一条里含中文逗号不会被切开',
  JSON.stringify(parsed.sellingPoints)
);
ok(parsed.brewTips?.includes('5-6g／100ml'), '  全角斜杠/全角标点原样保留', parsed.brewTips);
ok(JSON.stringify(parsed.audience) === JSON.stringify(['老茶客', '收藏', '送礼']), '  适合人群解析成列表');
ok(parsed.terroir?.includes('虚报树龄：'), '  正文里的中文冒号没被改动（这是之前踩过的 bug）', parsed.terroir);
ok(!parsed.confidence && !parsed.note, '  没写的字段不会凭空出现');

/* ---------- 3. 路径与当前素材库状态 ---------- */
const st = kbFileStatus();
ok(st.ok, `  素材库可读：${st.dir}`, st.message);
if (st.ok) {
  ok(st.mountains.items > 0, `  山头解析出 ${st.mountains.items} 条`);
  ok(st.products.items > 0, `  茶品解析出 ${st.products.items} 条`);
  const pre = previewKbImport();
  const n = ['mountains', 'products'].reduce(
    (a, k) => a + pre.groups[k].added.length + pre.groups[k].updated.length + pre.groups[k].removed.length,
    0
  );
  ok(n === 0, '  素材库与当前知识库一致（导出→导入幂等）', `${n} 处差异`);
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
