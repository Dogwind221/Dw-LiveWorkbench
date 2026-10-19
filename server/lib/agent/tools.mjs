/**
 * Agent 工具注册表。
 *
 * 这里**不是**业务逻辑的所在：每个工具都是「一份给模型看的说明书 + 一个薄执行壳」。
 * 真正的能力都在既有模块里（rag/search、compliance、deck/build、review），
 * 工具层只做三件事：校验参数、裁剪形状、给一句人话摘要。
 *
 * 两条贯穿全文件的纪律：
 *
 *  1. **execute 永不抛异常。** 参数是模型现场生成的，写错是常态而不是 bug。
 *     抛出会让循环层只能给模型一句栈信息；返回 `{ok:false, error}` 则能让模型
 *     读懂"我哪里写错了"并自己改对 —— 这是 Agent 与普通函数调用最大的区别。
 *
 *  2. **data 必须小且可 JSON.stringify。** 它每一轮都会重新进上下文，
 *     把几万字正文塞进去等于把后面的对话挤没（所以 build_live_deck 只回结构）。
 *     同时严格排除 undefined / 函数：一次 stringify 失败就会打断整条链。
 */
import { loadKB } from '../kb.mjs';
import { searchKnowledge } from '../rag/search.mjs';
import { loadCompliance, checkText, summarize } from '../compliance.mjs';
import { buildDeck, listOptions } from '../deck/build.mjs';
import { listSessions } from '../review.mjs';
import { WRITE_TOOLS } from './tools-write.mjs';

/** 合规检查的输入上限：逐字稿上万字很常见，但 cleaned 会原样回传，太长会挤爆上下文。 */
const COMPLIANCE_TEXT_LIMIT = 5000;
/** 列表类工具一次最多回传的条数（模型的上下文也是预算）。 */
const LIST_LIMIT = 20;
const SESSION_LIMIT = 10;

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 参数是模型写的，类型什么都可能；这里统一只认非空字符串。 */
function requireText(args, key) {
  const v = args?.[key];
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim();
}

/** 数值参数一律 clamp 而不是报错：模型给 999 是想"多要几条"，不是想失败。 */
function clampInt(v, min, max, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 名称归一化：中文里空格/间隔号/括号的写法极不一致，比对前先抹平。 */
const normText = (s) => str(s).toLowerCase().replace(/[\s\u3000·・\-_()（）【】]/g, '');

/** 知识库由循环层注入（避免每个工具重复读盘）；单独调用时自己兜底读一次。 */
function getKb(ctx) {
  return ctx?.kb || loadKB();
}

/* ------------------------------------------------------------------ *
 * 工具定义。description 是模型选择工具的唯一依据，
 * 所以每条都必须写清「做什么 / 什么时候用 / 返回什么、不返回什么」。
 * ------------------------------------------------------------------ */
const TOOLS = [
  {
    name: 'search_knowledge',
    definition: {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description:
          '在普洱茶知识库里检索相关原文片段（山头档案、茶品资料、合规规则）。当用户询问某个山头的山场特征、产地、海拔、树种、土壤、风味、价格区间、冲泡参数、避坑要点，或需要为直播核实事实、找素材时使用。' +
          '只做检索并返回原文片段与出处，**不会生成、总结或改写答案**；返回 0 条就说明知识库里确实没有这项内容，请如实告知用户，不要凭记忆编造。' +
          '返回每条的标题、类型、出处 id、片段与相关度分数，不返回完整原文（片段截断到 240 字左右）。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '检索词或问题。用具体的山头名、茶品名、术语效果最好，例如「倚邦 山场特征」「老班章 价格」。',
            },
            k: {
              type: 'integer',
              description: '希望返回的条数，默认 5，允许 1-10；超出范围会自动夹到边界。',
              minimum: 1,
              maximum: 10,
            },
          },
          required: ['query'],
        },
      },
    },
    async execute(args = {}, ctx = {}) {
      const query = requireText(args, 'query');
      if (!query) return { ok: false, error: '缺少必填参数 query：请给出要检索的问题或关键词（字符串）' };
      const k = clampInt(args.k, 1, 10, 5);
      try {
        const res = searchKnowledge(getKb(ctx), query, { k });
        const hits = res.hits.map((h) => ({
          id: str(h.id),
          title: str(h.title),
          type: str(h.type),
          sourceId: str(h.sourceId),
          snippet: str(h.snippet),
          score: Number(h.score) || 0,
        }));
        const top = hits.slice(0, 2).map((h) => h.title).join('、');
        return {
          ok: true,
          data: { hits },
          summary: hits.length
            ? `在知识库里找到 ${hits.length} 条相关片段，最相关的是：${top}`
            : `知识库里没有与「${query}」相关的片段。可换用更具体的山头名 / 茶品名 / 术语再查一次`,
          meta: { query, k, top1: res.meta?.top1 ?? 0 },
        };
      } catch (err) {
        return { ok: false, error: `检索失败：${err.message}` };
      }
    },
  },

  {
    name: 'check_compliance',
    definition: {
      type: 'function',
      function: {
        name: 'check_compliance',
        description:
          '检查一段直播话术、口播稿或商品文案的合规风险，返回违禁词、风险等级和**可以直接照着替换的说法**。' +
          '当用户问「这句话能不能在直播间说」「这样讲会不会违规」「帮我看看这段文案」，或你自己写好了一段话术需要上播前自检时使用。' +
          '涉及功效、绝对化用语、价格承诺、联系方式的问题一律用它，不要凭常识判断合规性。' +
          '返回：风险等级 clean/low/medium/high、风险分、命中的违禁项（原词 + 类别 + 替换建议 + 说明）、提示项，以及一份已把违禁词替换成建议说法的"可直接照念"版本。' +
          '不给出法律结论，也不修改任何数据。文本超过 5000 字时只检查前 5000 字。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '要检查的直播话术原文（整段粘贴，不要只给关键词）。',
            },
          },
          required: ['text'],
        },
      },
    },
    async execute(args = {}, ctx = {}) {
      const text = requireText(args, 'text');
      if (!text) return { ok: false, error: '缺少必填参数 text：请给出要检查的话术原文（字符串，不能只给违禁词本身）' };
      const clipped = text.length > COMPLIANCE_TEXT_LIMIT;
      const body = clipped ? text.slice(0, COMPLIANCE_TEXT_LIMIT) : text;
      try {
        const compliance = ctx.compliance || loadCompliance();
        const result = checkText(body, { compliance });
        const sum = summarize(result);
        const hits = result.hits.slice(0, 12).map((h) => ({
          word: str(h.word),
          category: str(h.category),
          suggest: str(h.suggest),
          note: str(h.note),
        }));
        const brief = hits
          .slice(0, 3)
          .map((h) => (h.suggest ? `${h.word}→${h.suggest}` : h.word))
          .join('、');
        const levelText = result.level === 'clean' ? 'clean（未发现违禁风险）' : result.level;
        const tail = clipped ? `（原文超过 ${COMPLIANCE_TEXT_LIMIT} 字，只检查了前 ${COMPLIANCE_TEXT_LIMIT} 字）` : '';
        return {
          ok: true,
          data: {
            level: str(result.level),
            score: Number(result.score) || 0,
            hits,
            warnings: sum.warnings,
            cleaned: str(result.cleaned),
          },
          summary: result.total
            ? `风险等级 ${levelText}，命中 ${result.total} 个违禁项${brief ? `：${brief}` : ''}${tail}`
            : `风险等级 ${levelText}，没有命中违禁词${tail}`,
          meta: { textChars: body.length, truncated: clipped, warnTotal: sum.warnTotal, counts: result.counts },
        };
      } catch (err) {
        return { ok: false, error: `合规检查失败：${err.message}` };
      }
    },
  },

  {
    name: 'build_live_deck',
    definition: {
      type: 'function',
      function: {
        name: 'build_live_deck',
        description:
          '按主题生成一份完整的直播方案：段落大纲、分页结构、逐字稿和互动环节计划。' +
          '当用户要求「帮我做一场 XX 的直播方案 / 大纲 / 脚本」「给某个山头排一场 90 分钟的直播」「生成直播流程」时使用。' +
          '参数 topic 必填；durationMin 允许 15-240（默认 60）；purpose 是场次类型 id；mountainName / productName 传入后方案才会带上具体山场与茶品内容。' +
          '★ 本工具**只返回结构与统计**（标题、页数、段落数、逐字稿分钟数与覆盖率、每个段落的标题与时长），**不返回逐字稿正文** —— 正文有上万字，塞进上下文会挤掉后续对话；正文由编排层另存为文件。' +
          '因此**不要为了拿全文反复调用本工具**，需要正文时告诉用户去看已生成的文件。本工具不写盘、不修改任何已有数据。',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '直播主题，例如「倚邦古树春茶专场」。' },
            durationMin: {
              type: 'integer',
              description: '场次时长（分钟），允许 15-240，默认 60；超出范围会自动夹到边界。',
              minimum: 15,
              maximum: 240,
            },
            purpose: {
              type: 'string',
              description: '场次类型 id，可选：newlaunch（新品首发）、promo（大促逼单）、knowledge（知识科普）、thanks（老客答谢）、mixed（常规带货，默认）。',
            },
            mountainName: { type: 'string', description: '主推山头名，如「倚邦」；给了它方案才会生成山场相关内容。' },
            productName: { type: 'string', description: '主推产品名，如「倚邦古树 2026 春 357g」。' },
          },
          required: ['topic'],
        },
      },
    },
    async execute(args = {}) {
      const topic = requireText(args, 'topic');
      if (!topic) return { ok: false, error: '缺少必填参数 topic：请给出直播主题（字符串）' };

      let options;
      try {
        options = listOptions();
      } catch (err) {
        return { ok: false, error: `读取生成选项失败：${err.message}` };
      }

      const purposeIds = (options.purposes || []).map((p) => str(p.id)).filter(Boolean);
      const rawPurpose = str(args.purpose).trim();
      const purpose = rawPurpose || 'mixed';
      // 枚举值写错时给回可选列表：模型能自己改对，比默默回落到默认类型更透明
      if (!purposeIds.includes(purpose)) {
        return { ok: false, error: `不支持的 purpose「${purpose}」，只能是：${purposeIds.join(' / ')}` };
      }

      const durationMin = clampInt(args.durationMin, 15, 240, 60);
      const mountainName = str(args.mountainName).trim();
      const productName = str(args.productName).trim();

      try {
        // buildDeck 是纯函数（只读知识库/合规库，不写盘）—— 落盘由 loop 层负责
        const deck = buildDeck({ topic, durationMin, purpose, mountainName, productName });
        const stats = deck.meta.stats || {};
        const sections = (deck.sections || []).slice(0, 40).map((s) => ({
          title: str(s.title),
          minutes: Number(s.minutes) || 0,
        }));
        return {
          ok: true,
          data: {
            title: str(deck.meta.title),
            durationMin: Number(deck.meta.durationMin) || durationMin,
            slideCount: Number(stats.slideCount) || 0,
            scriptMinutes: Number(stats.scriptMinutes) || 0,
            verbatimCoverage: Number(stats.verbatimCoverage) || 0,
            sections,
          },
          summary: `生成《${str(deck.meta.title)}》，${Number(stats.slideCount) || 0} 页 / ${(deck.sections || []).length} 个段落，逐字稿覆盖 ${Number(stats.verbatimCoverage) || 0}%（约 ${Number(stats.scriptMinutes) || 0} 分钟）`,
          meta: {
            purpose,
            purposeLabel: str(deck.meta.purposeLabel),
            sectionCount: (deck.sections || []).length,
            scriptChars: Number(stats.scriptChars) || 0,
            interactionCount: Number(stats.interactionCount) || 0,
            hasMountain: !!deck.meta.hasMountain,
          },
          // 上万字的正文只在这里声明、由编排层落盘；它不会进模型上下文（见 loop 的 renderToolResult）
          persist: { filename: `${str(deck.id)}.json`, data: deck },
        };
      } catch (err) {
        return { ok: false, error: `生成直播方案失败：${err.message}` };
      }
    },
  },

  {
    name: 'list_mountains',
    definition: {
      type: 'function',
      function: {
        name: 'list_mountains',
        description:
          '列出知识库里收录的山头清单，可按名称/别名关键词过滤。' +
          '当用户问「你们库里有哪些山头」「有没有冰岛」「勐海片区收了哪些寨子」，或你需要先确认某个山头名在不在库里、该用哪个 id / 正确写法去检索时使用。' +
          '只返回清单（id、名称、产区、别名），最多 20 条，**不返回山场特征、海拔、价格、冲泡方式等详细内容** —— 那些必须用 search_knowledge 查。',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '可选过滤词，按山头名称或别名做包含匹配，例如「冰岛」「勐海」；不传则返回全部山头。',
            },
          },
          required: [],
        },
      },
    },
    async execute(args = {}, ctx = {}) {
      const keyword = str(args.keyword).trim();
      let kb;
      try {
        kb = getKb(ctx);
      } catch (err) {
        return { ok: false, error: `读取知识库失败：${err.message}` };
      }
      const all = Array.isArray(kb?.mountains) ? kb.mountains : [];
      const q = normText(keyword);
      const matched = q
        ? all.filter((m) => [m.name, ...(Array.isArray(m.alias) ? m.alias : [])].some((n) => normText(n).includes(q)))
        : all;
      const items = matched.slice(0, LIST_LIMIT).map((m) => ({
        id: str(m.id),
        name: str(m.name),
        region: str(m.region),
        alias: Array.isArray(m.alias) ? m.alias.map(str) : [],
      }));
      const names = items.slice(0, 5).map((i) => i.name).join('、');
      return {
        ok: true,
        data: { total: matched.length, items },
        summary: keyword
          ? `含「${keyword}」的山头共 ${matched.length} 个${names ? `：${names}` : ''}（最多显示 ${LIST_LIMIT} 条）`
          : `知识库共 ${matched.length} 个山头${names ? `，例如：${names}` : ''}（最多显示 ${LIST_LIMIT} 条）`,
        meta: { keyword, returned: items.length },
      };
    },
  },

  {
    name: 'get_live_sessions',
    definition: {
      type: 'function',
      function: {
        name: 'get_live_sessions',
        description:
          '列出历史直播场次记录。当用户问「我上一场播了什么」「最近几场直播的情况」「有没有历史场次记录」，或你需要引用/核对历史场次时使用。' +
          '只返回场次清单（id、标题、日期），按日期从新到旧排列，最多 10 条；' +
          '**不返回**场次内的人数、GMV、转化率等指标，也不做复盘分析 —— 需要复盘结论时请说明本工具不提供，让用户去看复盘页面。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async execute() {
      let list;
      try {
        list = listSessions();
      } catch (err) {
        return { ok: false, error: `读取历史场次失败：${err.message}` };
      }
      const all = Array.isArray(list) ? list : [];
      // 倒序：模型问"最近一场"时，顺序是它唯一能依赖的信号
      const sorted = [...all].sort((a, b) =>
        str(b?.date || b?.createdAt).localeCompare(str(a?.date || a?.createdAt))
      );
      const items = sorted.slice(0, SESSION_LIMIT).map((s) => ({
        id: str(s.id),
        title: str(s.title),
        date: str(s.date || s.createdAt),
      }));
      const latest = items[0];
      return {
        ok: true,
        data: { total: all.length, items },
        summary: all.length
          ? `共 ${all.length} 场历史直播${latest ? `，最近一场是 ${latest.date}《${latest.title}》` : ''}（最多显示 ${SESSION_LIMIT} 条）`
          : '还没有历史直播场次记录',
        meta: { returned: items.length },
      };
    },
  },
];

/**
 * 只读工具 + 写操作工具合并。
 *
 * 写工具单独放 `tools-write.mjs`，因为它们的设计约束和读工具**完全不同**：
 * 读工具"参数错就返回空"，写工具"参数错会永久写坏数据"，所以那边全是严格校验和影响预览。
 * 混在一个文件里会让两种纪律互相稀释。
 *
 * 合并后注册表对循环层是透明的 —— 循环层只关心 `tool.permission`，
 * 不需要知道工具在哪定义。
 */
const ALL_TOOLS = [...TOOLS, ...WRITE_TOOLS];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));
const BY_LOWER = new Map(ALL_TOOLS.map((t) => [t.name.toLowerCase(), t]));

/**
 * 全部工具的元数据（不含执行函数）。喂给模型的就是这个数组。
 *
 * 注意**只喂 definition**：`permission` 和 `execute` 不能进模型上下文 ——
 * 模型看到 "permission: write" 没有意义（权限由代码判，不由模型判），
 * 还会浪费 token。
 *
 * @returns {Array<{type:'function', function:{name:string, description:string, parameters:object}}>}
 */
export function listToolDefs() {
  return ALL_TOOLS.map((t) => t.definition);
}

/**
 * 工具元信息（含权限级别），给**界面**用，不给模型用。
 * 前端据此把工具分成「读」和「写」，让用户一眼看出哪些操作会改数据。
 */
export function listToolMeta() {
  return ALL_TOOLS.map((t) => ({
    name: t.name,
    permission: t.permission || 'read',
    description: t.definition?.function?.description || '',
  }));
}

/**
 * 按名字取工具。
 *
 * 不存在时返回 null 而**不抛错**：模型幻觉出一个函数名是常态，
 * 循环层需要把"没有这个工具 + 可用工具列表"喂回去让它自己纠正。
 * 顺带容忍大小写差异（模型偶尔会把 search_knowledge 写成 Search_Knowledge）。
 *
 * @param {string} name
 * @returns {{name:string, definition:object, execute:Function}|null}
 */
export function getTool(name) {
  const key = str(name).trim();
  if (!key) return null;
  return BY_NAME.get(key) || BY_LOWER.get(key.toLowerCase()) || null;
}
