/**
 * 从素材库文件夹（一堆 .md）导入知识库。
 *
 * 语义：**文件夹是内容源头**。文件里有的对象就新增/更新，文件里没有的就删掉 ——
 * 否则「删了一个文件」不会生效，人会以为删成功但其实还在。这是破坏性操作，所以：
 *
 *   1. 永远先备份当前 knowledge.json（`data/backups/`）
 *   2. 支持 dryRun 先给差异清单（新增/更新/删除各几个、分别是哪些）
 *   3. 界面必须先展示差异、二次确认才落盘
 *
 * 知识库里的 regions / tags / disclaimer / version 不由文件管理，导入时原样保留。
 */
import fs from 'node:fs';
import path from 'node:path';

import { dataDir, backupsDir, ROOT } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { parseKbFile, idFromName } from './kb-format.mjs';

/**
 * 素材库默认位置 —— **故意留空**。
 *
 * 真实路径放在 `data/settings.json` 的 `kbDir` 字段（数据不进仓库），
 * 或用环境变量 `KB_DIR` 指定。在代码里写死本机路径，会让别人 clone 之后
 * 拿到一个指向不存在目录的默认值。
 */
export const DEFAULT_KB_DIR = '';

/** 素材库位置：设置里可改，其次环境变量，最后默认 */
export function kbDir() {
  const settings = readJson('settings.json', {}) || {};
  return settings.kbDir || process.env.KB_DIR || DEFAULT_KB_DIR;
}

const GROUPS = [
  { type: 'mountain', sub: '山头', key: 'mountains' },
  { type: 'product', sub: '茶品', key: 'products' },
  // 专题：品鉴轮 / 前中后段 / 转化方向 / 价格体系这类通用知识，
  // 既不属于某个山头，也不属于某个品类，单独一组。
  { type: 'topic', sub: '专题', key: 'topics' },
];

/**
 * 读一个子目录里的所有 .md。
 *
 * id 的规则：**先按名字匹配已有对象复用它的 id**，匹配不上才由名字派生。
 * 为什么不直接由文件名派生 id：那样每次导入都会换一批 id，
 * 往返比对会变成「全部删除 + 全部新增」，而且任何引用了 id 的地方都会断。
 */
function readGroup(dir, g, oldList = []) {
  const out = { items: [], warnings: [], files: 0 };
  const sub = path.join(dir, g.sub);
  if (!fs.existsSync(sub)) return out;
  const oldByName = new Map(oldList.map((x) => [String(x.name || '').trim(), x]));

  for (const f of fs.readdirSync(sub)) {
    if (!/\.md$/i.test(f)) continue;
    if (f.startsWith('_') || f.startsWith('.')) continue; // 下划线开头=草稿，跳过
    out.files++;
    const full = path.join(sub, f);
    const fallback = f.replace(/\.md$/i, '');
    const { data, warnings } = parseKbFile(g.type, fs.readFileSync(full, 'utf8'), fallback);
    for (const w of warnings) out.warnings.push(`${g.sub}/${f}：${w}`);
    // 文件里显式写了 id: 就用它的（高级用法）；否则复用同名旧对象；再否则派生
    const explicit = String(data.id || '').trim();
    const old = oldByName.get(String(data.name || '').trim());
    data.id = explicit || (old && old.id) || idFromName(data.name);
    out.items.push(data);
  }
  return out;
}

/** 当前状态：素材库在哪、里面有多少、能不能导入 */
export function kbFileStatus() {
  const dir = kbDir();
  if (!fs.existsSync(dir)) {
    return { ok: false, dir, message: `素材库目录不存在：${dir}` };
  }
  const cur = readJson('knowledge.json', {}) || {};
  const out = { ok: true, dir };
  for (const g of GROUPS) {
    const r = readGroup(dir, g, cur[g.key] || []);
    out[g.key] = { files: r.files, items: r.items.length };
  }
  return out;
}

/**
 * 比对前先把对象规范化：丢掉空值、空数组，键排序。
 *
 * 为什么：导出时会跳过空字段，回读后那个键就不存在了（`undefined` vs `""`）。
 * 如果按「键存在性 + 原样 JSON」比，82 条会全部报「有变化」——
 * 真正的改动就被噪声淹没了，用户在确认框里看不出自己到底改了什么。
 */
function normalizeForCompare(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const arr = v.map((x) => String(x).trim()).filter(Boolean);
      if (arr.length) out[k] = arr;
      continue;
    }
    const s = String(v).trim();
    if (s !== '') out[k] = s;
  }
  return out;
}

const sameObject = (a, b) =>
  JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));

/**
 * 解析素材库并和现有知识库比对，返回差异（不落盘）。
 */
export function previewKbImport() {
  const dir = kbDir();
  if (!fs.existsSync(dir)) return { ok: false, message: `素材库目录不存在：${dir}` };

  const cur = readJson('knowledge.json', null);
  if (!cur) return { ok: false, message: '当前知识库读取失败' };

  const result = { ok: true, dir, warnings: [], groups: {} };
  const next = { ...cur };

  for (const g of GROUPS) {
    const r = readGroup(dir, g, cur[g.key] || []);
    const oldList = cur[g.key] || [];
    const oldById = new Map(oldList.map((x) => [x.id, x]));
    const newById = new Map(r.items.map((x) => [x.id, x]));

    const added = r.items.filter((x) => !oldById.has(x.id)).map((x) => x.name);
    const updated = r.items
      .filter((x) => oldById.has(x.id) && !sameObject(oldById.get(x.id), x))
      .map((x) => x.name);
    const removed = oldList.filter((x) => !newById.has(x.id)).map((x) => x.name);

    result.groups[g.key] = {
      files: r.files,
      total: r.items.length,
      added,
      updated,
      removed,
      // 详细的字段级改动，界面用来告诉用户「到底改了什么」
      changes: r.items
        .filter((x) => oldById.has(x.id) && !sameObject(oldById.get(x.id), x))
        .map((x) => {
          const old = normalizeForCompare(oldById.get(x.id));
          const nu = normalizeForCompare(x);
          const fields = [];
          for (const k of new Set([...Object.keys(old), ...Object.keys(nu)])) {
            if (JSON.stringify(old[k]) !== JSON.stringify(nu[k])) fields.push(k);
          }
          return { name: x.name, fields };
        }),
    };
    result.warnings.push(...r.warnings);
    next[g.key] = r.items;
  }

  result.next = next;
  return result;
}

/** 真正落盘：先备份，再写 */
export function applyKbImport() {
  const pre = previewKbImport();
  if (!pre.ok) return pre;

  const backupDir = backupsDir();
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(backupDir, `knowledge-${stamp}.json`);
  try {
    fs.copyFileSync(path.join(dataDir(), 'knowledge.json'), backup);
  } catch (e) {
    return { ok: false, message: `备份失败，已中止导入：${e.message}` };
  }

  const next = { ...pre.next };
  next.version = (pre.next.version || 1) + 0; // 版本号保持，改动由 updatedAt 体现
  next.updatedAt = new Date().toISOString();
  writeJson('knowledge.json', next);

  return {
    ok: true,
    dir: pre.dir,
    backup: path.relative(ROOT, backup),
    added: Object.values(pre.groups).reduce((a, g) => a + g.added.length, 0),
    updated: Object.values(pre.groups).reduce((a, g) => a + g.updated.length, 0),
    removed: Object.values(pre.groups).reduce((a, g) => a + g.removed.length, 0),
    groups: pre.groups,
    warnings: pre.warnings,
  };
}

export { idFromName };
