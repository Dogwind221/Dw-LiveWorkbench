/**
 * OpenAI 兼容的对话客户端（零依赖，用 Node 内置 fetch）。
 *
 * 复用 dsh-vision-skill/scripts/vision.js 已验证的范式：
 *   多供应商 → 逐模型优先级降级 → JSON 解析失败同模型重试 → meta.attempts 全量留痕。
 *
 * 安全约束：key 只从环境变量和 providers.json 读，绝不写进代码/日志/错误信息；
 * 任何对外文本都过一遍 maskSecret，脱敏成 sk-***。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 60000; // 契约要求 60s
const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const JSON_HINT = '上次输出不是合法 JSON。请只输出 JSON，不要解释、不要 markdown 代码块。';

/** providers.json 里 kind === "vision" 的条目已经配好可用 key，作为补充通道。 */
const PROVIDERS_FILE = path.join(os.homedir(), '.dsh', 'dsh-vision-config', 'providers.json');

/** 任何可能外泄的字符串都先过这里：先按已知 key 精确替换，再兜住 sk- 形态。 */
function maskSecret(text, keys = []) {
  let s = String(text ?? '');
  for (const k of keys) if (k && k.length >= 8) s = s.split(k).join('sk-***');
  return s.replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***').replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1sk-***');
}

function fail(message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, extra);
  return err;
}

function splitList(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
}

function normalizeProvider(p, i) {
  if (!p) return null;
  const key = String(p.key || p.apiKey || '').trim();
  const models = splitList(p.models ?? p.model);
  const base = String(p.base || p.baseUrl || p.baseURL || '').trim();
  // 非 HTTP 的 base（chatgpt-web:xxx / codex-cli）走的是别的东西，这里只认 OpenAI 兼容端点
  if (!key || !models.length || !/^https?:\/\//i.test(base)) return null;
  return { id: String(p.id || `p${i + 1}`), base: base.replace(/\/+$/, ''), key, models };
}

/** 环境变量通道。LLM_MODEL 逗号分隔即优先级列表。 */
function envProviders() {
  const out = [];
  const models = splitList(process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  const base = process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE;
  const key = String(process.env.LLM_API_KEY || '').trim();
  const dsKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (key) out.push({ id: 'env:llm', base, key, models });
  // 两个 key 都配了就都当通道用（互为备份），重复时不重复注册
  if (dsKey && dsKey !== key) out.push({ id: 'env:deepseek', base: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE, key: dsKey, models });
  return out;
}

/** 读 providers.json；解析失败/文件缺失都不该让调用方崩，静默跳过即可。 */
function visionProviders() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.providers) ? raw.providers : [];
  const out = [];
  for (const [i, p] of arr.entries()) {
    if (!p || p.kind !== 'vision' || p.enabled === false) continue;
    const norm = normalizeProvider({ id: `vision:${p.id || i}`, base: p.base, key: p.apiKey || p.key, models: p.model || p.models }, i);
    if (norm) out.push(norm);
  }
  return out;
}

export function discoverProviders() {
  const seen = new Set();
  const all = [...envProviders(), ...visionProviders()];
  return all.filter((p) => {
    const k = `${p.base}|${p.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function toMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    return input
      .filter((m) => m && m.role)
      .map((m) => ({ role: String(m.role), content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }));
  }
  return [];
}

/** 单次 HTTP 调用。错误信息里只留状态码与响应片段，永不包含请求头。 */
async function callApi(provider, body) {
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw fail(`HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status });
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail(`响应不是合法 JSON: ${raw.slice(0, 200)}`);
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw fail(`响应缺少 choices[0].message.content: ${raw.slice(0, 200)}`);
  }
  return { text, usage: json.usage || null };
}

/**
 * 带工具场景专用的单次 HTTP 调用。
 *
 * 为什么不能复用 callApi：它把「content 必须是非空字符串」当成功条件，
 * 而有工具调用的响应里 `content` 经常是空串（真正的结果在 tool_calls 里），
 * 用它会把一次合法响应误判成失败。这里改成只校验 message 存在，
 * 把 content 交给上层判断，同时把 finish_reason / usage 一并带出来。
 *
 * @returns {Promise<{message:object, finishReason:string|undefined, usage:object|null}>}
 */
async function callApiMessage(provider, body) {
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) throw fail(`HTTP ${res.status}: ${raw.slice(0, 300)}`, { status: res.status });
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail(`响应不是合法 JSON: ${raw.slice(0, 200)}`);
  }
  const choice = json?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== 'object') {
    throw fail(`响应缺少 choices[0].message: ${raw.slice(0, 200)}`);
  }
  return { message, finishReason: choice?.finish_reason, usage: json.usage || null };
}

/**
 * 工具轮的 messages 归一化。
 *
 * 与 toMessages 的关键区别：**这里必须保留 assistant 消息的全部字段**
 * （tool_calls / reasoning_content / name ...）。实测把 assistant 消息重新
 * 组装成 `{role, content}` 再回传，只要开了思考模式就会 400
 * （"The reasoning_content in the thinking mode must be passed back"），
 * 所以除 content 外一律原样透传，且不改动调用方传入的对象。
 */
function toToolMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && m.role)
    .map((m) => ({
      ...m,
      role: String(m.role),
      // tool_calls 型 assistant 消息可以没有 content；补空串而不是删字段，
      // 因为部分中转把「字段缺失」直接当非法请求拒掉
      content: typeof m.content === 'string' ? m.content : m.content == null ? '' : String(m.content),
    }));
}

/**
 * 把一次原始 tool_call 规整成循环层能直接用的形状。
 *
 * `arguments` 是 JSON **字符串**（实测确认），而且模型给坏 JSON 是常态 ——
 * 这里绝不抛错，只把原因记进 argsError，让循环层把错误喂回模型自己纠正。
 * 这比在 llm 层崩掉更有价值：模型看得见自己错在哪。
 */
function normalizeToolCall(call, index) {
  const fn = call?.function || {};
  const name = String(fn.name || '');
  const argsRaw =
    typeof fn.arguments === 'string' ? fn.arguments : fn.arguments == null ? '' : JSON.stringify(fn.arguments);

  let args = {};
  let argsError;
  if (argsRaw.trim()) {
    try {
      const parsed = JSON.parse(argsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed;
      } else {
        argsError = `参数不是 JSON 对象：${argsRaw.slice(0, 120)}`;
      }
    } catch (e) {
      argsError = `JSON 解析失败：${e.message}`;
    }
  }

  const out = { id: String(call?.id || `call_${index}`), name, args, argsRaw };
  if (argsError) out.argsError = argsError;
  return out;
}

/**
 * 从模型输出里抠出 JSON：先剥 markdown 围栏，再退化为"抓最外层成对括号"。
 * 大模型很爱在 JSON 前后加一句解释，直接 JSON.parse 会白白浪费一次重试额度。
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  for (const candidate of [unfenced, raw]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 继续尝试扫描 */
    }
  }
  const start = unfenced.search(/[[{]/);
  if (start < 0) return undefined;
  const open = unfenced[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(unfenced.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** schema 支持三种写法：必填字段名数组 / JSON Schema 对象 / 其字符串形式。 */
function requiredFields(schema) {
  if (!schema) return [];
  if (Array.isArray(schema)) return schema.map(String);
  if (typeof schema === 'string') {
    try {
      return requiredFields(JSON.parse(schema));
    } catch {
      return [];
    }
  }
  if (typeof schema === 'object' && Array.isArray(schema.required)) return schema.required.map(String);
  return [];
}

function validateJson(value, schema) {
  if (value === undefined) return '不是合法 JSON';
  const wantArray = schema && typeof schema === 'object' && !Array.isArray(schema) && schema.type === 'array';
  if (wantArray && !Array.isArray(value)) return '顶层应为数组';
  if (!wantArray && (value === null || typeof value !== 'object')) return '顶层应为对象';
  const missing = requiredFields(schema).filter((f) => {
    const v = value?.[f];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
  });
  return missing.length ? `缺少必填字段: ${missing.join(', ')}` : null;
}

/**
 * @param {Array} [providers]  自定义通道；不传则自动发现（环境变量 + providers.json）
 * @returns {{chat:Function, chatJson:Function, chatWithTools:Function, providers:Function}}
 */
export function createLlm(providers) {
  const custom = Array.isArray(providers) && providers.length ? providers : null;
  const list = (custom ? custom.map(normalizeProvider).filter(Boolean) : discoverProviders());
  const keys = list.map((p) => p.key);

  const status = () => list.map((p) => ({ id: p.id, base: p.base, models: [...p.models], configured: !!p.key }));

  function attemptsSummary(attempts) {
    return attempts.map((a) => `${a.provider}/${a.model}${a.ok ? ' ok' : ` 失败(${a.error || '未知'})`}`).join('; ');
  }

  async function tryOnce(provider, model, body, jsonMode) {
    try {
      return await callApi(provider, body);
    } catch (e) {
      // 部分中转不支持 response_format：只在这一种错误上退一步重发，别把可用的通道浪费掉
      if (jsonMode && e.status === 400 && /response_format|json_object/i.test(e.message)) {
        const relaxed = { ...body };
        delete relaxed.response_format;
        return callApi(provider, relaxed);
      }
      throw e;
    }
  }

  /**
   * 统一的降级循环。parse 存在时走 JSON 路径：解析失败会在同一模型上带提示重试一次。
   * @returns {Promise<{text:string, value:any, meta:object}>}
   */
  async function run(req, parseMode) {
    // 允许 chat('一句话') 这种简写：契约里 messages 本来就是 string|object[]，
    // 调用方少写一层对象不该报错
    if (typeof req === 'string') req = { messages: req };
    req = req || {};
    const messages = toMessages(req.messages);
    if (!messages.length) throw fail('messages 为空：至少需要一轮用户消息');
    if (!list.length) throw fail('没有可用的模型通道：请配置 LLM_API_KEY 或 providers.json', { attempts: [] });

    const temperature = Number.isFinite(Number(req.temperature)) ? Number(req.temperature) : 0.2;
    const attempts = [];
    let lastErr = null;

    for (const provider of list) {
      for (const model of provider.models) {
        const started = Date.now();
        const rec = { provider: provider.id, model, ok: false, ms: 0 };
        attempts.push(rec);
        const convo = [...messages];
        if (parseMode) convo.unshift({ role: 'system', content: '你必须严格输出 JSON，不要输出任何解释文字或 markdown 代码块。' });

        try {
          const body = { model, messages: convo, temperature, stream: false };
          if (req.maxTokens) body.max_tokens = req.maxTokens;
          if (parseMode) body.response_format = { type: 'json_object' };

          let res = await tryOnce(provider, model, body, parseMode);
          let value = parseMode ? extractJson(res.text) : undefined;
          let problem = parseMode ? validateJson(value, req.jsonSchema) : null;

          if (problem) {
            // 契约要求：解析失败重试一次，并明确追加「只输出 JSON」的提示
            rec.error = `${problem}（已追加 JSON 提示重试）`;
            const retry = { ...body, messages: [...convo, { role: 'user', content: JSON_HINT }] };
            res = await tryOnce(provider, model, retry, parseMode);
            value = extractJson(res.text);
            problem = validateJson(value, req.jsonSchema);
          }

          if (problem) {
            rec.ms = Date.now() - started;
            rec.error = maskSecret(problem, keys);
            lastErr = fail(rec.error);
            continue;
          }

          rec.ms = Date.now() - started;
          rec.ok = true;
          delete rec.error;
          const okMeta = { provider: provider.id, model, attempts, usage: res.usage };
          return parseMode ? { text: res.text, value, meta: okMeta } : { text: res.text, value: undefined, meta: okMeta };
        } catch (e) {
          rec.ms = Date.now() - started;
          rec.error = maskSecret(e?.name === 'TimeoutError' ? `超时(${TIMEOUT_MS}ms)` : e?.message || String(e), keys);
          lastErr = e;
        }
      }
    }

    throw fail(
      `所有模型通道均失败（共 ${attempts.length} 次尝试）：${attemptsSummary(attempts)}`,
      { attempts, cause: lastErr ? maskSecret(lastErr.message, keys) : undefined }
    );
  }

  /**
   * @param {object} req  {messages, temperature?, maxTokens?, jsonSchema?}
   * @returns {Promise<{text:string, meta:object}>}
   */
  async function chat(req = {}) {
    // 契约：传了 jsonSchema 就走 chatJson 路径，但返回形状保持 ChatResult
    if (typeof req !== 'string' && req?.jsonSchema) {
      const parsed = await chatJson(req);
      return { text: JSON.stringify(parsed), meta: parsed?.meta || {} };
    }
    const { text, meta } = await run(req, false);
    return { text, meta };
  }

  /**
   * 强制 JSON 输出并校验。返回解析后的对象，并把 meta 挂在 `meta` 字段上；
   * 顶层不是对象（数组/标量）时包成 `{data, meta}`。
   */
  async function chatJson(req = {}) {
    const { value, meta } = await run(req, true);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.assign(value, { meta });
    return { data: value, meta };
  }

  /**
   * 带工具的一轮对话。**不做循环** —— 只发一次请求、回一次结果。
   *
   * 循环为什么留在这里之外：一次请求的成败与「调几次工具」是两个正交的问题。
   * 把循环写在 llm 里，测试就只能靠真模型；拆开之后 loop 层可以注入 stub llm
   * 做离线测试，而这里保持"发一次、回一次"的纯粹性，failover 也只管通道可用性。
   *
   * @param {object} req
   * @param {Array} req.messages  OpenAI 格式，支持 role:"tool" 的消息
   * @param {Array} req.tools     [{type:'function', function:{name, description, parameters}}]
   * @param {'auto'|'none'|'required'} [req.toolChoice='auto']
   * @param {number} [req.maxTokens=1024]
   * @returns {Promise<{text:string, toolCalls:Array, finishReason:string, rawMessage:object, meta:object}>}
   */
  async function chatWithTools(req = {}) {
    const messages = toToolMessages(req.messages);
    if (!messages.length) throw fail('messages 为空：至少需要一轮用户消息');
    if (!list.length) throw fail('没有可用的模型通道：请配置 LLM_API_KEY 或 providers.json', { attempts: [] });

    const toolList = Array.isArray(req.tools) ? req.tools.filter((t) => t?.function?.name) : [];
    const toolChoice = req.toolChoice || 'auto';
    const maxTokens = Number(req.maxTokens) > 0 ? Number(req.maxTokens) : 1024;
    const temperature = Number.isFinite(Number(req.temperature)) ? Number(req.temperature) : 0.2;

    const attempts = [];
    let lastErr = null;

    for (const provider of list) {
      for (const model of provider.models) {
        const started = Date.now();
        const rec = { provider: provider.id, model, ok: false, ms: 0 };
        attempts.push(rec);

        try {
          const body = {
            model,
            messages,
            temperature,
            stream: false,
            max_tokens: maxTokens,
            // 实测：思考模式下 ① 强制 tool_choice 直接 400；② 每个工具轮次都必须回传
            // reasoning_content。固定关掉思考模式，把多轮工具闭环拉回标准 OpenAI 形状。
            thinking: { type: 'disabled' },
          };
          if (toolList.length) {
            body.tools = toolList;
            body.tool_choice = toolChoice;
          }

          const { message, finishReason, usage } = await callApiMessage(provider, body);
          const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          const text = typeof message.content === 'string' ? message.content : '';
          const finish = String(finishReason || (rawCalls.length ? 'tool_calls' : 'stop'));

          // 既没工具调用也没文字：这次响应不含任何可用信息。必须当异常抛掉，
          // 否则循环层拿到空结果只会原地空转（每轮都白烧一次 token），
          // 抛出去还能让 failover 换下一个模型再试。
          if (!rawCalls.length && !text.trim()) {
            throw fail(`响应既没有 content 也没有 tool_calls（finish_reason=${finish}）`);
          }

          rec.ms = Date.now() - started;
          rec.ok = true;
          delete rec.error;
          return {
            text,
            toolCalls: rawCalls.map((c, i) => normalizeToolCall(c, i)),
            finishReason: finish,
            // 原样保留：调用方必须把它整体塞回 messages（含 reasoning_content 等一切字段）
            rawMessage: message,
            meta: { provider: provider.id, model, attempts, usage },
          };
        } catch (e) {
          rec.ms = Date.now() - started;
          rec.error = maskSecret(e?.name === 'TimeoutError' ? `超时(${TIMEOUT_MS}ms)` : e?.message || String(e), keys);
          lastErr = e;
        }
      }
    }

    throw fail(
      `所有模型通道均失败（共 ${attempts.length} 次尝试）：${attemptsSummary(attempts)}`,
      { attempts, cause: lastErr ? maskSecret(lastErr.message, keys) : undefined }
    );
  }

  return { chat, chatJson, chatWithTools, providers: status };
}
