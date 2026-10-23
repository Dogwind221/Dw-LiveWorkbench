#!/usr/bin/env node
/**
 * 验证「DSH 的 HMR 到底监听不监听本仓库源码」，并把两类重载分开测：
 *
 *   ① 入口重载：改插件宿主半边（或被它静态 import 的 handler 本身）
 *   ② 依赖重载：改 handler **静态 import 的兄弟模块**（paths.mjs）
 *
 * 每个用例注入独立的求值标记，并等待标记之后的 activated 日志。
 * 日志变长本身不代表成功：恢复文件、其他 profile 或 activate failed 都会写日志。
 * 这只验证两个采样模块的重新求值与后续激活，不保证所有文件或浏览器客户端已刷新。
 *
 * 配置依据：deepseek-ai/deepseek-harness Discussion #10774
 *   - base 只是相对路径锚点，root 才决定监听什么；base bundle 默认 root 是 []
 *   - 所以 profile 里必须同时写 base 与 root
 *
 * 用法：
 *   node scripts/verify-hmr.mjs                 # 两个用例都跑
 *   node scripts/verify-hmr.mjs --wait 20000    # 单次等待上限（毫秒）
 *   node scripts/verify-hmr.mjs --keep          # 保留临时求值探针（排查用）
 *
 * 退出码：0 = 两个用例都通过；2 = 只有入口通过；1 = 其他未通过情况。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG = join(ROOT, 'plugin', 'dsh-live-workbench', '.activation.log');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const waitIdx = argv.indexOf('--wait');
const WAIT_MS = waitIdx >= 0 ? Number(argv[waitIdx + 1]) : 15000;
if (!Number.isFinite(WAIT_MS) || WAIT_MS <= 0) {
  console.error('--wait 必须是大于 0 的毫秒数。');
  process.exit(1);
}

const CASES = [
  { name: '入口 handler（server/lib/handler.mjs）', file: join(ROOT, 'server', 'lib', 'handler.mjs') },
  { name: '依赖 paths.mjs（handler 静态 import 的兄弟）', file: join(ROOT, 'server', 'lib', 'paths.mjs') },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const tail = (n = 3) => {
  if (!existsSync(LOG)) return '(日志不存在)';
  return readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-n).map((l) => '    ' + l).join('\n');
};

console.log('=== DSH HMR 生效性验证 ===');
console.log(`  日志：${LOG}`);
console.log(`  单次等待上限：${WAIT_MS}ms`);
console.log(`\n  改动前末尾：\n${tail(3)}`);

const results = [];
let activeRestore = () => {};
const onInterrupt = () => {
  try { activeRestore(); } finally { process.exit(130); }
};
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
process.once('exit', () => activeRestore());

for (const c of CASES) {
  if (!existsSync(c.file)) {
    console.log(`\n⚠ 跳过：找不到 ${c.file}`);
    results.push({ ...c, hit: false });
    continue;
  }

  const original = readFileSync(c.file, 'utf8');
  const token = randomUUID().replaceAll('-', '');
  const identifier = `__hmrVerify_${token}`;
  const marker = `hmr-verify-evaluated ${token}`;
  // Top-level code runs only when this particular edited module is evaluated.
  const probe = `\n// hmr-verify ${token}\n`
    + `import { appendFileSync as ${identifier} } from 'node:fs';\n`
    + `${identifier}(${JSON.stringify(LOG)}, new Date().toISOString() + ${JSON.stringify(` ${marker}\n`)});\n`;

  let restored = false;
  const restore = () => {
    if (restored || KEEP) return;
    const current = readFileSync(c.file, 'utf8');
    // Remove our probe without discarding edits made while the verifier was waiting.
    if (current.includes(probe)) writeFileSync(c.file, current.replace(probe, ''), 'utf8');
    restored = true;
  };
  activeRestore = restore;

  try {
    writeFileSync(c.file, original + probe, 'utf8');
    console.log(`\n--- 用例：${c.name} ---`);
    console.log('  ✎ 已写入求值探针，等待本模块求值及后续激活…');

    const deadline = Date.now() + WAIT_MS;
    let hit = false;
    while (Date.now() < deadline) {
      await sleep(Math.min(100, WAIT_MS));
      const log = readLog();
      const evaluatedAt = log.indexOf(` ${marker}\n`);
      if (evaluatedAt >= 0 && /^\S+ activated basePath=/m.test(log.slice(evaluatedAt + marker.length + 2))) {
        hit = true;
        break;
      }
    }
    console.log(`  ${hit ? '✓ 本模块已重新求值，随后观察到激活' : '✗ 未确认本模块求值及后续激活'}`);
    console.log(`  末尾：\n${tail(3)}`);
    results.push({ ...c, hit });
  } catch (error) {
    console.log(`  ✗ 用例出错：${error.message}`);
    results.push({ ...c, hit: false });
  } finally {
    restore();
    activeRestore = () => {};
  }
}

console.log('\n=== 结论 ===');
for (const r of results) console.log(`  ${r.hit ? '✓' : '✗'} ${r.name}`);
const entry = results[0]?.hit;
const dep = results[1]?.hit;

if (entry && dep) {
  console.log('\n✓ 两个采样模块均已重新求值，随后观察到路由激活。');
  console.log('  此结果不覆盖其他源码文件、所有 profile 或浏览器客户端刷新。');
  process.exit(0);
}
if (entry && !dep) {
  console.log('\n⚠ 只有入口用例通过，依赖用例未通过。');
  console.log('  检查 profile 里的 hmr 配置是否同时写了 base 和 root（root 不能省）。');
  process.exit(2);
}
console.log('\n✗ 验证未全部通过。排查顺序：');
console.log("  1) profile 补丁里 hmr 条目是否有 base（结尾斜杠）+ root: ['.']");
console.log('  2) 改完 profile 补丁后是否让 DSH 重新加载过配置');
console.log('  3) 插件是否已是静态 import（动态 import + ?v= 会让 HMR 失去依赖路径）');
process.exit(1);
