/**
 * 生成一份"可以发出去"的干净副本。
 *
 * ## 为什么需要它
 *
 * 这个目录里混了三类东西：
 *   1. **代码**：可以给别人看
 *   2. **业务数据**：你的价格、话术、账号、审计日志 —— **不能给别人看**
 *   3. **垃圾**：迁移备份（35MB）、导出物（27MB）、临时日志
 *
 * 直接 `git init && git add .` 会把 2 和 3 一起推上去。所以先导出一份干净的，
 * 自己检查一遍，再决定怎么发。
 *
 * ## 用法
 *
 *   node scripts/export-shareable.mjs
 *   node scripts/export-shareable.mjs --out D:\分享
 *
 * 产出：`_share/直播工作台-源码/`（已在 .gitignore 里排除，不会误提交）
 *
 * ## 它会做什么
 *
 * - 只复制**代码 + 文档 + 示例数据**
 * - 示例数据来自 `data/tenants/default/seed/`（通用山头知识，不含你的经营数据）
 * - **不复制** `data/tokens.json` / `data/users.json`（凭据）和 `output/`（导出物）
 * - 在副本里写一份 `怎么跑起来.md`，别人照着就能启动
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, DATA_ROOT } from '../server/lib/paths.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OUT_ROOT = path.resolve(valOf('--out', path.join(ROOT, '_share')));
const OUT = path.join(OUT_ROOT, '直播工作台-源码');

/** 目录：要带走的。 */
const DIRS = [
  'server',     // 后端（含 RAG / Agent / 多租户）
  'web',        // 前端（index.html / app.js / styles.css / login.html）
  'scripts',    // 测试、评测、命令行工具
  'plugin',     // DSH 插件接入（可选，但很小）
  'docs',       // 设计文档 + 研究笔记 + 英文材料
  'pipelines',  // PPTX 导出用的 Python（没有它导出就不可用）
  'ppt-lab',    // 版式实验与体检脚本（测试会引用）
];

/** 文件：要带走的。 */
const FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'README-rag.md',
  'README-agent.md',
  'README-multitenant.md',
  'README-efficiency.md',
  'RAG-INTERFACE.md',
  'AGENT-INTERFACE.md',
  'AGENT-WRITE-INTERFACE.md',
  '多租户改造方案-W10.md',
  '研发日志.md',              // 工程复盘，是加分项
  '启动.bat',
  '启动-局域网.bat',
  '.gitignore',
];

/** 永远不要带走的（防御性检查）。 */
const NEVER = [/^data\/tenants\//, /^data\/tokens\.json$/, /^data\/users\.json$/, /^output\//, /^_migrate-backup-/, /\.log$/];

const copied = [];
const skipped = [];
let bytes = 0;

function shouldNever(rel) {
  const posix = rel.replace(/\\/g, '/');
  return NEVER.some((re) => re.test(posix));
}

function copyFile(src, rel) {
  if (shouldNever(rel)) {
    skipped.push(rel);
    return;
  }
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  bytes += fs.statSync(dst).size;
  copied.push(rel);
}

function copyDir(dirName) {
  const src = path.join(ROOT, dirName);
  if (!fs.existsSync(src)) return;
  const walk = (abs, relBase) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const absChild = path.join(abs, e.name);
      const rel = path.join(relBase, e.name);
      if (e.isDirectory()) {
        // docs/en 是个人材料（英文口语稿与项目简介），不属于项目本身
        if (relBase.replace(/\\/g, '/') === 'docs' && e.name === 'en') continue;
        // 跳过明显的垃圾目录
        if (/node_modules|\.git$|_share|__pycache__/.test(e.name)) continue;
        walk(absChild, rel);
      } else {
        copyFile(absChild, rel);
      }
    }
  };
  walk(src, dirName);
}

/* ------------------------------------------------------------------ *
 * 1. 清空目标
 * ------------------------------------------------------------------ */
if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`已清空旧导出：${OUT}`);
}
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * 2. 复制代码与文档
 * ------------------------------------------------------------------ */
console.log('\n[复制代码]');
for (const d of DIRS) copyDir(d);
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) copyFile(src, f);
}
console.log(`  ${copied.length} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);

/* ------------------------------------------------------------------ *
 * 3. 造一份"示例数据"（不是你的真实数据）
 * ------------------------------------------------------------------ */
console.log('\n[生成示例数据]');

const outData = path.join(OUT, 'data');
const demoDir = path.join(outData, 'tenants', 'default');
fs.mkdirSync(demoDir, { recursive: true });

const seedDir = path.join(DATA_ROOT, 'tenants', 'default', 'seed');
let seededKb = false;
let seededCompliance = false;
for (const [name, field] of [['knowledge.json', 'kb'], ['compliance.json', 'compliance']]) {
  const src = path.join(seedDir, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(demoDir, name));
    if (field === 'kb') seededKb = true;
    else seededCompliance = true;
  }
}

// 其余数据文件给空壳，保证首次运行不会因缺文件报错
const EMPTY = {
  'faq.json': [],
  'sessions.json': [],
  'intel.json': [],
  'sources.json': [
    { id: 'src_demo', name: '示例资讯源（可自行替换）', url: '', enabled: false, type: 'rss' },
  ],
  'settings.json': { host: '示例主播', complianceWhitelist: [] },
};
for (const [name, content] of Object.entries(EMPTY)) {
  const p = path.join(demoDir, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(content, null, 2), 'utf8');
}

// 租户注册表（只放默认租户）
fs.writeFileSync(
  path.join(outData, 'tenants.json'),
  JSON.stringify(
    {
      version: 1,
      tenants: [
        {
          id: 'default',
          name: '默认租户',
          status: 'active',
          createdAt: new Date().toISOString(),
          quota: { dailyCalls: 2000, monthlyTokens: 2000000 },
        },
      ],
    },
    null,
    2
  ),
  'utf8'
);

// 评测集（代码资产，要跟着走）
const evalSrc = path.join(DATA_ROOT, 'eval');
if (fs.existsSync(evalSrc)) {
  fs.mkdirSync(path.join(outData, 'eval'), { recursive: true });
  for (const f of fs.readdirSync(evalSrc)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(evalSrc, f), path.join(outData, 'eval', f));
  }
}

console.log(`  知识库示例：${seededKb ? '✓ 来自 seed' : '✗ 没有 seed/knowledge.json'}`);
console.log(`  合规词库示例：${seededCompliance ? '✓ 来自 seed' : '✗ 没有 seed/compliance.json'}`);
console.log('  账号与 token：✗ 不带（对方首次启动自己建）');
console.log('  导出物 output/：✗ 不带');

/* ------------------------------------------------------------------ *
 * 4. 写一份"怎么跑起来.md"
 * ------------------------------------------------------------------ */
const guide = `# 普洱茶直播工作台 —— 怎么跑起来

> 这是一份**只含代码和示例数据**的副本。你的真实经营数据（价格、话术、账号）
> 没有包含在内，这是故意的。

## 三步启动

1. 装 **Node.js 20 或更高版本**（<https://nodejs.org>），装完重启终端。
2. 在本目录打开终端，运行：

   \`\`\`powershell
   node server/index.mjs
   \`\`\`

   或者直接双击 \`启动.bat\`。

3. 浏览器打开 <http://127.0.0.1:8788>

**不需要登录、不需要联网、不需要 npm install**（本项目零第三方依赖）。

## 想让手机也能看（同一 WiFi）

双击 \`启动-局域网.bat\`，窗口里会打印一个 \`192.168.x.x\` 的地址，
手机浏览器输那个就行。

> ⚠ 局域网模式且未开认证时，同一 WiFi 下任何人都能改数据。给别人演示前建议先建账号。

## 关于 AI 功能（模块 7 / 8）

模块 1–6 是纯本地逻辑，**不配 key 也能用**。

模块 7（知识库问答）和模块 8（AI 助手）需要对话模型 API key：

\`\`\`powershell
$env:LLM_API_KEY = "你的key"
node server/index.mjs
\`\`\`

没配 key 时这两个模块会返回 503 并提示原因，不影响其它模块。

## 关于 PPTX 导出

需要 **Python + python-pptx**。没有的话页面会显示「PPT 引擎不可用」，
其它功能照常，只有 PPTX 导出会失败（HTML 导出不需要 Python）。

## 自检

\`\`\`powershell
node scripts/smoke.mjs          # 六个基础模块
node scripts/rag-smoke.mjs      # 检索与拒答
node scripts/agent-smoke.mjs    # Agent 工具与写操作
node scripts/tenant-smoke.mjs   # 多租户隔离
\`\`\`

全部通过说明环境没问题。

## 文档怎么读

| 想了解 | 看 |
| --- | --- |
| 整体功能与启动 | \`README.md\` |
| RAG 检索怎么做的、为什么这么取舍 | \`README-rag.md\` |
| Agent 与写操作两阶段提交 | \`README-agent.md\` |
| 多租户 / 认证 / 权限 / 配额 | \`README-multitenant.md\` |
| 批量生成与 A/B 对比 | \`README-efficiency.md\` |
| 踩过的坑（20 条复盘） | \`研发日志.md\` |
`;
fs.writeFileSync(path.join(OUT, '怎么跑起来.md'), guide, 'utf8');

/* ------------------------------------------------------------------ *
 * 5. 汇总
 * ------------------------------------------------------------------ */
const totalBytes = (() => {
  let sum = 0;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const abs = path.join(p, e.name);
      if (e.isDirectory()) walk(abs);
      else sum += fs.statSync(abs).size;
    }
  };
  walk(OUT);
  return sum;
})();

console.log(`\n${'─'.repeat(56)}`);
console.log(`导出完成：${OUT}`);
console.log(`  文件数：${copied.length}（不含示例数据与说明）`);
console.log(`  总体积：${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
if (skipped.length) console.log(`  已跳过敏感/垃圾文件：${skipped.length} 个`);
console.log('');
console.log('下一步（你自己决定，脚本不会动你的 git 或远程仓库）：');
console.log(`  1. 先自己检查一遍：  explorer "${OUT}"`);
console.log(`  2. 打包成 zip：      Compress-Archive -Path "${OUT}" -DestinationPath "$env:USERPROFILE\\Desktop\\直播工作台-源码.zip"`);
console.log('  3. 想发 GitHub：在副本目录里 git init → 检查 .gitignore → commit → 再 push');
console.log('');
console.log('⚠ 上传前自己扫一眼有没有不该发的东西（真实价格、客户名字、聊天截图）。');
