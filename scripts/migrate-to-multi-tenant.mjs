/**
 * 单租户 → 多租户 数据迁移。
 *
 * ## 它做什么
 *
 * 把原来"平铺在 data/ 下"的一份数据，搬进 `data/tenants/default/`：
 *
 * ```
 * data/knowledge.json          → data/tenants/default/knowledge.json
 * data/decks/*                 → data/tenants/default/decks/*
 * data/seed/*                  → data/tenants/default/seed/*
 * data/backups/*               → data/tenants/default/backups/*
 * data/agent-audit.jsonl       → data/tenants/default/agent-audit.jsonl
 * data/eval/*                  → **不动**（评测资产属于平台，不属于任何租户）
 *
 * output/{pptx,scripts,html,agent}/* → output/tenants/default/...
 * ```
 *
 * 同时生成 `data/tenants.json` 租户注册表。
 *
 * ## 安全设计
 *
 * 1. **先备份再动手**：整个 data/ 和 output/ 拷到 `_migrate-backup-<时间戳>/`，
 *    并打印恢复命令。数据迁移不可怕，可怕的是没有退路。
 * 2. **幂等**：源不存在、目标已存在时跳过，不会重复搬或覆盖。
 * 3. **支持 --dry-run**：只看会搬什么，不动文件。**第一次务必先 dry-run。**
 *
 * 用法：
 *   node scripts/migrate-to-multi-tenant.mjs --dry-run
 *   node scripts/migrate-to-multi-tenant.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：项目路径含中文，URL.pathname 会把它百分号编码成 %E7%9B%B4…，
// 直接拿去拼路径会找不到文件。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUTPUT = path.join(ROOT, 'output');
const TENANTS_DIR = path.join(DATA, 'tenants');
const DEFAULT_DIR = path.join(TENANTS_DIR, 'default');
const DEFAULT_OUT = path.join(OUTPUT, 'tenants', 'default');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

/** 要搬的数据文件（平铺在 data/ 根下的 JSON / JSONL）。
 *  注意 `agent-audit.jsonl` 是 JSONL 不是 JSON —— 第一版漏了它，
 *  结果迁移后审计日志留在根目录，产生了"两份审计"（一份旧一份新）。
 *  容易漏的原因：后缀不同，不在 `.json` 的直觉范围内。 */
const DATA_FILES = [
  'knowledge.json',
  'compliance.json',
  'faq.json',
  'sessions.json',
  'intel.json',
  'sources.json',
  'settings.json',
  'agent-audit.jsonl',
];
/** 要搬的数据目录。 */
const DATA_DIRS = ['decks', 'seed', 'backups'];
/** 要搬的输出目录。 */
const OUTPUT_DIRS = ['pptx', 'scripts', 'html', 'agent'];

/** 留在原地、不属于任何租户的平台资产。 */
const PLATFORM_KEEP = ['eval', 'tenants', 'tenants.json'];

const moved = [];
const skipped = [];
const errors = [];

function log(...a) {
  console.log(...a);
}

function movePath(src, dst) {
  const rel = path.relative(ROOT, src);
  const relDst = path.relative(ROOT, dst);
  if (!fs.existsSync(src)) {
    skipped.push(`${rel}（源不存在）`);
    return;
  }
  if (fs.existsSync(dst)) {
    skipped.push(`${rel}（目标已存在，不覆盖）`);
    return;
  }
  moved.push(`${rel} → ${relDst}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

/* ------------------------------------------------------------------ *
 * 0. 预检
 * ------------------------------------------------------------------ */
log('');
log('=== 单租户 → 多租户 数据迁移 ===');
log(`工作目录：${ROOT}`);
log(`模式：${DRY ? 'DRY-RUN（只看不动）' : '实际执行'}`);
log('');

if (!fs.existsSync(DATA)) {
  console.error(`✗ 找不到 data 目录：${DATA}`);
  process.exit(1);
}

// 已经迁移过的话（默认租户目录里已有 knowledge.json），避免重复搬
const alreadyMigrated =
  fs.existsSync(path.join(DEFAULT_DIR, 'knowledge.json')) && !fs.existsSync(path.join(DATA, 'knowledge.json'));

if (alreadyMigrated && !DRY) {
  log('检测到数据看起来已经迁移过（data/tenants/default/knowledge.json 存在，data/knowledge.json 不存在）。');
  log('如果是重新迁移，请先手动把 tenants/default 移开，或确认这是你想要的。');
}

/* ------------------------------------------------------------------ *
 * 1. 备份
 * ------------------------------------------------------------------ */
let backupDir = null;
if (!DRY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  backupDir = path.join(ROOT, `_migrate-backup-${stamp}`);
  log(`① 备份整个 data/ 和 output/ → ${path.basename(backupDir)}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const [name, dir] of [['data', DATA], ['output', OUTPUT]]) {
    const target = path.join(backupDir, name);
    if (fs.existsSync(dir)) fs.cpSync(dir, target, { recursive: true });
  }
  log(`   已完成。出问题用这条命令恢复：`);
  log(`   Remove-Item -Recurse -Force "${DATA}","${OUTPUT}"; Copy-Item -Recurse "${backupDir}\\data" "${DATA}"; Copy-Item -Recurse "${backupDir}\\output" "${OUTPUT}"`);
  log('');
} else {
  log('① 备份：DRY-RUN 跳过');
  log('');
}

/* ------------------------------------------------------------------ *
 * 2. 搬数据
 * ------------------------------------------------------------------ */
log('② 迁移数据文件 → data/tenants/default/');
if (!DRY) fs.mkdirSync(DEFAULT_DIR, { recursive: true });
for (const f of DATA_FILES) movePath(path.join(DATA, f), path.join(DEFAULT_DIR, f));

log('');
log('③ 迁移数据目录 → data/tenants/default/');
for (const d of DATA_DIRS) movePath(path.join(DATA, d), path.join(DEFAULT_DIR, d));

log('');
log('④ 迁移输出目录 → output/tenants/default/');
if (!DRY) fs.mkdirSync(DEFAULT_OUT, { recursive: true });
for (const d of OUTPUT_DIRS) movePath(path.join(OUTPUT, d), path.join(DEFAULT_OUT, d));

/* ------------------------------------------------------------------ *
 * 3. 租户注册表
 * ------------------------------------------------------------------ */
log('');
log('⑤ 生成租户注册表 data/tenants.json');
const registryPath = path.join(DATA, 'tenants.json');
if (fs.existsSync(registryPath)) {
  skipped.push('data/tenants.json（已存在，不覆盖）');
} else {
  const registry = {
    version: 1,
    note: '租户注册表。id 必须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$；default 是迁移后旧数据的归属，不要删。',
    tenants: [
      {
        id: 'default',
        name: '默认租户（迁移保留）',
        status: 'active',
        createdAt: new Date().toISOString(),
        quota: { dailyCalls: 2000, monthlyTokens: 2000000 },
      },
    ],
  };
  moved.push('data/tenants.json（新建）');
  if (!DRY) fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 4. 报告
 * ------------------------------------------------------------------ */
log('');
log('=== 结果 ===');
if (moved.length) {
  log(`迁移 ${moved.length} 项：`);
  for (const m of moved) log(`  ✓ ${m}`);
} else {
  log('没有需要迁移的项。');
}
if (skipped.length) {
  log('');
  log(`跳过 ${skipped.length} 项：`);
  for (const s of skipped) log(`  · ${s}`);
}
if (errors.length) {
  log('');
  log(`错误 ${errors.length} 项：`);
  for (const e of errors) log(`  ✗ ${e}`);
}

// 平台资产检查：确认它们还在原地
log('');
log('=== 平台资产检查（应留在原地）===');
for (const keep of PLATFORM_KEEP) {
  const p = path.join(DATA, keep);
  log(`  ${fs.existsSync(p) || keep === 'tenants' ? '✓' : '·'} data/${keep}`);
}

log('');
if (DRY) {
  log('DRY-RUN 结束，没有改动任何文件。确认无误后去掉 --dry-run 再跑一次。');
} else {
  log('迁移完成。下一步跑验收：');
  log('  node scripts/rag-smoke.mjs');
  log('  node scripts/agent-smoke.mjs');
  log('  node scripts/smoke.mjs');
  log('');
  log(`如果一切正常，确认后可以删除备份目录：_migrate-backup-*`);
}
