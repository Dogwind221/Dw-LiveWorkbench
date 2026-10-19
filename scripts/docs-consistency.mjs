/**
 * 文档 ↔ 代码 一致性检查。
 *
 * ## 为什么需要它
 *
 * 第 12 周收尾时发现：`README-rag.md` 里写的融合权重是 `0.7 / 0.3`，
 * 而 `retrieve.mjs` 里已经调成 `0.9 / 0.1`；拒答阈值文档写 `6 / 0.12`，代码是 `7 / 0.163`。
 * 文档是三个月前写的，代码后来改过，**没有任何东西会报错**。
 *
 * 这种漂移是致命的：有人问"你们权重多少"，照文档答 0.7，
 * 翻代码却看到 0.9 —— 比答不出来更糟。
 *
 * 所以把"代码里的常量"和"文档里的说法"做一次机械比对。
 * 它不能检查所有表述（自然语言没法全自动核），但能挡住最容易出错的那一类：
 * **把可调参数写成硬编码数字**。
 *
 * 用法：
 *   node scripts/docs-consistency.mjs
 *   退出码 0 = 一致；1 = 有冲突（可直接进 CI）
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../server/lib/paths.mjs';

let pass = 0;
let fail = 0;
const problems = [];

const ok = (msg) => { pass++; console.log(`  ✓ ${msg}`); };
const bad = (msg, detail = '') => {
  fail++;
  problems.push(`${msg}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
};

/** 从源码里抠一个数字常量（先找字面量，再找 env 兜底）。 */
function numFromFile(relPath, patterns) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  const src = fs.readFileSync(full, 'utf8');
  for (const re of patterns) {
    const m = re.exec(src);
    if (m) return Number(m[1]);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 1. 读出代码里的"真值"
 * ------------------------------------------------------------------ */
console.log('=== 文档 ↔ 代码 一致性检查 ===\n');
console.log('[代码真值]');

const RETRIEVE = 'server/lib/rag/retrieve.mjs';
const ANSWER = 'server/lib/rag/answer.mjs';
const LOOP = 'server/lib/agent/loop.mjs';
const EMBED = 'server/lib/rag/embed.mjs';

const CODE = {
  rrfK: numFromFile(RETRIEVE, [/rrfK:\s*([\d.]+)/, /rrfK\s*=\s*Number\([^)]*\)\s*\|\|\s*([\d.]+)/]),
  wBM25: numFromFile(RETRIEVE, [/wBM25:\s*([\d.]+)/]),
  wVector: numFromFile(RETRIEVE, [/wVector:\s*([\d.]+)/]),
  entityBoost: numFromFile(RETRIEVE, [/entityBoost:\s*([\d.]+)/]),
  entityTopN: numFromFile(RETRIEVE, [/ENTITY_TOP_N\s*=\s*([\d.]+)/]),
  titleBoost: numFromFile(RETRIEVE, [/TITLE_BOOST\s*=\s*([\d.]+)/]),
  minBm25: numFromFile(ANSWER, [/MIN_BM25\s*=\s*Number\([^()]*?([\d.]+)\s*\)/, /MIN_BM25\s*=\s*([\d.]+)/]),
  minVector: numFromFile(ANSWER, [/MIN_VECTOR\s*=\s*Number\([^()]*?([\d.]+)\s*\)/, /MIN_VECTOR\s*=\s*([\d.]+)/]),
  maxSteps: numFromFile(LOOP, [/MAX_STEPS\s*=\s*([\d.]+)/]),
  maxToolCalls: numFromFile(LOOP, [/MAX_TOOL_CALLS\s*=\s*([\d.]+)/]),
  dim: numFromFile(EMBED, [/DIM\s*=\s*([\d.]+)/]),
};

for (const [k, v] of Object.entries(CODE)) {
  if (v === null) console.log(`  ⚠ ${k}: 没从源码里读到（检查正则或文件路径）`);
  else console.log(`  ${k.padEnd(14)} = ${v}`);
}

const missing = Object.entries(CODE).filter(([, v]) => v === null).map(([k]) => k);
if (missing.length) bad('有代码常量读不出来，检查正则', missing.join(', '));

/* ------------------------------------------------------------------ *
 * 2. 扫描文档
 * ------------------------------------------------------------------ */
const DOCS = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.md'))
  .concat(
    fs.existsSync(path.join(ROOT, 'docs'))
      ? fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)
      : []
  )
  .concat(
    fs.existsSync(path.join(ROOT, 'docs/en'))
      ? fs.readdirSync(path.join(ROOT, 'docs/en')).filter((f) => f.endsWith('.md')).map((f) => `docs/en/${f}`)
      : []
  );

/**
 * 带限定词的句子允许写历史值。
 *
 * 关键点：**要看上下文窗口，不能只看当前行** —— 标定数据经常是表格行
 * （`0.7 / 0.3   MRR 0.634`），限定词写在表格上方的说明里。
 */
const QUALIFIER =
  /早期|标定|旧|后续|勘误|发布值|那一轮|历史|曾|穷举|扫描|扫出|第一版|结论|最优|平衡|实验|sweep|optimum|adopted|historical|caveat|earlier|experiment/i;

function hasQualifierNear(lines, idx, span = 4) {
  const from = Math.max(0, idx - span);
  const to = Math.min(lines.length - 1, idx + span);
  for (let i = from; i <= to; i++) if (QUALIFIER.test(lines[i])) return true;
  return false;
}

/** 一条"疑似在陈述当前配置"的规则。 */
const RULES = [
  {
    name: '融合权重（BM25 / 向量）',
    // 覆盖三种常见写法：`BM25 0.9 / 向量 0.1`、`wBM25=0.9 / wVector=0.1`、`BM25 0.7，向量 0.3`
    re: /(?:w?BM25\s*(?:权重)?\s*[=:：]?\s*)(\d\.\d+)\s*[，,/／、]\s*(?:w?向量|w?vector)\s*(?:权重)?\s*[=:：]?\s*(\d\.\d+)/gi,
    check: (m) => Number(m[1]) === CODE.wBM25 && Number(m[2]) === CODE.wVector,
    expect: () => `BM25 ${CODE.wBM25} / 向量 ${CODE.wVector}`,
  },
  {
    name: '拒答阈值 BM25',
    re: /BM25\s*<\s*([\d.]+)/gi,
    check: (m) => Number(m[1]) === CODE.minBm25,
    expect: () => `BM25 < ${CODE.minBm25}`,
  },
  {
    name: '拒答阈值 向量',
    re: /(?:向量|cosine|vector)\s*[<＜]\s*(0\.\d+)/gi,
    check: (m) => Number(m[1]) === CODE.minVector,
    expect: () => `向量 < ${CODE.minVector}`,
  },
  {
    name: 'RRF 平滑常数 rrfK',
    re: /rrfK\s*[=:：]?\s*(\d+)/gi,
    check: (m) => Number(m[1]) === CODE.rrfK,
    expect: () => `rrfK = ${CODE.rrfK}`,
  },
  {
    name: 'Agent 轮数上限',
    re: /maxSteps\s*[=:：]?\s*(\d+)/gi,
    check: (m) => Number(m[1]) === CODE.maxSteps,
    expect: () => `maxSteps = ${CODE.maxSteps}`,
  },
  {
    name: 'Agent 工具调用上限',
    re: /maxToolCalls\s*[=:：]?\s*(\d+)/gi,
    check: (m) => Number(m[1]) === CODE.maxToolCalls,
    expect: () => `maxToolCalls = ${CODE.maxToolCalls}`,
  },
];

console.log('\n[文档扫描]');
let checkedLines = 0;

for (const rel of DOCS) {
  const full = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        checkedLines++;
        if (rule.check(m)) continue;
        // 带限定词的句子视为"在讲历史"，允许
        if (hasQualifierNear(lines, i)) continue;
        bad(`${rel}:${i + 1} ${rule.name} 与代码不一致`, `文档：「${line.trim().slice(0, 90)}」  期望：${rule.expect()}`);
      }
    }
  }
}

console.log(`\n  共比对 ${checkedLines} 处参数表述`);

/* ------------------------------------------------------------------ *
 * 3. 类别二：已废弃的字面量（防止旧数字被反复引用）
 * ------------------------------------------------------------------ */
console.log('\n[废弃字面量]');
const DEPRECATED = [
  {
    name: '旧的融合权重 0.7 / 0.3（41 题集那轮，已被 0.9 / 0.1 取代）',
    re: /0\.7\s*[，,/／]\s*(?:向量\s*)?0\.3/,
  },
  {
    name: '旧的实体覆盖率 0.659 → 0.927（口径已变）',
    re: /0\.659|0\.927/,
  },
];
for (const d of DEPRECATED) {
  let hits = 0;
  for (const rel of DOCS) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!d.re.test(lines[i])) continue;
      if (hasQualifierNear(lines, i)) continue; // 明确标注为历史的，放过
      hits++;
      bad(`${rel}:${i + 1} ${d.name}`, `未加"历史/勘误"标注：「${lines[i].trim().slice(0, 90)}」`);
    }
  }
  if (!hits) ok(`没有未标注的${d.name}`);
}

/* ------------------------------------------------------------------ *
 * 4. 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`文档一致性：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const p of problems) console.log(`  · ${p}`);
  console.log('\n修法：把文档里的数字改成代码里的值；如果那句话是在讲历史，');
  console.log('      就加上"早期/标定轮/后续勘误"这类限定词。');
}
process.exitCode = fail ? 1 : 0;
