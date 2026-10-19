/**
 * 模块 1：每日情报采集。
 *
 * 设计取舍：情报源抓取可能因为网络/反爬失败，所以永远保留「手动粘贴」通道，
 * 抓取失败只是降级，不能让整个模块不可用。
 */
import { makeCollection, newId, readJson, writeJson } from './store.mjs';
import { loadKB } from './kb.mjs';

const intel = makeCollection('intel.json');

export function listIntel() {
  return intel.all();
}

export function intelStats() {
  const items = intel.all();
  const byTag = {};
  for (const it of items) for (const t of it.tags || []) byTag[t] = (byTag[t] || 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  return {
    total: items.length,
    today: items.filter((i) => (i.createdAt || '').slice(0, 10) === today).length,
    unread: items.filter((i) => !i.used).length,
    byTag,
  };
}

/** 自动打标签：命中知识库山头/茶品名 + 行业关键词。 */
export function autoTag(text) {
  const kb = loadKB();
  const tags = new Set();
  const t = String(text || '');
  for (const m of kb.mountains || []) {
    const names = [m.name, ...(m.alias || [])];
    if (names.some((n) => n && t.includes(n))) tags.add('山头');
  }
  for (const p of kb.products || []) {
    if (p.name && t.includes(p.name)) tags.add('茶品知识');
  }
  const RULES = [
    [/价格|涨价|跌价|行情|报价|元\/kg|收购价/, '行情价格'],
    [/新茶|春茶|秋茶|头春|采摘|上市/, '季节新茶'],
    [/直播|带货|短视频|抖音|快手|视频号|小红书/, '平台动态'],
    [/政策|法规|标准|监管|抽检|处罚|广告法/, '政策法规'],
    [/品牌|新品|发布|联名|融资/, '品牌动态'],
    [/古树|树龄|山头|茶山|产区|生态/, '产地生态'],
    [/出口|进口|关税|海外/, '外贸'],
    [/囤茶|收藏|陈化|仓储/, '仓储收藏'],
  ];
  for (const [re, tag] of RULES) if (re.test(t)) tags.add(tag);
  if (!tags.size) tags.add('待归类');
  return [...tags];
}

export function addIntel(input) {
  const items = Array.isArray(input) ? input : [input];
  const added = [];
  for (const raw of items) {
    const text = [raw.title, raw.summary, raw.note].filter(Boolean).join(' ');
    if (!text.trim()) continue;
    // 简单去重：同标题或同链接不重复入库
    const exists = intel.all().find((x) => (raw.url && x.url === raw.url) || (raw.title && x.title === raw.title));
    if (exists) continue;
    const item = intel.upsert({
      id: newId('intel'),
      title: (raw.title || text.slice(0, 40)).trim(),
      url: raw.url || '',
      source: raw.source || '手动录入',
      summary: (raw.summary || '').trim(),
      note: (raw.note || '').trim(),
      tags: raw.tags?.length ? raw.tags : autoTag(text),
      used: false,
      publishedAt: raw.publishedAt || '',
    });
    added.push(item);
  }
  return added;
}

export function updateIntel(id, patch) {
  return intel.upsert({ id, ...patch });
}

export function removeIntel(id) {
  return intel.remove(id);
}

/* --------------------------- 情报源 --------------------------- */

const DEFAULT_SOURCES = [
  { id: 'src_puertea', name: '普洱茶相关资讯（示例源，可自行替换）', url: '', enabled: false, type: 'rss' },
];

export function listSources() {
  const s = readJson('sources.json', null);
  if (!s) {
    writeJson('sources.json', DEFAULT_SOURCES);
    return DEFAULT_SOURCES;
  }
  return s;
}

export function upsertSource(src) {
  const list = listSources();
  const idx = list.findIndex((x) => x.id === src.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...src };
  else list.push({ id: newId('src'), enabled: true, type: 'rss', ...src });
  writeJson('sources.json', list);
  return list;
}

export function removeSource(id) {
  writeJson('sources.json', listSources().filter((x) => x.id !== id));
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

/** 极简 RSS / Atom 解析：只取标题、链接、摘要、时间，避免引入依赖。 */
export function parseFeed(xml) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    out.push({
      title: tag(b, 'title'),
      url: link,
      summary: tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'),
      publishedAt: tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published'),
    });
  }
  return out.filter((x) => x.title);
}

export async function fetchSource(source, opts = {}) {
  if (!source?.url) return { source: source?.name, ok: false, error: '未配置 URL', added: 0 };
  const timeout = opts.timeout ?? 12000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PuerLiveWorkbench/0.1)' },
    });
    if (!res.ok) return { source: source.name, ok: false, error: `HTTP ${res.status}`, added: 0 };
    const xml = await res.text();
    const entries = parseFeed(xml).slice(0, opts.limit ?? 20);
    const added = addIntel(
      entries.map((e) => ({ ...e, source: source.name, tags: source.tags }))
    );
    return { source: source.name, ok: true, found: entries.length, added: added.length };
  } catch (err) {
    const msg = err.name === 'AbortError' ? `超时（${timeout}ms）` : err.message;
    return { source: source.name, ok: false, error: msg, added: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAll(opts = {}) {
  const sources = listSources().filter((s) => s.enabled && s.url);
  if (!sources.length) {
    return { ok: false, message: '没有启用中的情报源。可以在「情报源」里添加 RSS 地址，或直接手动粘贴。', results: [] };
  }
  const results = [];
  for (const s of sources) results.push(await fetchSource(s, opts));
  return { ok: results.some((r) => r.ok), results };
}

/* --------------------------- 情报 → 选题 --------------------------- */

const TOPIC_TEMPLATES = [
  { tag: '行情价格', tpl: '价格波动解读：{kw}这波行情，直播间怎么讲才不吃亏', why: '行情类内容停留高，且能自然带到选品逻辑' },
  { tag: '季节新茶', tpl: '新茶上市拆解：{kw}今年的品质到底怎么样', why: '应季选题，搜索与推荐流量都高' },
  { tag: '产地生态', tpl: '产地视角：{kw}的山场与树龄，一次讲清楚', why: '知识型内容利于建立专业人设' },
  { tag: '政策法规', tpl: '合规提醒：{kw}之后，直播间这些话不能说了', why: '结合模块5做合规内容，稀缺且有价值' },
  { tag: '平台动态', tpl: '平台规则变化：{kw}对茶叶直播间的影响', why: '运营类内容，老客与同行都爱看' },
  { tag: '仓储收藏', tpl: '存茶实操：{kw}背后的仓储逻辑', why: '老茶客关注度高，客单价也高' },
  { tag: '品牌动态', tpl: '品牌动向：{kw}，对我们买茶意味着什么', why: '选题轻、有话题度，适合开场' },
  { tag: '茶品知识', tpl: '常识补课：{kw}，新手最容易搞错的点', why: '科普内容涨粉稳定' },
  { tag: '待归类', tpl: '延伸话题：{kw}，跟今晚这饼茶的关系', why: '把零散情报接回产品' },
];

/** 把情报条目转成可执行的直播选题。 */
export function suggestTopics(limit = 8) {
  const items = intel.all().filter((i) => !i.used);
  const pool = items.length ? items : intel.all();
  const topics = [];
  for (const item of pool) {
    const tags = item.tags?.length ? item.tags : ['待归类'];
    const tpl = TOPIC_TEMPLATES.find((t) => tags.includes(t.tag)) || TOPIC_TEMPLATES[TOPIC_TEMPLATES.length - 1];
    const kw = (item.title || item.summary || '').slice(0, 24);
    if (!kw) continue;
    topics.push({
      intelId: item.id,
      title: tpl.tpl.replace(/\{kw\}/g, kw),
      why: tpl.why,
      tag: tags[0],
      source: item.source,
      url: item.url,
    });
    if (topics.length >= limit) break;
  }
  return topics;
}
