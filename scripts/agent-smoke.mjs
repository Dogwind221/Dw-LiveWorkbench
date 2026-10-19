/**
 * Agent 冒烟测试 —— 分两层，用**假模型**测循环，不烧 token、不需要网络。
 *
 * 为什么必须用假模型：
 *   Agent 的正确性问题（死循环、轮数超限、工具不存在、工具抛异常）
 *   如果靠真实模型去撞，既不确定又烧钱，而且**撞不出来**（真实模型通常不会犯这些错）。
 *   这些恰恰是最需要在 CI 里每次都验的路径。所以循环层用可编程的 stub 精确驱动。
 *
 * 用法：
 *   node scripts/agent-smoke.mjs            两层全测
 *   node scripts/agent-smoke.mjs --llm      额外跑一次真实模型的工具闭环
 *
 * 退出码：
 *   0  通过
 *   1  断言失败
 *   3  agent 模块还没就绪（正在被并行编辑），**不要改断言去迁就它**
 */
import fs from 'node:fs';

const runLlm = process.argv.includes('--llm');
const TOOLS_PATH = new URL('../server/lib/agent/tools.mjs', import.meta.url);
const LOOP_PATH = '../server/lib/agent/loop.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 可编程的假模型：按脚本依次返回预设的 tool_calls
 * ------------------------------------------------------------------ */

/**
 * @param {Array} script 每一轮的预设响应：
 *   { toolCalls?: [{name, args, id?}], text?: string, argsRaw?: string }
 *   toolCalls 为空表示"模型不再要工具，循环应结束"
 */
function makeStubLlm(script) {
  const calls = [];
  let turn = 0;
  return {
    calls,
    providers: () => [{ id: 'stub', base: 'http://stub', models: ['stub'], configured: true }],
    async chatWithTools({ messages, tools }) {
      calls.push({
        turn: turn + 1,
        messageCount: messages.length,
        roles: messages.map((m) => m.role),
        toolNames: (tools || []).map((t) => t.function.name),
      });
      const preset = script[Math.min(turn, script.length - 1)] || {};
      turn += 1;

      const toolCalls = (preset.toolCalls || []).map((c, i) => ({
        id: c.id || `call_${turn}_${i}`,
        name: c.name,
        args: c.argsRaw !== undefined ? {} : (c.args || {}),
        argsRaw: c.argsRaw !== undefined ? c.argsRaw : JSON.stringify(c.args || {}),
        ...(c.argsError ? { argsError: c.argsError } : {}),
      }));

      const rawMessage = {
        role: 'assistant',
        content: preset.text || '',
        ...(toolCalls.length
          ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argsRaw } })) }
          : {}),
      };

      return {
        text: preset.text || '',
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        rawMessage,
        meta: { provider: 'stub', model: 'stub', attempts: [{ provider: 'stub', model: 'stub', ok: true, ms: 1 }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 前置检查：模块是否就绪
 * ------------------------------------------------------------------ */
section('[0/3] 模块就绪检查');

if (!fs.existsSync(TOOLS_PATH)) {
  console.error('  ✗ server/lib/agent/tools.mjs 还不存在（正在被并行开发）。');
  console.error('    → 等它就绪后重跑。**不要为了让冒烟通过而修改断言。**');
  process.exit(3);
}

let loop;
try {
  loop = await import(LOOP_PATH);
} catch (err) {
  console.error(`  ✗ 无法加载 ${LOOP_PATH}：${err.message}`);
  process.exit(3);
}
check('loop.mjs 可加载并导出 runAgent', typeof loop.runAgent === 'function');

let toolsMod = null;
try {
  toolsMod = await import('../server/lib/agent/tools.mjs');
} catch (err) {
  console.error(`  ✗ 无法加载 tools.mjs：${err.message}`);
  console.error('    → 等它就绪后重跑，不要改断言迁就。');
  process.exit(3);
}
check('tools.mjs 可加载', !!toolsMod);

/* ------------------------------------------------------------------ *
 * 第 1 层：循环层行为（全部用假模型）
 * ------------------------------------------------------------------ */
section('[1/3] 循环层行为（假模型驱动）');

const fakeCtx = { kb: { mountains: [{ id: 'yibang', name: '倚邦' }], products: [], regions: [], tags: [], topics: [] } };

// 1. 单工具：模型调一次工具，然后给答案
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'search_knowledge', args: { query: '倚邦' } }] },
    { text: '倚邦的汤水偏细。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('倚邦怎么样', { llm: stub, ctx: fakeCtx });
  check('单工具：模型调一次工具后给出答案', r.answer === '倚邦的汤水偏细。' && r.steps.length === 2,
    `steps=${r.steps.length} answer=${r.answer.slice(0, 30)}`);
  check('单工具：轨迹记录了工具名与结果', r.steps[0]?.toolCalls?.[0]?.name === 'search_knowledge',
    JSON.stringify(r.steps[0]?.toolCalls));
  check('单工具：工具结果被回传给模型（消息数递增）',
    stub.calls[1].messageCount > stub.calls[0].messageCount,
    `第1轮 ${stub.calls[0].messageCount} → 第2轮 ${stub.calls[1].messageCount}`);
  check('单工具：回传的消息里有 role=tool', stub.calls[1].roles.includes('tool'),
    stub.calls[1].roles.join(','));
  check('单工具：没有误标 stopped', r.stopped === false, `stopReason=${r.stopReason}`);
}

// 2. 并行工具调用：一轮返回 2 个，都要被执行并回传
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [
      { name: 'search_knowledge', args: { query: '老班章' } },
      { name: 'list_mountains', args: {} },
    ] },
    { text: '好了。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('查老班章顺便列个山头', { llm: stub, ctx: fakeCtx });
  check('并行调用：一轮内的 2 个工具都被执行', r.steps[0]?.toolCalls?.length === 2,
    `实际 ${r.steps[0]?.toolCalls?.length}`);
  check('并行调用：2 个结果都回传（user+assistant+2×tool=4 条）',
    stub.calls[1].roles.filter((x) => x === 'tool').length === 2,
    stub.calls[1].roles.join(','));
  check('并行调用：meta 统计了 2 次工具调用', r.meta.toolCalls === 2, `toolCalls=${r.meta.toolCalls}`);
}

// 3. 不该调工具：模型直接回答
{
  const stub = makeStubLlm([{ text: '我是直播工作台助手，能查资料、查合规、出方案。', toolCalls: [] }]);
  const r = await loop.runAgent('你好', { llm: stub, ctx: fakeCtx });
  check('不该调工具时一次就结束', r.steps.length === 1 && r.meta.toolCalls === 0,
    `steps=${r.steps.length} toolCalls=${r.meta.toolCalls}`);
  check('不该调工具时正常给出答案', r.answer.length > 0);
  check('不该调工具时不误标 stopped', r.stopped === false);
}

// 4. 轮数上限：模型永远要工具 → 必须硬刹车
{
  const stub = makeStubLlm([{ text: '再查一下', toolCalls: [{ name: 'list_mountains', args: {} }] }]);
  const r = await loop.runAgent('无限循环测试', { llm: stub, ctx: fakeCtx, maxSteps: 3 });
  check('轮数超限：被硬性刹停', r.stopped === true, `stopped=${r.stopped}`);
  check('轮数超限：stopReason 说清了原因', /轮数|上限/.test(r.stopReason || ''), r.stopReason);
  check('轮数超限：步数被限制在 maxSteps 内', r.steps.length === 3, `steps=${r.steps.length}`);
  check('轮数超限：没有静默截断（stopped 与 stopReason 都在）', !!(r.stopped && r.stopReason));
  // 被截断时模型往往来不及说话，但工具已经真的干过活了 —— 不能让用户看到空答案
  check('轮数超限：仍然给出兜底答复（不能是空串）', r.answer.length > 0, `answer="${r.answer}"`);
  check('轮数超限：兜底答复来自工具真实产出，不是编的',
    /list_mountains|做完了/.test(r.answer), r.answer.slice(0, 120));
}

// 5. 工具调用总数上限
{
  const stub = makeStubLlm([{ text: '', toolCalls: [
    { name: 'list_mountains', args: {} },
    { name: 'list_mountains', args: {} },
  ] }]);
  const r = await loop.runAgent('工具次数上限测试', { llm: stub, ctx: fakeCtx, maxSteps: 5, maxToolCalls: 3 });
  check('工具次数超限：被硬性刹停', r.stopped === true, `stopped=${r.stopped}`);
  check('工具次数超限：实际调用数不超过上限', r.meta.toolCalls <= 3, `toolCalls=${r.meta.toolCalls}`);
  check('工具次数超限：stopReason 说清了原因', /工具|上限/.test(r.stopReason || ''), r.stopReason);
}

// 6. 幻觉工具名：必须喂回错误让模型自己纠正，而不是崩
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'search_weather', args: { city: '上海' } }] },
    { text: '我没有查天气的能力。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('上海天气', { llm: stub, ctx: fakeCtx });
  check('幻觉工具名：不崩，继续循环', r.steps.length === 2, `steps=${r.steps.length}`);
  check('幻觉工具名：该步被标记为失败', r.steps[0]?.toolCalls?.[0]?.ok === false);
  check('幻觉工具名：错误里给出了可用工具清单（帮模型自己纠正）',
    /可用工具/.test(r.steps[0]?.toolCalls?.[0]?.error || ''),
    r.steps[0]?.toolCalls?.[0]?.error);
  check('幻觉工具名：最终仍能给出答案', r.answer === '我没有查天气的能力。');
}

// 7. 参数不是合法 JSON
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'search_knowledge', argsRaw: '{query: 倚邦', argsError: 'Unexpected token q' }] },
    { text: '参数我写错了，重来。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('参数坏掉测试', { llm: stub, ctx: fakeCtx });
  check('参数坏掉：不崩，当作失败喂回模型', r.steps[0]?.toolCalls?.[0]?.ok === false);
  check('参数坏掉：错误信息包含解析原因',
    /JSON|参数/.test(r.steps[0]?.toolCalls?.[0]?.error || ''), r.steps[0]?.toolCalls?.[0]?.error);
}

// 8. 工具执行抛异常：必须被捕获并喂回
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'check_compliance', args: { text: null } }] },
    { text: '检查失败了，我说明一下。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('工具异常测试', { llm: stub, ctx: fakeCtx });
  check('工具异常：被捕获，不向上抛', r.steps.length === 2, `steps=${r.steps.length}`);
  check('工具异常：该步标记失败并带原因', r.steps[0]?.toolCalls?.[0]?.ok === false,
    JSON.stringify(r.steps[0]?.toolCalls?.[0]));
}

// 9. 模型通道挂掉：不能丢已完成的中间结果
{
  const dead = {
    providers: () => [{ id: 'dead', base: 'http://x', models: ['m'], configured: true }],
    async chatWithTools() { throw Object.assign(new Error('HTTP 401: 凭据无效'), { attempts: [] }); },
  };
  const r = await loop.runAgent('通道挂掉测试', { llm: dead, ctx: fakeCtx });
  check('通道挂掉：不抛异常，返回结构化结果', typeof r.answer === 'string');
  check('通道挂掉：stopReason 说明了原因', /模型通道不可用/.test(r.stopReason || ''), r.stopReason);
}

// 10. 空任务要报错
{
  let threw = null;
  try { await loop.runAgent('   ', { llm: makeStubLlm([{ text: 'x' }]), ctx: fakeCtx }); }
  catch (e) { threw = e; }
  check('空任务抛 BAD_TASK', threw?.code === 'BAD_TASK', threw?.message);
}

/* ------------------------------------------------------------------ *
 * 第 2 层：工具层契约（真实工具）
 * ------------------------------------------------------------------ */
section('[2/3] 工具层契约（真实工具，不调模型）');

const defs = toolsMod.listToolDefs();
const READ_TOOLS = ['search_knowledge', 'check_compliance', 'build_live_deck', 'list_mountains', 'get_live_sessions'];
const WRITE_TOOLS = ['save_faq', 'update_deck'];
const EXPECTED = [...READ_TOOLS, ...WRITE_TOOLS];
const names = defs.map((d) => d.function?.name);

check('恰好注册了 7 个工具（5 读 + 2 写）', defs.length === 7, `实际 ${defs.length}: ${names.join(',')}`);
check('工具名与契约一致', EXPECTED.every((n) => names.includes(n)) && names.every((n) => EXPECTED.includes(n)),
  `实际 ${names.join(',')}`);

// 权限标注必须准确 —— 标错一个，写操作就会绕过确认直接执行
const meta = toolsMod.listToolMeta();
for (const n of READ_TOOLS) {
  check(`[${n}] 标为读工具`, meta.find((m) => m.name === n)?.permission === 'read');
}
for (const n of WRITE_TOOLS) {
  check(`[${n}] 标为写工具`, meta.find((m) => m.name === n)?.permission === 'write');
}
// 权限信息不能喂给模型（浪费 token，且毫无意义）
const defBlob = JSON.stringify(defs);
check('喂给模型的 definition 里不含 permission 字段', !defBlob.includes('"permission"'),
  'permission 泄露进模型上下文了');

for (const d of defs) {
  const f = d.function || {};
  const props = f.parameters?.properties || {};
  check(`[${f.name}] definition 结构合法`,
    d.type === 'function' && typeof f.name === 'string' && typeof f.description === 'string' && !!f.parameters,
    JSON.stringify(d).slice(0, 120));
  check(`[${f.name}] description 够详细（≥40 字，它决定模型选不选它）`,
    (f.description || '').length >= 40, `实际 ${(f.description || '').length} 字`);
  // 参数必须有 description，否则模型不知道该传什么
  const missingDesc = Object.entries(props).filter(([, v]) => !v.description);
  check(`[${f.name}] 每个参数都有 description`, missingDesc.length === 0,
    missingDesc.map(([k]) => k).join(','));
  check(`[${f.name}] definition 可 JSON 序列化`, (() => { try { JSON.stringify(d); return true; } catch { return false; } })());
}

// 未知工具名要优雅返回 null
check('getTool(不存在的名字) 返回 null 而不是抛异常', toolsMod.getTool('__nope__') === null);

// 逐个工具跑一次真实 execute，验证形状
const { loadKB } = await import('../server/lib/kb.mjs');
const realCtx = { kb: loadKB() };
const probes = [
  { name: 'search_knowledge', args: { query: '倚邦的山场特征', k: 3 } },
  { name: 'check_compliance', args: { text: '这批茶是全国最低价，能降三高' } },
  { name: 'build_live_deck', args: { topic: '老班章新品首发', durationMin: 60 } },
  { name: 'list_mountains', args: {} },
  { name: 'get_live_sessions', args: {} },
];

for (const p of probes) {
  const tool = toolsMod.getTool(p.name);
  if (!tool) { check(`[${p.name}] 工具存在`, false); continue; }
  try {
    const r = await tool.execute(p.args, realCtx);
    check(`[${p.name}] execute 返回结构合法`,
      typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.summary === 'string',
      JSON.stringify(r).slice(0, 150));
    check(`[${p.name}] 正常入参返回 ok:true`, r.ok === true, r.error || '');
    check(`[${p.name}] summary 非空（模型主要看这个）`, (r.summary || '').length > 0);
    let serializable = true;
    try { JSON.stringify(r.data); } catch { serializable = false; }
    check(`[${p.name}] data 可 JSON 序列化`, serializable);
  } catch (err) {
    check(`[${p.name}] execute 不应抛异常`, false, err.message);
  }
}

// 错误入参必须优雅失败而不是抛异常
const badInputs = [
  { name: 'check_compliance', args: {} },
  { name: 'search_knowledge', args: { query: '' } },
  { name: 'search_knowledge', args: { query: '倚邦', k: 999 } },  // 应 clamp 而不是报错
  { name: 'build_live_deck', args: {} },
  { name: 'list_mountains', args: { keyword: 12345, 野参数: true } }, // 未知参数应忽略
];
for (const b of badInputs) {
  const tool = toolsMod.getTool(b.name);
  let r = null, threw = null;
  try { r = await tool.execute(b.args, realCtx); } catch (e) { threw = e; }
  check(`[${b.name}] 错误入参不抛异常（${JSON.stringify(b.args).slice(0, 40)}）`, !threw, threw?.message);
  check(`[${b.name}] 错误入参返回结构化结果`, r && typeof r.ok === 'boolean');
}

// build_live_deck 不能把整篇稿子塞进 data（会撑爆上下文）
{
  const r = await toolsMod.getTool('build_live_deck').execute({ topic: '老班章新品首发', durationMin: 60 }, realCtx);
  const size = JSON.stringify(r.data || {}).length;
  check('build_live_deck 的 data 体积受控（≤20000 字符，不含整篇逐字稿）', size <= 20000,
    `实际 ${size} 字符`);
  check('build_live_deck 声明了 persist（大件产出交给循环层落盘）', !!r.persist,
    `persist=${JSON.stringify(r.persist)?.slice(0, 80)}`);
}

/* ------------------------------------------------------------------ *
 * 第 3 层：写操作权限与安全（本轮重点）
 *
 * 这一节的每一条都是"写坏了就不可逆"的防线，必须每次 CI 都验。
 * ------------------------------------------------------------------ */
section('[3/4] 写操作权限与安全');

const perm = await import('../server/lib/agent/permissions.mjs');
const wr = await import('../server/lib/agent/tools-write.mjs');
const fsMod = await import('node:fs');
const pathMod = await import('node:path');
const { dataDir } = await import('../server/lib/paths.mjs');

// 多租户后 faq.json 在 data/tenants/<id>/ 下；脚本不带租户上下文 → 落到 default 租户
const FAQ_PATH = pathMod.join(dataDir(), 'faq.json');
const auditBefore = perm.listAudit(500).length;

/**
 * 冒烟测试必须**自己保证起始状态干净**。
 *
 * 否则一次失败的运行会留下测试条目，下一次 `save_faq` 判重就直接失败 ——
 * 变成"一次失败、次次失败"，那种测试没人会信。这里在测试前清掉本文件写过的
 * 所有测试条目（按问题名前缀识别，不会误删真实数据）。
 */
const TEST_FAQ_RE = /^(端到端测试|端到端取消测试|措辞变化测试|禁写测试|谎报测试|批准后新会话测试|直接调用测试)/;
function resetTestFaq() {
  try {
    const list = JSON.parse(fsMod.readFileSync(FAQ_PATH, 'utf8'));
    const cleaned = list.filter((x) => !TEST_FAQ_RE.test(String(x?.q || '')));
    if (cleaned.length !== list.length) {
      fsMod.writeFileSync(FAQ_PATH, JSON.stringify(cleaned, null, 2), 'utf8');
    }
  } catch { /* 文件不存在或损坏都不影响后续 */ }
}
resetTestFaq();

// —— ① actionId 确定性：这是"批准的是那一份内容"的基础 ——
{
  const a = { question: '这茶苦不苦', answer: '苦能化开' };
  const b = { answer: '苦能化开', question: '这茶苦不苦' };
  check('actionId 对 key 顺序不敏感（同一份内容同 id）',
    perm.actionIdOf('save_faq', a) === perm.actionIdOf('save_faq', b));
  check('actionId 对内容变化敏感', perm.actionIdOf('save_faq', a) !== perm.actionIdOf('save_faq', { ...a, answer: 'x' }));
  check('actionId 对工具名敏感', perm.actionIdOf('save_faq', a) !== perm.actionIdOf('update_deck', a));
}

// —— ② decide 的四条分支 ——
{
  const t = toolsMod.getTool('save_faq');
  const args = { question: '测试问题', answer: '测试回答' };
  const id = perm.actionIdOf('save_faq', args);
  check('未批准 → confirm', perm.decide({ tool: t, args, policy: {} }).decision === 'confirm');
  check('已批准 → execute', perm.decide({ tool: t, args, policy: { approvals: [id] } }).decision === 'execute');
  check('allowWrites:false → deny（优先级最高）',
    perm.decide({ tool: t, args, policy: { allowWrites: false, approvals: [id] } }).decision === 'deny');
  // ★ 关键安全性质：批准 A 之后拿 B 必须仍然要确认
  check('批准 A 参数、换 B 参数 → 仍 confirm（防偷换）',
    perm.decide({ tool: t, args: { ...args, answer: '被偷换的回答' }, policy: { approvals: [id] } }).decision === 'confirm');
  check('读工具直接 execute', perm.decide({ tool: toolsMod.getTool('search_knowledge'), args: {}, policy: {} }).decision === 'execute');
}

// —— ③ 写工具校验：非法参数一律拒绝 ——
{
  const saveFaq = toolsMod.getTool('save_faq');
  const cases = [
    { args: {}, why: '缺必填' },
    { args: { question: 'x', answer: 'x' }, why: '太短' },
    { args: { question: 'q'.repeat(201), answer: 'a' }, why: '问题超长' },
    { args: { question: 'q', answer: 'a'.repeat(1001) }, why: '回答超长' },
  ];
  for (const c of cases) {
    const r = await saveFaq.execute(c.args, realCtx);
    check(`save_faq 拒绝非法参数（${c.why}）`, r.ok === false && !!r.error, JSON.stringify(r).slice(0, 120));
  }

  const updateDeck = toolsMod.getTool('update_deck');
  const bad = [
    { args: { deckId: '../../etc/passwd', field: 'title', value: 'x' }, why: '路径穿越' },
    { args: { deckId: 'deck_abc123', field: 'script', value: 'x' }, why: '改结构字段' },
    { args: { deckId: 'deck_abc123', field: 'title', value: '' }, why: '空标题' },
    { args: { deckId: 'deck_abc123', field: 'durationMin', value: '9999' }, why: '时长超范围' },
  ];
  for (const c of bad) {
    const r = await updateDeck.execute(c.args, realCtx);
    check(`update_deck 拒绝（${c.why}）`, r.ok === false && !!r.error, JSON.stringify(r).slice(0, 120));
  }
}

// —— ④ save_faq 含违禁词必须警告（这是这个工具最重要的防护） ——
{
  const r = await toolsMod.getTool('save_faq').execute(
    { question: '这茶能降三高吗', answer: '我们的茶是全国最好的，喝了能降三高' }, realCtx);
  check('save_faq 含违禁词时 ok（允许存，但要警告）', r.ok === true, r.error);
  check('save_faq 的 impact.warnings 非空（上播前必须提醒）',
    Array.isArray(r.impact?.warnings) && r.impact.warnings.length > 0,
    JSON.stringify(r.impact?.warnings));
  check('警告里点名了具体违禁词',
    /降三高|最好/.test(JSON.stringify(r.impact?.warnings)), JSON.stringify(r.impact?.warnings));
}

// —— ⑤ 预览必须含"改前/改后"，否则用户无法判断 ——
{
  const r = await toolsMod.getTool('save_faq').execute({ question: '能存几年', answer: '生普放得住，注意别受潮' }, realCtx);
  check('save_faq impact 含 before/after（用户要知道写多少）',
    !!r.impact?.before && !!r.impact?.after, JSON.stringify(r.impact));
  check('save_faq impact 含 preview（用户要看到确切内容）', !!r.impact?.preview);
}

// —— ⑥ 端到端：未经批准绝不写盘 ——
{
  const before = fsMod.existsSync(FAQ_PATH) ? fsMod.readFileSync(FAQ_PATH, 'utf8') : '[]';
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'save_faq', args: { question: '端到端测试问题', answer: '端到端测试回答' } }] },
    { text: '准备保存这条问答，需要你确认。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('把这条问答存起来', { llm: stub, ctx: fakeCtx });
  const after = fsMod.existsSync(FAQ_PATH) ? fsMod.readFileSync(FAQ_PATH, 'utf8') : '[]';

  check('未批准时 faq.json 内容完全未变（★ 最关键的安全断言）', before === after,
    `前后文件长度 ${before.length} vs ${after.length}`);
  check('未批准时返回 pending（前端靠它渲染确认卡片）', Array.isArray(r.pending) && r.pending.length === 1,
    `pending=${r.pending?.length}`);
  check('pending 里有 actionId 和 impact', !!r.pending?.[0]?.actionId && !!r.pending?.[0]?.impact);
  check('hasWrites 标记为 true', r.hasWrites === true);
  check('writeExecuted 为 false（没执行）', r.writeExecuted === false);

  /**
   * —— ⑦ 确认执行走 `confirmPending`，**不重跑模型** ——
   *
   * 这里曾经有一个严重的真实缺陷：把"确认"实现成"带 actionId 重跑一遍 agent"。
   * 实测模型对同一句话的两次生成不完全一样（问句有没有问号），
   * 算出的 actionId 对不上 → 用户点了确认却什么都没发生。
   * 修复后确认直接执行第一次已校验、且给用户看过的那份参数。
   */
  const actionId = r.pending[0].actionId;
  const applied = perm.confirmPending(actionId, perm.WRITE_APPLIERS);
  check('确认后执行成功（不重跑模型）', applied.ok === true, JSON.stringify(applied).slice(0, 120));
  const list1 = JSON.parse(fsMod.readFileSync(FAQ_PATH, 'utf8'));
  check('确认后 faq.json 里确实多了一条', list1.some((x) => x.q === '端到端测试问题'));

  // 同一个 actionId 再确认一次 → 必须拒绝（动作已被消费），不能重复写
  const again = perm.confirmPending(actionId, perm.WRITE_APPLIERS);
  const list2 = JSON.parse(fsMod.readFileSync(FAQ_PATH, 'utf8'));
  const dupCount = list2.filter((x) => x.q === '端到端测试问题').length;
  check('同一 actionId 重复确认被拒绝（已消费）', again.ok === false, JSON.stringify(again).slice(0, 100));
  check('不会重复写入', dupCount === 1, `实际 ${dupCount} 条`);

  // 不存在的 actionId → 明确拒绝
  const bogus = perm.confirmPending('deadbeefdeadbeef', perm.WRITE_APPLIERS);
  check('不存在的 actionId 确认被拒绝', bogus.ok === false && bogus.code === 'NO_PENDING', JSON.stringify(bogus).slice(0, 100));

  // 取消接口：取消后不能再执行。
  // 必须换一个没用过的问题 —— 同一个问题会被 save_faq 判重，
  // 那样不会产生 pending，测试就测不到取消逻辑了。
  const cancelStub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'save_faq', args: { question: '端到端取消测试', answer: '这条应该被取消' } }] },
    { text: '需要确认', toolCalls: [] },
  ]);
  const r2 = await loop.runAgent('存一条要取消的', { llm: cancelStub, ctx: fakeCtx });
  check('取消用例确实产生了 pending', (r2.pending || []).length === 1, `pending=${r2.pending?.length}`);
  const cancelId = r2.pending[0].actionId;
  check('取消返回 true', perm.clearPending(cancelId) === true);
  const afterCancel = perm.confirmPending(cancelId, perm.WRITE_APPLIERS);
  check('取消后不能再执行', afterCancel.ok === false && afterCancel.code === 'NO_PENDING');
}

/**
 * ⑦-b 回归测试：**模型措辞变化不应影响确认**。
 *
 * 这是上面那条缺陷的正式回归用例：模拟"第一次提议"和"第二次提议"
 * 参数不完全一样（问号有无），确认时**必须仍然执行第一次那份内容**，
 * 因为确认走的是存下来的 applyArgs，根本不再经过模型。
 */
{
  const proposeArgs = { question: '措辞变化测试问句', answer: '第一次提议的回答' };
  const stubA = makeStubLlm([
    { text: '', toolCalls: [{ name: 'save_faq', args: proposeArgs }] },
    { text: '需要确认', toolCalls: [] },
  ]);
  const r = await loop.runAgent('存一条', { llm: stubA, ctx: fakeCtx });
  const actionId = r.pending[0].actionId;

  // 用户点确认 —— 走 confirmPending，模型完全不在场
  const applied = perm.confirmPending(actionId, perm.WRITE_APPLIERS);
  const list = JSON.parse(fsMod.readFileSync(FAQ_PATH, 'utf8'));
  const stored = list.find((x) => x.q === '措辞变化测试问句');
  check('确认执行的是第一次提议的那份原文（模型措辞变化不影响）',
    applied.ok === true && !!stored && stored.a === '第一次提议的回答',
    JSON.stringify(stored));
}

// —— ⑧ allowWrites:false 时一律拒绝，且不写盘 ——
{
  const before = fsMod.readFileSync(FAQ_PATH, 'utf8');
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'save_faq', args: { question: '禁写测试', answer: '不该被写入' } }] },
    { text: '写入被策略禁止了。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('存一条', { llm: stub, ctx: fakeCtx, allowWrites: false });
  const after = fsMod.readFileSync(FAQ_PATH, 'utf8');
  check('allowWrites:false 时文件未变', before === after);
  check('allowWrites:false 时返回 deny（不产生 pending）', (r.pending || []).length === 0);
  check('allowWrites:false 时不标记 hasWrites 执行', r.writeExecuted === false);
}

// —— ⑨ 谎报检查：模型说"已保存"但其实没执行 ——
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'save_faq', args: { question: '谎报测试问题', answer: '谎报测试回答' } }] },
    { text: '已经保存好了，你随时可以调用。', toolCalls: [] },   // ← 谎报
  ]);
  const r = await loop.runAgent('存一条问答', { llm: stub, ctx: fakeCtx });
  check('识别出模型谎称"已保存"（falseWriteClaim）', r.falseWriteClaim === true,
    `falseWriteClaim=${r.falseWriteClaim} answer=${(r.answer || '').slice(0, 50)}`);
}
{
  const stub = makeStubLlm([
    { text: '', toolCalls: [{ name: 'search_knowledge', args: { query: '倚邦' } }] },
    { text: '查到了，倚邦的汤水偏细。', toolCalls: [] },
  ]);
  const r = await loop.runAgent('查倚邦', { llm: stub, ctx: fakeCtx });
  check('正常回答不会被误判为谎报', r.falseWriteClaim === false);
}

// —— ⑩ 审计必须留痕 ——
{
  const logs = perm.listAudit(500);
  check('审计记录了 confirm / deny / execute 三类事件',
    ['confirm', 'deny', 'execute'].every((k) => logs.some((l) => l.kind === k)),
    `实际 kinds: ${[...new Set(logs.map((l) => l.kind))].join(',')}`);
  check('审计留下了参数（事后能还原批准了什么）',
    logs.some((l) => l.kind === 'confirm' && l.args && JSON.stringify(l.args).length > 10));
  check('审计条数增加了', logs.length > auditBefore, `${auditBefore} → ${logs.length}`);
}

// 清理测试写进去的条目，避免污染真实问答库。
// 复用文件开头同一个 TEST_FAQ_RE —— 之前这里另写了一份正则，
// 两次替换后转义坏掉导致漏清理，留下一条"措辞变化测试问句"。
resetTestFaq();

// 注意：写工具的"正常入参"不要放进上面那轮 probes —— 它们需要真实文件且需要权限层配合，
// 在权限层单独验证更准确（③ 已覆盖非法参数，⑥ 覆盖了完整链路）。

/* ------------------------------------------------------------------ *
 * 第 3 层：真实模型闭环（可选）
 * ------------------------------------------------------------------ */
section(`[4/4] 真实模型闭环${runLlm ? '' : '  —— 跳过，加 --llm 才跑'}`);

if (runLlm) {
  const { createLlm } = await import('../server/lib/llm.mjs');
  const llm = createLlm();
  const ready = (llm.providers?.() || []).some((p) => p.configured);
  if (!ready) {
    check('存在可用模型通道', false, 'providers.json 里没有可用通道');
  } else {
    const r = await loop.runAgent(
      '帮我查一下老班章的山场特征，然后检查这句话能不能在直播间说：「老班章是全国最好的茶，能降三高」',
      { maxSteps: 6 },
    );
    console.log(`      steps=${r.steps.length} toolCalls=${r.meta.toolCalls} stopped=${r.stopped} ${r.meta.totalMs}ms`);
    for (const s of r.steps) {
      for (const c of s.toolCalls) console.log(`      第${s.n}步 → ${c.name}(${JSON.stringify(c.args).slice(0, 60)}) ${c.ok ? 'ok' : 'FAIL'} ${c.ms}ms`);
    }
    console.log(`      答: ${r.answer.slice(0, 200)}`);

    const called = r.steps.flatMap((s) => s.toolCalls.map((c) => c.name));
    check('真实闭环：确实调用了工具（不是凭记忆回答）', called.length > 0, called.join(','));
    check('真实闭环：调用了 search_knowledge（查证类任务应先查）', called.includes('search_knowledge'), called.join(','));
    check('真实闭环：调用了 check_compliance（问"能不能说"必须查合规）', called.includes('check_compliance'), called.join(','));
    check('真实闭环：在轮数上限内自然停止', r.stopped === false, r.stopReason);
    check('真实闭环：给出了非空最终答案', r.answer.length > 0);
    check('真实闭环：总轮数不超过 6', r.steps.length <= 6, `steps=${r.steps.length}`);
  }
}

resetTestFaq();

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`冒烟结果：通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail ? 1 : 0);
