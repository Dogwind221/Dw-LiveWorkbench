/**
 * 把工作台的知识库导出成**可编辑的 .md 文件**，方便人直接改。
 *
 * 顺带是导入器的对照物：导出 → 导入，数据必须一致（scripts/kb-import-check 会验）。
 *
 * 用法：
 *   node scripts/kb-export.mjs                     # 导出到默认素材库
 *   node scripts/kb-export.mjs "D:\某个目录"        # 导出到指定目录
 *   KB_DIR=... node scripts/kb-export.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderKbFile } from '../server/lib/kb-format.mjs';
import { dataDir } from '../server/lib/paths.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 多租户后知识库在 data/tenants/<id>/ 下；脚本不带上下文 → default 租户
const KB_JSON = path.join(dataDir(), 'knowledge.json');

export const DEFAULT_KB_DIR = process.env.KB_DIR || '';

const kb = JSON.parse(fs.readFileSync(KB_JSON, 'utf8').replace(/^\uFEFF/, ''));
const outDir = process.argv[2] || DEFAULT_KB_DIR;
if (!outDir) {
  console.error('请指定输出目录：node scripts/kb-export.mjs <目录>，或设置环境变量 KB_DIR');
  process.exit(1);
}

const groups = [
  { type: 'mountain', items: kb.mountains || [], sub: '山头' },
  { type: 'product', items: kb.products || [], sub: '茶品' },
];

let written = 0;
for (const g of groups) {
  const dir = path.join(outDir, g.sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of g.items) {
    const name = String(item.name || item.id || '未命名').replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(dir, `${name}.md`), renderKbFile(g.type, item), 'utf8');
    written++;
  }
  console.log(`  ${g.sub}/  ${g.items.length} 个文件`);
}

console.log(`\n导出完成：${written} 个 .md → ${outDir}`);
console.log('直接编辑这些文件即可；工作台的「从素材库导入」会把它们读回去。');
