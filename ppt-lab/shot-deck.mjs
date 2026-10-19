/**
 * 通用 deck 截图：给一个 HTML，截出第 1 页和第 2 页各一张 1920×1080。
 *
 * 两个必须处理的现实问题：
 *
 * 1. **翻页方式各不相同**。三个设计方向来自不同的模板，翻页键有可能是
 *    ←/→、空格、PageDown、点击半屏…… 所以不假设翻页方式，而是逐个试并比对
 *    截图哈希，直到画面真的变了为止 —— 避免把第 1 页截两次当成两页交付。
 *
 * 2. **入场动效有长有短**。归藏模板的 hero 动效约 1 秒，但瑞士风的 timeline
 *    是逐节点序列动画，要好几秒。固定等待会在动画中间态截图（实测截到过
 *    「03 很淡、04 还没出现」的半截页面）。所以这里**轮询到画面稳定**再截。
 *
 * 用法：node ppt-lab/shot-deck.mjs <html路径> <输出前缀>
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * playwright 装在全局 npm 目录下，ESM 默认解析不到工作区的裸导入。
 * 这里按「本地优先 → 全局兜底」逐个试，避免为了截图在工作区装一份重依赖。
 */
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    'C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return await import(c.startsWith('C:') ? pathToFileURL(c).href : c);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 playwright（可用 PLAYWRIGHT_MODULE 环境变量指定路径）');
}

// playwright 是 CJS，动态 import 后具名导出挂在 .default 上，两种都兜住
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;
if (!chromium) throw new Error('playwright 加载成功但拿不到 chromium 导出');

const [htmlPath, prefix] = process.argv.slice(2);
if (!htmlPath || !prefix) {
  console.error('用法: node shot-deck.mjs <html路径> <输出前缀>');
  process.exit(2);
}
if (!existsSync(htmlPath)) {
  console.error('文件不存在:', htmlPath);
  process.exit(2);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160));
});

await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });

/**
 * 轮询截图直到画面稳定（连续两次一致），最长 maxMs。
 * 返回稳定后的截图 Buffer。
 */
async function settle(label, { quietMs = 600, maxMs = 9000 } = {}) {
  const t0 = Date.now();
  let prev = await page.screenshot();
  let stableFor = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(quietMs);
    const cur = await page.screenshot();
    if (Buffer.compare(cur, prev) === 0) {
      stableFor += quietMs;
      if (stableFor >= quietMs) return { buf: cur, waitedMs: Date.now() - t0, settled: true, label };
    } else {
      stableFor = 0;
    }
    prev = cur;
  }
  return { buf: prev, waitedMs: Date.now() - t0, settled: false, label };
}

const first = await settle('p1');
const shot1 = first.buf;
const h1 = sha(shot1);
await page.screenshot({ path: `${prefix}-p1.png` });

/* 依次尝试各种翻页手段，直到画面变化 */
const attempts = [
  ['ArrowRight', () => page.keyboard.press('ArrowRight')],
  ['Space', () => page.keyboard.press('Space')],
  ['PageDown', () => page.keyboard.press('PageDown')],
  ['ArrowDown', () => page.keyboard.press('ArrowDown')],
  ['d', () => page.keyboard.press('d')],
  ['n', () => page.keyboard.press('n')],
  ['click-right-half', () => page.mouse.click(1600, 540)],
  ['click-next-btn', async () => {
    const btn = page.locator('[data-next], .nav-next, #next, .next, [aria-label*="下一"]').first();
    if (await btn.count()) await btn.click({ timeout: 1500 });
    else throw new Error('no next button');
  }],
];

let advancedBy = null;
let second = null;
for (const [label, act] of attempts) {
  try {
    await act();
  } catch {
    continue;
  }
  const res = await settle('p2', { quietMs: 700, maxMs: 9000 });
  if (sha(res.buf) !== h1) {
    advancedBy = label;
    second = res;
    break;
  }
}

if (second) {
  await page.screenshot({ path: `${prefix}-p2.png` });
}

await browser.close();

console.log(JSON.stringify({
  html: path.resolve(htmlPath),
  p1: `${prefix}-p1.png`,
  p2: second ? `${prefix}-p2.png` : null,
  advancedBy,
  distinctPages: !!second,
  hashP1: h1,
  hashP2: second ? sha(second.buf) : null,
  // 动画是否真的稳定了：false 说明到超时还在变，截图可能是动画中间态
  settled: { p1: first.settled, p2: second ? second.settled : null },
  waitedMs: { p1: first.waitedMs, p2: second ? second.waitedMs : null },
  pageErrors: errors.slice(0, 6),
}, null, 2));

if (!second) {
  console.error('⚠️ 翻页没成功：第 2 张和第 1 张是同一画面，需要人工确认翻页实现');
  process.exitCode = 1;
}
