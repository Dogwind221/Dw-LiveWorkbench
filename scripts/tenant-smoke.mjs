/**
 * 多租户隔离验证（Day 1）。
 *
 * 这一份的重点不是"功能对不对"，是**"租户之间真的看不到彼此"**。
 * 所以每条断言都尽量做两件事：
 *   1. 检查返回值/路径
 *   2. **检查文件系统实际落点**（只看返回值会被实现骗过去）
 *
 * 用法：
 *   node scripts/tenant-smoke.mjs
 *
 * 退出码：0 通过 / 1 有失败
 *
 * 注意：这一层测的是**路径与存储隔离**（模块级）。
 * HTTP 层的身份认证与越权（token、伪造 tenantId、角色权限）属于 Day 2–4，另行测试。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runAsTenant, isValidTenantId, assertTenantId, currentTenantId, DEFAULT_TENANT } from '../server/lib/tenant.mjs';
import { dataDir, decksDir, pptxOut, agentAuditFile, OUTPUT_ROOT, DATA_ROOT } from '../server/lib/paths.mjs';
import { readJson, writeJson, filePath } from '../server/lib/store.mjs';
import { audit, listAudit } from '../server/lib/agent/permissions.mjs';

const TA = 'tenant_a';
const TB = 'tenant_b';
const CDIR = process.cwd();

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const rel = (p) => p.replace(CDIR, '.').replace(/\\/g, '/');
const exists = (p) => fs.existsSync(p);
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });

/** 直接在指定租户上下文里跑一段逻辑。 */
async function asTenant(id, fn) {
  return runAsTenant({ tenantId: id, userId: `user_${id}`, role: 'editor' }, fn);
}

/* ------------------------------------------------------------------ *
 * 0. 清理与准备
 * ------------------------------------------------------------------ */
section('[0/6] 准备测试租户');
for (const id of [TA, TB]) {
  fs.rmSync(path.join(DATA_ROOT, 'tenants', id), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_ROOT, 'tenants', id), { recursive: true, force: true });
}
console.log(`  已清理 ${TA} / ${TB} 的残留目录`);
console.log(`  当前 dataRoot = ${rel(DATA_ROOT)}`);

/* ------------------------------------------------------------------ *
 * 1. 租户 id 校验
 * ------------------------------------------------------------------ */
section('[1/6] 租户 id 白名单校验');

const BAD_IDS = ['../etc', 'a/b', 'a\\b', 'A-B', '', ' ', 'x'.repeat(40), '租户甲', '..', './x'];
let badRejected = 0;
for (const bad of BAD_IDS) {
  if (!isValidTenantId(bad)) badRejected++;
}
check(`全部 ${BAD_IDS.length} 个非法 id 被识别`, badRejected === BAD_IDS.length, `只拒了 ${badRejected} 个`);

// 关键：非法 id 必须**抛错**而不是静默降级到 default（否则就是越权）
let threw = null;
try { assertTenantId('../tenant_b'); } catch (e) { threw = e; }
check('assertTenantId 对路径穿越抛错（不静默降级）', threw?.code === 'BAD_TENANT_ID', threw?.message);

threw = null;
try { runAsTenant({ tenantId: '../escape' }, () => {}); } catch (e) { threw = e; }
check('runAsTenant 拒绝非法租户（连上下文都建不起来）', threw?.code === 'BAD_TENANT_ID');

check('合法 id 能通过', ['default', 'tenant_a', 'a1', 'shop-2'].every(isValidTenantId));

/* ------------------------------------------------------------------ *
 * 2. 路径解析隔离
 * ------------------------------------------------------------------ */
section('[2/6] 路径解析');

check('无上下文时 currentTenantId 为 null（可区分"没上下文"和"default 租户"）', currentTenantId() === null);
check(`无上下文时落到 ${DEFAULT_TENANT} 租户（零破坏语义）`, dataDir().endsWith(path.join('tenants', DEFAULT_TENANT)));

let pathA = null;
let pathB = null;
await asTenant(TA, () => { pathA = dataDir(); });
await asTenant(TB, () => { pathB = dataDir(); });

check('tenant_a 的 dataDir 指向 tenants/tenant_a', pathA.endsWith(path.join('tenants', TA)), rel(pathA));
check('tenant_b 的 dataDir 指向 tenants/tenant_b', pathB.endsWith(path.join('tenants', TB)), rel(pathB));
check('两个租户的目录不同', pathA !== pathB);
check('默认（无上下文）的 dataDir 与 tenant_a 不同', dataDir() !== pathA);
check('pptxOut 也跟着租户走', await asTenant(TA, () => pptxOut()).then((p) => p.includes(TA)));

/* ------------------------------------------------------------------ *
 * 3. 数据隔离（核心）
 * ------------------------------------------------------------------ */
section('[3/6] 数据隔离（★ 核心）');

// 先给 default 写一条基准数据
writeJson('faq.json', [{ id: 'faq_default', q: 'default 租户的问题', a: 'default 的回答' }]);

await asTenant(TA, () => writeJson('faq.json', [{ id: 'faq_a', q: 'A 租户的问题', a: 'A 的回答' }]));
await asTenant(TB, () => writeJson('faq.json', [{ id: 'faq_b', q: 'B 租户的问题', a: 'B 的回答' }]));

/** 在指定租户里读 faq */
const readFaq = (id) => (id ? asTenant(id, () => readJson('faq.json', [])) : readJson('faq.json', []));

const faqDefault = readFaq(null);
const faqA = await readFaq(TA);
const faqB = await readFaq(TB);

check('default 只看到自己的数据', faqDefault.length === 1 && faqDefault[0].id === 'faq_default',
  JSON.stringify(faqDefault.map((x) => x.id)));
check('tenant_a 只看到自己的数据', faqA.length === 1 && faqA[0].id === 'faq_a', JSON.stringify(faqA.map((x) => x.id)));
check('tenant_b 只看到自己的数据', faqB.length === 1 && faqB[0].id === 'faq_b', JSON.stringify(faqB.map((x) => x.id)));
check('A 看不到 B 的数据', !faqA.some((x) => x.id === 'faq_b'));
check('A 看不到 default 的数据', !faqA.some((x) => x.id === 'faq_default'));

// 文件系统层面确认（只看返回值不够，要看文件真的在哪）
const fileA = path.join(DATA_ROOT, 'tenants', TA, 'faq.json');
const fileB = path.join(DATA_ROOT, 'tenants', TB, 'faq.json');
const fileDefault = path.join(DATA_ROOT, 'tenants', DEFAULT_TENANT, 'faq.json');
check('A 的文件真的在 tenants/tenant_a/ 下', exists(fileA), rel(fileA));
check('B 的文件真的在 tenants/tenant_b/ 下', exists(fileB), rel(fileB));
check('default 的文件真的在 tenants/default/ 下', exists(fileDefault), rel(fileDefault));
check('三个 faq.json 内容互不相同', new Set([
  fs.readFileSync(fileA, 'utf8'),
  fs.readFileSync(fileB, 'utf8'),
  fs.readFileSync(fileDefault, 'utf8'),
]).size === 3);

/* ------------------------------------------------------------------ *
 * 4. decks 与 output 隔离
 * ------------------------------------------------------------------ */
section('[4/6] decks / 输出目录隔离');

await asTenant(TA, () => {
  mkdir(decksDir());
  writeJson(path.join(decksDir(), 'deck_a.json'), { id: 'deck_a', title: 'A 的方案' });
});
await asTenant(TB, () => {
  mkdir(decksDir());
  writeJson(path.join(decksDir(), 'deck_b.json'), { id: 'deck_b', title: 'B 的方案' });
});

check('A 的 deck 落在 tenant_a/decks', exists(path.join(DATA_ROOT, 'tenants', TA, 'decks', 'deck_a.json')));
check('B 的 deck 落在 tenant_b/decks', exists(path.join(DATA_ROOT, 'tenants', TB, 'decks', 'deck_b.json')));
check('A 的 decks 目录里没有 B 的 deck',
  !exists(path.join(DATA_ROOT, 'tenants', TA, 'decks', 'deck_b.json')));

await asTenant(TA, () => mkdir(pptxOut()));
check('A 的导出目录在 output/tenants/tenant_a/pptx',
  exists(path.join(OUTPUT_ROOT, 'tenants', TA, 'pptx')));

/* ------------------------------------------------------------------ *
 * 5. 审计日志隔离
 * ------------------------------------------------------------------ */
section('[5/6] 审计日志隔离');

await asTenant(TA, () => audit({ kind: 'confirm', tool: 'save_faq', actionId: 'aaa', args: { q: 'A' } }));
await asTenant(TB, () => audit({ kind: 'deny', tool: 'update_deck', actionId: 'bbb', args: { id: 'B' } }));

const auditA = await asTenant(TA, () => listAudit(100));
const auditB = await asTenant(TB, () => listAudit(100));

check('A 的审计只含 A 的记录', auditA.length > 0 && auditA.every((r) => r.actionId === 'aaa'),
  JSON.stringify(auditA.map((r) => r.actionId)));
check('B 的审计只含 B 的记录', auditB.length > 0 && auditB.every((r) => r.actionId === 'bbb'),
  JSON.stringify(auditB.map((r) => r.actionId)));
check('A 的审计里看不到 B 的 actionId', !auditA.some((r) => r.actionId === 'bbb'));
check('审计文件按租户分文件',
  exists(path.join(DATA_ROOT, 'tenants', TA, 'agent-audit.jsonl')) &&
  exists(path.join(DATA_ROOT, 'tenants', TB, 'agent-audit.jsonl')));

/* ------------------------------------------------------------------ *
 * 6. 并发隔离（最关键的一条）
 * ------------------------------------------------------------------ */
section('[6/6] 并发隔离');

/**
 * AsyncLocalStorage 的价值就在这里：两个租户的异步流程**交错执行**时，
 * 各自的上下文不能串。如果用模块级变量存"当前租户"，这一条必挂。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await Promise.all([
  asTenant(TA, async () => {
    await sleep(20); // 故意让 A 先让出
    writeJson('race-test.json', [{ tenant: 'A' }]);
  }),
  asTenant(TB, async () => {
    writeJson('race-test.json', [{ tenant: 'B' }]); // B 先写
    await sleep(30);
    writeJson('race-test2.json', [{ tenant: 'B' }]);
  }),
]);
await sleep(10);

const raceA = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'tenants', TA, 'race-test.json'), 'utf8'));
const raceB = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'tenants', TB, 'race-test.json'), 'utf8'));
const race2A = exists(path.join(DATA_ROOT, 'tenants', TA, 'race-test2.json'));
const race2B = exists(path.join(DATA_ROOT, 'tenants', TB, 'race-test2.json'));

check('并发：A 的写入没有串到 B', raceA[0].tenant === 'A', JSON.stringify(raceA));
check('并发：B 的写入没有串到 A', raceB[0].tenant === 'B', JSON.stringify(raceB));
check('并发：B 的第二次写入也只在 B 目录', race2B && !race2A, `A=${race2A} B=${race2B}`);

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */
section('清理测试数据');
for (const id of [TA, TB]) {
  fs.rmSync(path.join(DATA_ROOT, 'tenants', id), { recursive: true, force: true });
  fs.rmSync(path.join(OUTPUT_ROOT, 'tenants', id), { recursive: true, force: true });
}
// 恢复 default 的 faq（测试前它可能是 []，这里保持空，避免污染真实数据）
const defaultFaq = path.join(DATA_ROOT, 'tenants', DEFAULT_TENANT, 'faq.json');
fs.writeFileSync(defaultFaq, '[]', 'utf8');
console.log('  已清理 tenant_a / tenant_b，并把 default 的 faq.json 恢复为 []');

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`多租户隔离验证：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
