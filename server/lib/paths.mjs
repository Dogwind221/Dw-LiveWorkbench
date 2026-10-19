/**
 * 路径解析 —— **多租户改造的唯一收口点**。
 *
 * ## 改版说明（2026-10-18）
 *
 * 改造前这里导出的是一堆常量（`DATA_DIR` / `DECKS_DIR` / `PPTX_OUT`…），
 * 因为整个项目只有"一份数据"。
 *
 * 多租户之后，同一个路径在不同租户下指向不同位置，所以**必须变成函数**：
 *
 * ```js
 * // ❌ 模块顶层求值 → 只会在 import 时算一次，之后永远是那个租户的目录
 * const FAQ_FILE = path.join(DATA_DIR, 'faq.json');
 *
 * // ✅ 每次调用时求值 → 跟着当前请求的租户走
 * const faqFile = () => path.join(dataDir(), 'faq.json');
 * ```
 *
 * 这个区别是多租户最隐蔽的 bug 来源：顶层常量不会报错，只会**静默串租户**。
 *
 * ## 目录布局（统一，不留特例）
 *
 * ```
 * data/
 * ├── tenants.json              ← 平台：租户注册表
 * ├── eval/                     ← 平台：评测资产（不属于任何租户）
 * └── tenants/
 *     ├── default/              ← 迁移后的原数据
 *     │   ├── knowledge.json / compliance.json / faq.json / …
 *     │   ├── decks/ seed/ backups/
 *     │   └── agent-audit.jsonl
 *     └── tenant_a/ …
 *
 * output/
 * └── tenants/
 *     ├── default/{pptx,scripts,html,agent}/
 *     └── tenant_a/…
 * ```
 *
 * 为什么不留"default 走旧路径"的特例：路径解析只要有第二个分支，就是未来越权 bug 的温床。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_TENANT, currentTenantId } from './tenant.mjs';

/* ------------------------------------------------------------------ *
 * 平台级（不随租户变化）
 * ------------------------------------------------------------------ */
export const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = path.dirname(SERVER_DIR);
export const WEB_DIR = path.join(ROOT, 'web');
export const PIPELINE_DIR = path.join(ROOT, 'pipelines');
/** 数据根目录。真正的租户数据在 `DATA_ROOT/tenants/<id>/` 下。 */
export const DATA_ROOT = path.join(ROOT, 'data');
/** 输出根目录。租户产物在 `OUTPUT_ROOT/tenants/<id>/` 下。 */
export const OUTPUT_ROOT = path.join(ROOT, 'output');
/** 评测资产（golden set / 场景集）。属于开发期数据，**不按租户隔离**。 */
export const EVAL_DIR = path.join(DATA_ROOT, 'eval');

/**
 * 租户注册表与 token 表都是**平台级**的（不属于任何租户）：
 * - 注册表要回答"系统里有哪些租户"
 * - token 表要回答"这个 token 属于哪个租户"—— 它在租户上下文建立**之前**就要被读
 * 放租户目录里会变成"要先知道租户才能查 token，要先有 token 才能知道租户"的死锁。
 */
export const tenantsFile = () => path.join(DATA_ROOT, 'tenants.json');
export const tokensFile = () => path.join(DATA_ROOT, 'tokens.json');
/** 用户表也是平台级：登录时还不知道是哪个租户，要先查到用户才能拿到 tenantId。 */
export const usersFile = () => path.join(DATA_ROOT, 'users.json');

/* ------------------------------------------------------------------ *
 * 租户级（每次调用时按当前上下文解析）
 * ------------------------------------------------------------------ */

/**
 * 当前生效的租户 id。
 *
 * 无上下文（CLI / 测试 / 启动期）时回落到 `default` —— 这是"零破坏迁移"的关键：
 * 迁移后旧数据归 default，所以不设上下文的脚本和测试行为完全不变。
 */
export function tenantId() {
  return currentTenantId() || DEFAULT_TENANT;
}

/** 当前租户的数据目录。 */
export function dataDir() {
  return path.join(DATA_ROOT, 'tenants', tenantId());
}

/** 当前租户的输出目录。 */
export function outputDir() {
  return path.join(OUTPUT_ROOT, 'tenants', tenantId());
}

export const decksDir = () => path.join(dataDir(), 'decks');
export const seedDir = () => path.join(dataDir(), 'seed');
export const backupsDir = () => path.join(dataDir(), 'backups');
/** Agent 权限审计日志。按租户分文件，否则 A 的批准记录会出现在 B 的审计里。 */
export const agentAuditFile = () => path.join(dataDir(), 'agent-audit.jsonl');

export const pptxOut = () => path.join(outputDir(), 'pptx');
export const scriptOut = () => path.join(outputDir(), 'scripts');
export const htmlOut = () => path.join(outputDir(), 'html');
export const agentOut = () => path.join(outputDir(), 'agent');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 创建当前租户需要的全部目录。
 *
 * 只在启动期和首次写入时调用。注意它创建的是**调用那一刻的租户**的目录；
 * 新租户第一次访问时由 `writeJson` 里的 `ensureDir` 兜底创建。
 */
export function ensureAllDirs() {
  [
    DATA_ROOT,
    OUTPUT_ROOT,
    EVAL_DIR,
    dataDir(),
    decksDir(),
    seedDir(),
    backupsDir(),
    pptxOut(),
    scriptOut(),
    htmlOut(),
    agentOut(),
  ].forEach(ensureDir);
}

/**
 * 首次运行时把初始数据快照存一份，便于「恢复出厂数据」。
 *
 * 注意 seed 也是**租户级**的：A 的知识库种子和 B 的不一样，
 * 放平台级会让新租户继承到别人的知识点。
 */
export function snapshotSeed(fileName) {
  ensureAllDirs();
  const src = path.join(dataDir(), fileName);
  const dst = path.join(seedDir(), fileName);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.copyFileSync(src, dst);
  }
  return dst;
}
