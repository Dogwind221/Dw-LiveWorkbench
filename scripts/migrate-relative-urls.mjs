/**
 * 一次性改造：把前端的绝对 URL 改成相对 URL。
 *
 * 为什么必须改：工作台现在既能独立跑（挂在 `/`），也能作为 DSH 插件挂在
 * `/live-workbench/`。绝对路径 `/api/...` 在子路径下会打到站点根，取不到接口。
 *
 * 用 Node 写文件（UTF-8 安全），不要用 PowerShell 改文本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'web');

const EDITS = [
  {
    file: 'app.js',
    // '/api/... -> 'api/...   `"/files/... -> `"files/...
    pairs: [
      [/(['"`])\/(api|files)\//g, '$1$2/'],
      [/\(\s*'\/api\//g, "('api/"],
      [/\(\s*`\/api\//g, '(`api/'],
    ],
  },
  {
    file: 'index.html',
    pairs: [[/(["'])\/(styles\.css|app\.js|slides\.js)/g, '$1$2']],
  },
];

let changed = 0;
for (const edit of EDITS) {
  const file = path.join(WEB, edit.file);
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of edit.pairs) after = after.replace(re, to);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    changed++;
    console.log(`已改写 ${edit.file}`);
  } else {
    console.log(`无变化 ${edit.file}`);
  }
}

// 复查：不应再残留以斜杠开头的接口/资源引用
const leftovers = [];
for (const name of ['app.js', 'index.html', 'slides.js', 'styles.css']) {
  const file = path.join(WEB, name);
  if (!fs.existsSync(file)) continue;
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/['"`]\/(api|files|styles\.css|app\.js|slides\.js)/.test(line)) leftovers.push(`${name}:${i + 1}  ${line.trim()}`);
    });
}
console.log(leftovers.length ? `\n仍有绝对引用：\n${leftovers.join('\n')}` : '\n复查通过：前端已无绝对 URL 引用');
console.log(`改写了 ${changed} 个文件`);
