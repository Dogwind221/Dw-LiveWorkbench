import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir } from './paths.mjs';

/**
 * 极简文件存储：所有状态落成可读的 JSON，方便用户直接查看/备份/手改。
 * 写入使用 临时文件 + rename，避免写到一半崩溃导致文件损坏。
 *
 * **多租户关键点**：`filePath()` 是全部读写的**唯一收口**，
 * 所有模块（kb / compliance / intel / qa / ppt / handler…）都经过它。
 * 所以这里按当前租户解析路径，等于一次性把 7 个模块变成租户隔离的，
 * 不需要在每个模块里各写一遍租户逻辑。
 */
export function filePath(name) {
  return path.isAbsolute(name) ? name : path.join(dataDir(), name);
}

export function readJson(name, fallback = null) {
  const p = filePath(name);
  try {
    if (!fs.existsSync(p)) return fallback;
    // 去掉 UTF-8 BOM：记事本 / PowerShell 保存的 JSON 常带 BOM，
    // JSON.parse 会直接抛错，然后这里静默返回 fallback —— 表现为「知识库突然空了」。
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] 读取 ${name} 失败：${err.message}`);
    return fallback;
  }
}

export function writeJson(name, value) {
  const p = filePath(name);
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/** 基于数组的集合操作，所有集合都带 id + createdAt。 */
export function makeCollection(name) {
  return {
    name,
    all() {
      const v = readJson(name, []);
      return Array.isArray(v) ? v : [];
    },
    save(items) {
      writeJson(name, items);
      return items;
    },
    get(id) {
      return this.all().find((x) => x.id === id) || null;
    },
    upsert(item) {
      const items = this.all();
      const idx = items.findIndex((x) => x.id === item.id);
      const now = new Date().toISOString();
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...item, updatedAt: now };
      } else {
        items.unshift({ createdAt: now, updatedAt: now, ...item });
      }
      this.save(items);
      return items.find((x) => x.id === item.id);
    },
    remove(id) {
      const items = this.all();
      const next = items.filter((x) => x.id !== id);
      if (next.length === items.length) return false;
      this.save(next);
      return true;
    },
  };
}

export function newId(prefix = 'id') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}`;
}
