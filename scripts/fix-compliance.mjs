import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../server/lib/paths.mjs';

// 多租户后合规词库在 data/tenants/<id>/ 下；脚本不带上下文 → default 租户
const p = path.join(dataDir(), 'compliance.json');
const c = JSON.parse(fs.readFileSync(p, 'utf8'));

// 修正被 shell 转义破坏的电话正则
const phone = c.patterns.find((x) => x.id === 'phone-number');
phone.regex = '1[3-9]\\d{9}|\\d{3,4}-\\d{7,8}';

c.allowPatterns = [
  '第[一二三四五六七八九十两0-9]+(?:泡|口|遍|次|步|年|道|杯|层|轮|批|冲|水|阶段|时间|印象|款|饼|是|点|个|条|件|种|方面|部分)',
  '(?:树龄|年份|海拔|克重|规格|净含量|库存|限量)[^。！？]{0,20}',
  '第一印象|第一时间',
];

fs.writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');

// ---- 校验 ----
const c2 = JSON.parse(fs.readFileSync(p, 'utf8'));
const checks = [];
for (const pat of c2.patterns) {
  try {
    const re = new RegExp(pat.regex, 'g');
    checks.push({ id: pat.id, ok: true, regex: pat.regex });
    void re;
  } catch (e) {
    checks.push({ id: pat.id, ok: false, error: e.message });
  }
}
const bad = checks.filter((x) => !x.ok);
console.log('正则编译失败数:', bad.length, bad.length ? JSON.stringify(bad) : '');

// 用真实业务文本验证误报是否消除
const samples = [
  '老班章古树春茶 357g/饼 2680元',
  '泡到第三泡再回来体会一下，第一泡快出汤',
  '树龄影响的是耐泡度和汤感的厚度，不是香气的高低',
  '海拔1700 - 1900 m，树龄约200 - 400 年',
  '这款茶最多能泡十泡，至少也要五泡',
  '我们保证全网最低价，销量第一',
  '喝了能降三高，抗癌防癌',
];
const { checkText } = await import('../server/lib/compliance.mjs');
for (const s of samples) {
  const r = checkText(s, { compliance: c2, whitelist: [] });
  console.log(
    (r.total ? 'HIT ' : 'ok  ') + '| ' + s.slice(0, 26).padEnd(28),
    r.total ? '=> ' + r.hits.map((h) => h.word + '(' + h.level + ')').join(', ') : ''
  );
}
