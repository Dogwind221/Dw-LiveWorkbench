#!/usr/bin/env node
/**
 * 验证「DSH 的 HMR 到底监听不监听本仓库源码」，并把两类重载分开测：
 *
 *   ① 入口重载：改插件宿主半边（或被它静态 import 的 handler 本身）
 *   ② 依赖重载：改 handler **静态 import 的兄弟模块**（paths.mjs）
 *
 * 两种都要触发 apply() 才算「源码监听真的开了」。只触发第一种 = 只换入口、
 * 依赖还是旧的（这正是早期 `?v=timestamp` workaround 的天花板）。
 *
 * 配置依据：deepseek-ai/deepseek-harness Discussion #10774
 *   - base 只是相对路径锚点，root 才决定监听什么；base bundle 默认 root 是 []
 *   - 所以 profile 里必须同时写 base 与 root
 *
 * 用法：
 *   node scripts/verify-hmr.mjs                 # 两个用例都跑
 *   node scripts/verify-hmr.mjs --wait 20000    # 单次等待上限（毫秒）
 *   node scripts/verify-hmr.mjs --keep          # 保留临时注释（排查用）
 *
 * 退出码：0 = 两类重载都观察到；2 = 只观察到入口重载；1 = 都没观察到。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG = join(ROOT, 'plugin', 'dsh-live-workbench', '.activation.log');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const waitIdx = argv.indexOf('--wait');
const WAIT_MS = waitIdx >= 0 ? Number(argv[waitIdx + 1]) || 15000 : 15000;

const CASES = [
  { name: '入口 handler（server/lib/handler.mjs）', file: join(ROOT, 'server', 'lib', 'handler.mjs') },
  { name: '依赖 paths.mjs（handler 静态 import 的兄弟）', file: join(ROOT, 'server', 'lib', 'paths.mjs') },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lineCount = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').length : 0);
const tail = (n = 3) => {
  if (!existsSync(LOG)) return '(日志不存在)';
  return readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-n).map((l) => '    ' + l).join('\n');
};

console.log('=== DSH HMR 生效性验证 ===');
console.log(`  日志：${LOG}`);
console.log(`  单次等待上限：${WAIT_MS}ms`);
console.log(`  改动前日志行数：${lineCount()}`);
console.log(`\n  改动前末尾：\n${tail(3)}`);

const results = [];

for (const c of CASES) {
  if (!existsSync(c.file)) {
    console.log(`\n⚠ 跳过：找不到 ${c.file}`);
    results.push({ ...c, hit: false });
    continue;
  }

  const original = readFileSync(c.file, 'utf8');
  const marker = `\n// hmr-verify ${new Date().toISOString()}\n`;
  const before = lineCount();

  let restored = false;
  const restore = () => {
    if (restored || KEEP) return;
    writeFileSync(c.file, original, 'utf8');
    restored = true;
  };

  try {
    writeFileSync(c.file, original.replace(/\n?$/, '\n') + marker.trimStart(), 'utf8');
    console.log(`\n--- 用例：${c.name} ---`);
    console.log(`  ✎ 已写入标记注释，等待重载…`);

    const deadline = Date.now() + WAIT_MS;
    let hit = false;
    while (Date.now() < deadline) {
      await sleep(800);
      if (lineCount() > before) {
        hit = true;
        break;
      }
    }
    restore();
    const after = lineCount();
    console.log(`  ${hit ? '✓ 观察到重载' : '✗ 未观察到重载'}（日志 ${before} → ${after} 行）`);
    if (hit) console.log(`  末尾：\n${tail(2)}`);
    results.push({ ...c, hit });
  } catch (error) {
    restore();
    console.log(`  ✗ 用例出错：${error.message}`);
    results.push({ ...c, hit: false });
  }
}

console.log('\n=== 结论 ===');
for (const r of results) console.log(`  ${r.hit ? '✓' : '✗'} ${r.name}`);
const entry = results[0]?.hit;
const dep = results[1]?.hit;

if (entry && dep) {
  console.log('\n✓ 源码监听已生效：入口与依赖都能触发重载。');
  console.log('  以后改 server/ 任何源码都不用重启 DSH，也不用碰 cordis.patch.yml。');
  process.exit(0);
}
if (entry && !dep) {
  console.log('\n⚠ 只有入口重载，依赖模块没有跟着换 —— 这正是早期 ?v=timestamp 的假重载。');
  console.log('  检查 profile 里的 hmr 配置是否同时写了 base 和 root（root 不能省）。');
  process.exit(2);
}
console.log('\n✗ 两类重载都没观察到。排查顺序：');
console.log("  1) profile 补丁里 hmr 条目是否有 base（结尾斜杠）+ root: ['.']");
console.log('  2) 改完 profile 补丁后是否让 DSH 重新加载过配置');
console.log('  3) 插件是否已是静态 import（动态 import + ?v= 会让 HMR 失去依赖路径）');
process.exit(1);
