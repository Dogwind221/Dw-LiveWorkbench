/**
 * Agent 编排（ReAct 循环）。
 *
 * 这是整个 Agent 部分的**核心**，也是和 RAG 最本质的区别：
 *
 *   RAG   —— 流程由**代码**决定：检索 → 拼 prompt → 生成。模型只负责"写"。
 *   Agent —— 流程由**模型**决定：调哪个工具、调几次、什么顺序。代码只负责"执行 + 兜底"。
 *
 * 所以这个文件的职责不是"实现智能"，而是**当一个可靠的执行器**：
 * 把模型的决定变成真实动作，把结果原样喂回去，并在模型行为失控时**硬性刹车**。
 *
 * 设计的重心全在"刹车"和"防错"上 —— 因为模型不可信，而它现在有了动手的能力：
 *   - 轮数上限、工具调用总数上限（防死循环烧钱）
 *   - 幻觉工具名 → 喂回错误让它自己纠正（不崩、也不算失败）
 *   - 工具抛异常 → 捕获后喂回（同上）
 *   - 参数解析失败 → 喂回（同上）
 *   - **写操作不经用户确认绝不执行**（见 permissions.mjs，两阶段提交）
 *   这几条合起来是"**错误也是对话的一部分**"这个原则：模型能看见自己犯的错，才有机会改。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createLlm } from '../llm.mjs';
import { getTool, listToolDefs } from './tools.mjs';
import { decide, registerPending, audit } from './permissions.mjs';
import { applySaveFaq, applyUpdateDeck } from './tools-write.mjs';
import { loadKB } from '../kb.mjs';
import { ROOT, agentOut } from '../paths.mjs';

/** 写工具的落盘实现。按名字分发 —— 工具只描述"将要写什么"，真正写由这里做。 */
const WRITE_APPLIERS = {
  save_faq: applySaveFaq,
  update_deck: applyUpdateDeck,
};

const MAX_STEPS = 8;
const MAX_TOOL_CALLS = 12;
const MAX_TOKENS = 1024;

/** 单个工具返回给模型的内容长度上限。防止某个工具把上下文撑爆。 */
const TOOL_RESULT_LIMIT = 4000;

/**
 * `output/agent/` 保留的历史产出数量。
 *
 * 每跑一次生成方案就会落盘一个 100–230KB 的 JSON，评测跑几轮就能堆出上百个文件。
 * 这是"Agent 会自己干活"带来的新问题：RAG 阶段不会累积任何文件。
 * 保留最近 N 个足够回溯排查，多余的直接删 —— 不能让它无声无息涨到几个 G。
 */
const ARTIFACT_KEEP = 30;

/**
 * 系统提示词。
 *
 * 每个要点都对应一类**实测**会出问题的行为，不是凭空写的：
 *   1. "能查就查" —— 否则模型会凭训练记忆回答普洱茶问题，那就是幻觉
 *   2. "够了就停" —— 否则模型会反复调同一个工具
 *   3. "工具报错就改参数重试或说明做不到" —— 否则它会把错误当成功继续往下编
 *   4. **写工具要照常调用** —— 这条是实测补的：用户说"直接存不用问我"时，
 *      模型有 2/4 次误以为"需要确认"等于"不能调用"，于是连 write 工具都不调，
 *      用户就永远看不到确认卡片，功能等于断了。
 *      关键认知：**要不要确认是代码决定的，不是模型决定的** —— 模型只负责提议。
 */
const SYSTEM = `你是一个普洱茶直播工作台的执行助手。你可以调用工具来完成用户的请求。

工作方式：
1. 需要事实依据时**先调用工具**，不要凭记忆回答。涉及具体山头、价格、海拔、冲泡参数的问题，
   必须先用 search_knowledge 查证。
2. 涉及"能不能说""会不会违规"的问题，必须用 check_compliance 检查，不要自己判断合规性。
3. 收集到足够信息后**直接给出最终回答**，不要重复调用已经调用过的工具。
4. 工具报错时，看清错误原因：能改参数就改一个合理的再试一次；确实做不到就告诉用户做不到，
   不要假装成功。
5. 最终回答用口语化中文，直接说结论，不要说"根据工具返回"这种废话开头。
6. 如果用户的要求超出你的工具能力范围，直接说明你做不到，并说清你**能**做什么。

关于写操作（保存问答、修改方案）——这几条很重要：
- 写工具**照常调用**。调用它不会立刻改数据，系统会先生成一份待确认的改动交给用户核对，
  用户点确认后才真正写入。所以"需要用户确认"**不是**你不能调用工具的理由。
- 哪怕用户说"直接存，不用问我了"，你也要调用写工具发起提议 —— 是否执行由系统把关，
  不由你跳过。**不要回答"我没法跳过确认"或"我不能直接存"然后停下**，那样用户就看不到确认入口了。
- 调用写工具之后，你这一轮的状态是「**已经发起、但还没写入**」。请把待写入的内容告诉用户、
  请他去点确认。**绝对不要说"已经保存好了""已帮你存进问答库""已经改好了"这类话** ——
  写入根本没有发生。准确说法是"已经发起保存，等你点一下确认"。
- 用户点确认之后会有新的一轮对话，那时才根据真实执行结果回复。**不要提前代替系统宣布结果。**`;

/** 只保留首尾，中间截断。比硬切前 N 字更不容易丢掉结论部分。 */
function clip(text, limit = TOOL_RESULT_LIMIT) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= limit) return s;
  const head = s.slice(0, Math.floor(limit * 0.7));
  const tail = s.slice(-Math.floor(limit * 0.2));
  return `${head}\n…（中间省略 ${s.length - head.length - tail.length} 字）…\n${tail}`;
}

/** 把工具结果压成喂给模型的字符串。data 一定要带 JSON，因为模型要靠它做判断。 */
function renderToolResult(result) {
  if (!result || typeof result !== 'object') return JSON.stringify({ ok: false, error: '工具没有返回结果' });
  const payload = result.ok
    ? {
        ok: true,
        summary: result.summary,
        data: result.data,
        // savedTo 必须回传：否则模型不知道大件产出的文件在哪，
        // 就没法告诉用户"稿子已存到 X"，落盘这件事对用户等于没发生。
        ...(result.savedTo ? { savedTo: result.savedTo } : {}),
      }
    : { ok: false, error: result.error || '未知错误' };
  return clip(JSON.stringify(payload));
}

/**
 * 把工具产出的大件结果落盘。
 *
 * 为什么由循环层写盘、而不是工具自己写：**工具保持纯函数**才能被单测和复用；
 * 而"把结果交付给用户"是**编排层的职责**。
 *
 * 协作方式：工具在 `ToolResult.persist` 里声明 `{ filename, data }`（纯数据，不碰 IO），
 * 循环层负责真正写盘、记录路径、并把"已保存到 X"追加进上下文 ——
 * 模型只需要知道文件名，不需要把几万字正文塞进上下文。
 *
 * @returns {string|null} 相对路径；失败返回 null
 */
function persistArtifact(persist) {
  if (!persist || !persist.filename) return null;
  try {
    // 每次落盘时按当前租户解析目录（不能在模块顶层算成常量，否则会静默串租户）
    const dir = agentOut();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(persist.filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    const file = path.join(dir, safe);
    fs.writeFileSync(file, JSON.stringify(persist.data ?? null, null, 2), 'utf8');
    pruneArtifacts(dir);
    // 回给模型的路径必须是**真实**相对路径。多租户后它在
    // output/tenants/<id>/agent/ 下，硬编码 'output/agent/...' 会让用户找不到文件。
    return path.relative(ROOT, file).replace(/\\/g, '/');
  } catch {
    // 落盘失败不该让整个任务失败 —— 模型仍然可以基于摘要回答
    return null;
  }
}

/** 只留最近 ARTIFACT_KEEP 个产出。清理失败也不影响主流程。 */
function pruneArtifacts(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(ARTIFACT_KEEP)) fs.unlinkSync(f.full);
  } catch {
    /* 清理是尽力而为 */
  }
}

/**
 * @param {string} task
 * @param {object} [opts]
 */
export async function runAgent(task, opts = {}) {
  const text = String(task ?? '').trim();
  if (!text) throw Object.assign(new Error('task 不能为空'), { code: 'BAD_TASK' });

  const maxSteps = Math.min(Math.max(Number(opts.maxSteps) || MAX_STEPS, 1), 20);
  const maxToolCalls = Math.min(Math.max(Number(opts.maxToolCalls) || MAX_TOOL_CALLS, 1), 40);

  /**
   * 权限策略。
   * - `approvals`：已批准的动作 id
   * - `allowWrites`：false 时所有写工具一律拒绝
   * - `role`：当前角色（由 HTTP 层从 token 解析后传进来）。不传时权限层会去读
   *   租户上下文；两者都没有 = 本地/CLI 模式，视为不受限。
   */
  const policy = {
    approvals: Array.isArray(opts.approvals) ? opts.approvals.map(String) : [],
    allowWrites: opts.allowWrites !== false,
    role: opts.role,
  };

  const llm = opts.llm || createLlm();
  const ctx = opts.ctx || { kb: loadKB() };
  const tools = listToolDefs();

  const started = Date.now();
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: text },
  ];

  const steps = [];
  /** @type {{name:string, ok:boolean, ms:number, summary:string, error?:string}[]} */
  const callLog = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const artifacts = [];

  let answer = '';
  let stopped = false;
  let stopReason = '';
  let lastAttempts = [];
  /** 是否至少完整跑过一轮循环。用于区分"模型直接答了"和"被上限截断"。 */
  let stepped = false;
  /** 本次运行中等待用户确认的写操作。前端靠它渲染确认卡片。 */
  const pendingList = [];
  /** 本次运行是否涉及写工具（哪怕最终没执行）。前端据此区分"只是查"和"要动手"。 */
  let hasWrites = false;
  /** 真正执行过写操作没有。用来核对模型有没有谎称"已保存"。 */
  let writeExecuted = false;

  for (let n = 1; n <= maxSteps; n++) {
    const turnStart = Date.now();
    let res;
    try {
      res = await llm.chatWithTools({ messages, tools, toolChoice: 'auto', maxTokens: MAX_TOKENS });
    } catch (err) {
      // 模型通道整体不可用：把已经拿到的中间结果交给调用方，而不是丢掉
      return {
        answer: answer || '',
        steps,
        stopped: true,
        stopReason: `模型通道不可用：${err.message}`,
        artifacts,
        // 字段形状必须和正常返回**一致**：调用方不该因为走了错误分支就要额外判空
        pending: [],
        hasWrites: false,
        writeExecuted: false,
        falseWriteClaim: false,
        meta: {
          steps: steps.length,
          toolCalls: callLog.length,
          totalMs: Date.now() - started,
          usage,
          attempts: err.attempts || [],
        },
      };
    }

    lastAttempts = res.meta?.attempts || lastAttempts;
    if (res.meta?.usage) {
      for (const k of Object.keys(usage)) usage[k] += Number(res.meta.usage[k]) || 0;
    }

    const step = { n, thought: res.text || '', toolCalls: [] };
    steps.push(step);
    stepped = true;

    // 没有工具调用 = 模型认为可以给最终答案了，循环结束
    if (!res.toolCalls || res.toolCalls.length === 0) {
      answer = res.text || answer;
      stopReason = '模型给出了最终答案';
      break;
    }

    // 原样把 assistant 消息塞回历史。必须原样（含 reasoning_content 等字段），
    // 否则开启思考模式时回传会 400 —— 这是实测过的坑。
    messages.push(res.rawMessage);

    for (const call of res.toolCalls) {
      if (callLog.length >= maxToolCalls) {
        stopped = true;
        stopReason = `达到工具调用上限（${maxToolCalls} 次），已停止`;
        break;
      }

      const tStart = Date.now();
      const tool = getTool(call.name);
      let result;
      let ok = false;
      let summary = '';
      let error;

      if (!tool) {
        // 模型幻觉出不存在的工具名。这不是失败，是"需要被纠正的行为"：
        // 把可用工具列表也告诉它，比只说"没有这个工具"更容易让它走回正轨。
        error = `不存在名为 "${call.name}" 的工具。可用工具：${tools.map((t) => t.function.name).join('、')}`;
        result = { ok: false, error };
      } else if (call.argsError) {
        error = `参数不是合法 JSON（${call.argsError}），收到的原文是：${clip(call.argsRaw, 200)}`;
        result = { ok: false, error };
      } else if (tool.permission !== 'write') {
        /**
         * 读工具：直接执行。
         *
         * 这一支必须**先于**权限判定 —— 曾经把 decide() 返回 execute 的所有工具都送进
         * 写工具落盘分支（WRITE_APPLIERS[name] 对读工具必然是 undefined），
         * 结果**每一个读工具都返回"没有注册落盘实现"**，Agent 整个变哑。
         * 分流依据必须是工具自己的 permission，不是 decide 的结论。
         */
        try {
          result = await tool.execute(call.args || {}, ctx);
          ok = result?.ok !== false;
          summary = result?.summary || '';
          error = result?.error;
        } catch (err) {
          error = `工具执行异常：${err.message}`;
          result = { ok: false, error };
        }
      } else {
        /**
         * 写操作的两阶段提交。顺序很重要：**先判权限，再决定要不要真正执行**。
         * 注意这里判的是 `tool.permission`，不是模型传的参数 —— 模型无法伪造。
         */
        const verdict = decide({ tool, args: call.args, policy });
        hasWrites = true;

        if (verdict.decision === 'deny') {
          audit({ kind: 'deny', tool: call.name, actionId: verdict.actionId, args: call.args, reason: verdict.reason });
          result = { ok: false, error: `${verdict.reason}：当前策略不允许执行写操作，请告诉用户需要先在界面上授权` };
          error = result.error;
        } else if (verdict.decision === 'confirm') {
          // 先跑一遍工具拿到"影响预览"，但**绝不落盘**
          let preview = null;
          try {
            preview = await tool.execute(call.args || {}, ctx);
          } catch (err) {
            preview = { ok: false, error: `预览失败：${err.message}` };
          }

          if (preview?.ok === false) {
            // 校验没过（参数不合法 / 已存在 / id 不存在）：就该如实报错，不要登记待确认
            result = preview;
            error = preview.error;
          } else {
            const entry = {
              actionId: verdict.actionId,
              tool: call.name,
              args: call.args,
              impact: preview?.impact || {},
              applyArgs: preview?.applyArgs || call.args,
            };
            registerPending(entry);
            audit({ kind: 'confirm', tool: call.name, actionId: verdict.actionId, args: call.args, impact: preview?.impact });
            if (!pendingList.some((p) => p.actionId === verdict.actionId)) pendingList.push(entry);

            // 回传给模型的内容要让它明白：**还没执行**，要让用户确认
            result = {
              ok: false,
              needsApproval: true,
              actionId: verdict.actionId,
              error: `这个写操作需要用户确认后才能执行（actionId=${verdict.actionId}）。`
                + '请把影响告诉用户并请其确认；**不要说已经完成**。',
              impact: preview?.impact || {},
            };
            error = result.error;
          }
        } else {
          /**
           * 已批准：用**登记时那份已校验的 applyArgs**，而不是模型这次传的参数 ——
           * 防止"批准了 A、第二次调用换成 B"的偷换。
           *
           * 但有个真实场景必须处理：**用户批准后重新发起请求**（前端就是这么做的），
           * 这一次运行里 pendingList 是空的，没有"登记时那份参数"。
           * 此时不能直接失败 —— 参数已经被 decide() 校验过（actionId 就是由它算出来的），
           * 所以重跑一次工具的校验拿到 applyArgs 是安全的。
           */
          const stored = pendingList.find((p) => p.actionId === verdict.actionId);
          const apply = WRITE_APPLIERS[call.name];
          if (!apply) {
            result = { ok: false, error: `写工具 ${call.name} 没有注册落盘实现` };
            error = result.error;
          } else {
            let applyArgs = stored?.applyArgs;
            if (!applyArgs) {
              // 本轮没有 pending 记录：重新跑校验，拿到同一份规范化参数
              try {
                const fresh = await tool.execute(call.args || {}, ctx);
                if (!fresh?.ok) {
                  result = fresh;
                  error = fresh?.error;
                } else {
                  applyArgs = fresh.applyArgs;
                }
              } catch (err) {
                result = { ok: false, error: `参数复核失败：${err.message}` };
                error = result.error;
              }
            }

            if (applyArgs) {
              try {
                const applied = apply(applyArgs);
                ok = applied.ok !== false;
                error = applied.ok === false ? applied.error : undefined;
                writeExecuted = ok;
                summary = ok ? `已写入：${call.name}` : '';
                audit({ kind: 'execute', tool: call.name, actionId: verdict.actionId, args: applyArgs, ok, error });
                result = applied.ok === false
                  ? { ok: false, error: applied.error }
                  : { ok: true, summary, data: applied };
              } catch (err) {
                error = `写入失败：${err.message}`;
                result = { ok: false, error };
                audit({ kind: 'execute', tool: call.name, actionId: verdict.actionId, ok: false, error });
              }
            }
          }
        }
      }

      const ms = Date.now() - tStart;
      callLog.push({ name: call.name, ok, ms, summary, error });
      step.toolCalls.push({ name: call.name, args: call.args, ok, summary, ms, error });

      // 工具声明了要落盘的大件产出（如完整直播方案）：循环层负责真正写盘，
      // 并把路径追加进回传内容 —— 模型据此告诉用户文件在哪，正文不必进上下文。
      let savedPath = null;
      if (ok && result?.persist) {
        savedPath = persistArtifact(result.persist);
        if (savedPath) {
          artifacts.push({ tool: call.name, path: savedPath });
          step.savedPath = savedPath;
        }
      }

      const payload = savedPath
        ? { ...result, savedTo: savedPath, persist: undefined }
        : result;

      // 把工具结果回传。失败也要回传 —— 模型看见错误才有可能自己修。
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: renderToolResult(payload),
      });
    }

    // 工具调用超限时，不能再继续循环（否则模型会一直要工具）
    if (stopped) break;

    if (n === maxSteps) {
      stopped = true;
      stopReason = `达到循环轮数上限（${maxSteps} 步），已停止`;
    }
  }

  if (!answer && !stopped) {
    stopped = true;
    stopReason = stopReason || '循环结束但模型没有给出最终答案';
  }

  /**
   * 被上限截断时，模型往往还没来得及说话 —— 但**工具已经真的干过活了**。
   * 返回空字符串会让用户以为"什么都没发生"，而实际上可能已经生成了方案。
   * 所以这里用工具的真实产出兜一句话，让用户知道做完了什么、还能去哪找。
   * 这不是编造：内容全部来自工具返回值。
   */
  if (!answer && stepped) {
    const okCalls = callLog.filter((c) => c.ok && c.summary);
    if (okCalls.length) {
      // 去重：模型常把同一个工具用同样的参数调好几次，不去重的话
      // 兜底答复会变成同一行重复三遍，看起来像系统出故障。
      const seen = new Set();
      const done = okCalls
        .filter((c) => {
          const k = `${c.name}|${c.summary}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((c) => `- ${c.name}：${c.summary}`)
        .join('\n');
      const files = artifacts.length ? `\n\n产出文件：${artifacts.map((a) => a.path).join('、')}` : '';
      answer = `任务没能在 ${maxSteps} 轮内做完（${stopReason}），但下面这些已经做完了：\n${done}${files}\n\n把任务说得更具体一点再试一次，或者告诉我下一步只做哪件事。`;
    } else if (callLog.some((c) => !c.ok)) {
      const errs = [...new Set(callLog.filter((c) => !c.ok).map((c) => c.error).filter(Boolean))];
      answer = `任务没做成（${stopReason}）。工具报的错是：\n${errs.map((e) => `- ${e}`).join('\n')}`;
    }
  }

  /**
   * 谎报检查：模型说"已保存 / 已修改"但实际什么都没执行。
   *
   * 这是写操作里最危险的幻觉类型 —— 用户以为存好了，其实还要点确认；
   * 或者更糟：模型压根没提议成功，却报了个"已完成"。中文里这类表述极多，
   * 所以这里只做**检测和标注**，不擅自改写模型的答案：
   * 改写得由调用方决定（评测要度量它，界面要提示用户）。
   */
  const CLAIM_RE = /(已(经)?\s*(保存|存入|存好|写入|修改|更新|改好|完成))|((保存|修改|更新)(成功|好了))/;
  const falseWriteClaim = !writeExecuted && CLAIM_RE.test(answer) && (hasWrites || pendingList.length > 0);

  return {
    answer,
    steps,
    stopped,
    stopReason,
    artifacts,
    /** 等待用户确认的写操作。空数组 = 本次运行没有需要确认的动作。 */
    pending: pendingList,
    /** 本次运行是否涉及写工具（哪怕最终没执行） */
    hasWrites,
    /** 真正执行过写操作没有 */
    writeExecuted,
    /** 模型是否谎称"已完成"但其实没写（评测与界面都要用它） */
    falseWriteClaim,
    meta: {
      steps: steps.length,
      toolCalls: callLog.length,
      totalMs: Date.now() - started,
      usage,
      attempts: lastAttempts,
    },
  };
}

export { MAX_STEPS, MAX_TOOL_CALLS };
