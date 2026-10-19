/**
 * 写操作工具。
 *
 * 和只读工具的设计差异，全部集中在一个字上：**保守**。
 *
 *   读工具  参数写错最多返回空结果，模型换个参数再试就行。
 *   写工具  参数写错会把错数据**永久写进去**。直播知识库里多一条错答案，
 *           主播上播时会照着念出去 —— 这是不可逆的业务损失。
 *
 * 所以这里每条校验都是刻意严格、宁可拒绝的：
 *   - 长度上下限都卡死（太短的"问题"没意义，太长的不是问答是文章）
 *   - 白名单字段（update_deck 只允许改 title/durationMin，**结构字段一律不许**）
 *   - 路径穿越必须挡（deckId 来自模型，模型可能被诱导传 `../../etc/passwd`）
 *   - 去重（同一条问答重复存会污染问答库）
 *
 * 另外：`impact` 是本文件的核心产出之一。用户点"确认"之前必须能看懂
 * **到底要改什么、改成什么、有没有风险**。只给一句"将保存"是失职。
 */
import fs from 'node:fs';
import path from 'node:path';

import { dataDir, decksDir } from '../paths.mjs';
import { checkText } from '../compliance.mjs';

/**
 * 路径必须**每次调用时**解析，不能在模块顶层算成常量。
 *
 * 写成 `const FAQ_FILE = path.join(dataDir(), 'faq.json')` 会在 import 时
 * 求值一次，之后永远是那个租户的路径 —— 不报错，但会**静默串租户**。
 * 这是多租户改造里最隐蔽的一类 bug。
 */
const faqFile = () => path.join(dataDir(), 'faq.json');

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 名称归一化：去空格标点大小写。用于"这条问答是不是已经存在"的判断。 */
const norm = (s) => str(s).toLowerCase().replace(/[\s\u3000·・\-_()（）【】,，。.!！?？:：;；"'"'`]/g, '');

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename。避免写一半进程崩了留下坏 JSON。 */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * deckId 是模型给的字符串，必须挡路径穿越。
 * 合法 id 形如 `deck_mvb6b3gxfcgm`：前缀 + 小写字母数字。
 * 用白名单正则而不是"过滤掉 .."，因为黑名单永远漏。
 */
const DECK_ID_RE = /^deck_[a-z0-9]{6,40}$/;

/** update_deck 允许改的字段。**结构字段绝不允许** —— 见文件头注释。 */
const DECK_EDITABLE = {
  title: { label: '标题', validate: (v) => (v.length >= 1 && v.length <= 60 ? null : '标题必须 1–60 字') },
  durationMin: {
    label: '时长（分钟）',
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 15 || n > 240) return '时长必须是 15–240 的整数';
      return null;
    },
  },
};

/* ------------------------------------------------------------------ *
 * 工具 ①：save_faq
 * ------------------------------------------------------------------ */
const saveFaq = {
  name: 'save_faq',
  permission: 'write',
  definition: {
    type: 'function',
    function: {
      name: 'save_faq',
      description:
        '把一条问答存进直播问答库，以后遇到同类问题可以直接调出来用。当用户明确要求「把这条存下来」「记录到问答库」「以后遇到就按这个答」时使用。'
        + '注意：本工具属于**写操作**，调用后不会立即写入，而是先生成一份待确认的改动让用户核对，用户确认后才会真正保存。'
        + '因此调用后应当把「准备保存什么」告诉用户并请其确认，**不要声称已经保存好了**。'
        + '必填 question（2–200 字）和 answer（2–1000 字）；tags 可选。'
        + '如果问答库里已有同样的问题会拒绝保存，并提示已存在。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '观众会问的问题原文，2–200 字，写成口语' },
          answer: { type: 'string', description: '可以直接照念的回答，2–1000 字，口语化' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ["价格","冲泡"]' },
        },
        required: ['question', 'answer'],
      },
    },
  },

  /**
   * 只做校验和影响预览，**不写盘**。
   *
   * 为什么不在这里写：写盘时机由权限层决定（用户确认之后）。
   * 工具保持"只描述将要做什么"，执行由 `applySaveFaq` 完成 —— 这样
   * 预览和实际执行看的是**同一份校验结果**，不会出现"预览说能存、真存时失败"。
   */
  async execute(args = {}) {
    const question = str(args.question).trim();
    const answer = str(args.answer).trim();
    const tags = Array.isArray(args.tags) ? args.tags.map(str).filter(Boolean).slice(0, 8) : [];

    if (question.length < 2 || question.length > 200) {
      return { ok: false, error: 'question 必须是 2–200 字的字符串（现在 ' + question.length + ' 字）' };
    }
    if (answer.length < 2 || answer.length > 1000) {
      return { ok: false, error: 'answer 必须是 2–1000 字的字符串（现在 ' + answer.length + ' 字）' };
    }

    const list = readJsonSafe(faqFile(), []);
    const exists = Array.isArray(list) && list.some((x) => norm(x?.q) === norm(question));
    if (exists) {
      return { ok: false, error: `问答库里已经有同样的问题了（归一化后完全一致），没有重复保存：${question}` };
    }

    // ★ 这是这个工具最重要的防护：模型写的回答可能本身就违规。
    // 存进去之后主播照着念就是事故，所以确认面板必须把风险显式摆出来。
    const warnings = [];
    try {
      const c = checkText(answer, {});
      const hits = (c?.hits || []).map((h) => `${h.word}${h.suggest ? `→${h.suggest}` : ''}`);
      if (hits.length) warnings.push(`回答里含违禁表述：${hits.slice(0, 5).join('、')}，上播前请改写`);
    } catch {
      /* 合规模块不可用不该阻断保存，但也不冒险 */
    }

    const before = Array.isArray(list) ? list.length : 0;

    return {
      ok: true,
      summary: `准备向问答库新增 1 条：${question.slice(0, 30)}${question.length > 30 ? '…' : ''}（确认后生效）`,
      // data 给模型看（很短，不能撑爆上下文）
      data: { question, answerLength: answer.length, tags, willAdd: 1 },
      // persist.data 给"确认后真正写盘"用：这里放的是**已经过校验的最终形态**
      // 第二次调用时不会用模型新传的参数重新构造，而是用这份 —— 防篡改
      persist: {
        filename: `faq-${Date.now()}.json`,
        data: { question, answer, tags },
      },
      impact: {
        action: '新增问答',
        target: 'data/faq.json',
        before: `当前 ${before} 条`,
        after: `写入后 ${before + 1} 条`,
        preview: {
          问题: question,
          回答: answer.length > 200 ? `${answer.slice(0, 200)}…（共 ${answer.length} 字）` : answer,
          ...(tags.length ? { 标签: tags.join('、') } : {}),
        },
        warnings,
      },
      applyArgs: { question, answer, tags },
    };
  },
};

/** 真正落盘。由权限层在用户确认后调用，**不接受模型传入的新参数**。 */
export function applySaveFaq(applyArgs) {
  const question = str(applyArgs?.question).trim();
  const answer = str(applyArgs?.answer).trim();
  const tags = Array.isArray(applyArgs?.tags) ? applyArgs.tags : [];

  const list = readJsonSafe(faqFile(), []);
  const arr = Array.isArray(list) ? list : [];
  // 幂等：同一 actionId 被批准两次时，第二次会走到这里，不能重复插入
  if (arr.some((x) => norm(x?.q) === norm(question))) {
    return { ok: false, error: '这条问答已经存在（可能是重复批准），未重复写入' };
  }
  const item = {
    id: `faq_${Date.now().toString(36)}`,
    q: question,
    a: answer,
    enabled: true,
    tags,
  };
  arr.unshift(item);
  writeJsonAtomic(faqFile(), arr);
  return { ok: true, item, total: arr.length };
}

/* ------------------------------------------------------------------ *
 * 工具 ②：update_deck
 * ------------------------------------------------------------------ */
const updateDeck = {
  name: 'update_deck',
  permission: 'write',
  definition: {
    type: 'function',
    function: {
      name: 'update_deck',
      description:
        '修改一份已生成的直播方案的标题或时长。当用户要求「把这份方案的标题改成…」「时长改成 90 分钟」时使用。'
        + '只支持改 title（标题，1–60 字）和 durationMin（时长，15–240 整数）两个字段；'
        + '**不支持**改幻灯片内容、逐字稿、段落结构 —— 那些字段由生成引擎维护，直接改会让方案前后不一致。'
        + '本工具属于**写操作**，调用后先生成待确认的改动，用户确认后才真正写入；'
        + '所以调用后请把改动前后对比告诉用户，**不要声称已经改好了**。'
        + 'deckId 可从 build_live_deck 的结果或历史方案列表里拿到；id 不存在时会返回可用的最近几个 id。',
      parameters: {
        type: 'object',
        properties: {
          deckId: { type: 'string', description: '方案 id，形如 deck_mvb6b3gxfcgm' },
          field: { type: 'string', enum: ['title', 'durationMin'], description: '要改的字段' },
          value: { type: 'string', description: '新值；durationMin 传数字的字符串形式，如 "90"' },
        },
        required: ['deckId', 'field', 'value'],
      },
    },
  },

  async execute(args = {}) {
    const deckId = str(args.deckId).trim();
    const field = str(args.field).trim();
    const value = str(args.value).trim();

    if (!DECK_ID_RE.test(deckId)) {
      // 不直接报"格式不对"，而是列出真实可用 id，帮模型自己纠正
      const recent = listRecentDeckIds(3);
      return {
        ok: false,
        error: `deckId 不合法（应为 deck_ 开头的小写字母数字，收到 "${deckId.slice(0, 40)}"）。`
          + (recent.length ? `可用的最近方案 id：${recent.join('、')}` : '当前没有已生成的方案。'),
      };
    }

    const spec = DECK_EDITABLE[field];
    if (!spec) {
      return {
        ok: false,
        error: `不支持修改字段 "${field}"。只能改：${Object.keys(DECK_EDITABLE).join('、')}。`
          + '幻灯片内容、逐字稿、段落结构由生成引擎维护，不支持直接修改。',
      };
    }
    const invalid = spec.validate(value);
    if (invalid) return { ok: false, error: `${spec.label}不合法：${invalid}` };

    const file = path.join(decksDir(), `${deckId}.json`);
    const deck = readJsonSafe(file, null);
    if (!deck) {
      const recent = listRecentDeckIds(3);
      return {
        ok: false,
        error: `找不到方案 ${deckId}。`
          + (recent.length ? `可用的最近方案 id：${recent.join('、')}` : '当前没有已生成的方案。'),
      };
    }

    const before = field === 'durationMin' ? Number(deck.durationMin ?? deck.input?.durationMin) : str(deck[field] ?? deck.input?.[field]);
    const after = field === 'durationMin' ? Number(value) : value;
    if (String(before) === String(after)) {
      return { ok: false, error: `改前改后一样（${spec.label}已经是 "${before}"），不需要修改` };
    }

    return {
      ok: true,
      summary: `准备把《${str(deck.title).slice(0, 24)}》的${spec.label}从 "${before}" 改为 "${after}"（确认后生效）`,
      data: { deckId, field, before, after },
      persist: { filename: `deck-${deckId}.json`, data: { deckId, patch: { [field]: after } } },
      impact: {
        action: `修改方案${spec.label}`,
        target: `data/decks/${deckId}.json`,
        changes: [{ field: spec.label, before, after }],
        warnings: field === 'durationMin'
          ? ['只改时长不会重排逐字稿：稿子的分钟数和覆盖率仍是按原时长算的，可能需要重新生成方案']
          : [],
      },
      applyArgs: { deckId, field, value: after },
    };
  },
};

/** 最近生成的几个 deck id —— 用来帮模型在 id 写错时自己纠正。 */
function listRecentDeckIds(n = 3) {
  try {
    return fs
      .readdirSync(decksDir())
      .filter((f) => DECK_ID_RE.test(f.replace(/\.json$/, '')))
      .map((f) => {
        const id = f.replace(/\.json$/, '');
        return { id, mtime: fs.statSync(path.join(decksDir(), f)).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n)
      .map((x) => x.id);
  } catch {
    return [];
  }
}

/** 真正落盘。只改白名单字段，**重读一遍再改**，避免用过期快照覆盖别人的修改。 */
export function applyUpdateDeck(applyArgs) {
  const { deckId, field, value } = applyArgs || {};
  if (!DECK_ID_RE.test(str(deckId))) return { ok: false, error: 'deckId 不合法' };
  if (!DECK_EDITABLE[field]) return { ok: false, error: `不支持修改字段 ${field}` };

  const file = path.join(decksDir(), `${deckId}.json`);
  const deck = readJsonSafe(file, null);
  if (!deck) return { ok: false, error: `找不到方案 ${deckId}` };

  const before = deck[field];
  deck[field] = value;
  // input 里也同步一份：生成的引擎和导出器读的是 input.*，
  // 只改顶层会导致"列表显示新标题、导出还是旧标题"。
  if (deck.input && typeof deck.input === 'object') {
    if (field === 'title') deck.input.topic = value;
    if (field === 'durationMin') deck.input.durationMin = value;
  }
  deck.updatedAt = new Date().toISOString();
  writeJsonAtomic(file, deck);
  return { ok: true, deckId, field, before, after: value };
}

export const WRITE_TOOLS = [saveFaq, updateDeck];
