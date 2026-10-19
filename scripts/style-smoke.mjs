/**
 * 视觉风格验收：把**真实引擎产出的方案**用每种风格渲染出来，逐页做结构与像素检查。
 *
 * 为什么单独立一个脚本：三个风格由不同人写，最怕「结构看着对、实际有页是白的」
 * 或者「某个风格偷偷把字号压到不可读」。这两类问题**只看代码看不出来**，必须渲染 + 看像素。
 *
 * 为什么用**两个场次**：没有任何单一 purpose 能产出全部 13 种版式 ——
 * newlaunch 缺 compare，knowledge 缺 price/product，两者并集才覆盖全部。
 * 只跑一个场次会留下覆盖盲区（实测踩过：compare 页一直没被验收过）。
 *
 * 检查项：
 *   1. present 模式：能打开、页数对得上、零外链、无 JS 报错
 *   2. flat 模式：所有页同时可见 → 逐页 element 截图 → 像素级墨迹检查（抓空白页）
 *   3. 全页文本量测：字号下限、对比度、越界、emoji、页内页码（外壳 chrome 不计入）
 *
 * 用法：
 *   node scripts/style-smoke.mjs              # 全部风格 × 全部场次
 *   node scripts/style-smoke.mjs magazine     # 只测某个风格
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildDeck } from '../server/lib/deck/build.mjs';
import { renderStyledDeck, DECK_STYLES } from '../server/lib/deck/html/index.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'output', 'html');
const SHOT_DIR = path.join(OUT, '_checkshots');
// 不写死用户名：优先环境变量，其次从 homedir 推导（Windows / macOS / Linux 都能用）
const PY =
  process.env.PYTHON ||
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
const INK = path.join(ROOT, 'ppt-lab', 'ink-check.py');

const only = process.argv[2];

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${!cond && extra ? ' → ' + extra : ''}`);
};

const COMMON = {
  host: '阿茶',
  brand: '山外山茶事',
  durationMin: 60,
  audience: 'veteran',
  products: [
    { name: '老班章古树春茶', mountainName: '老班章', type: '生普', spec: '357g/饼', price: 2680, comparePrice: 3280, gift: '茶样2泡' },
    { name: '冰岛老寨春茶', mountainName: '冰岛', type: '生普', spec: '200g/饼', price: 1980 },
  ],
};

/* 两个场次并集覆盖全部 13 种版式 */
const DECKS = [
  { label: 'newlaunch（12 版式，缺 compare）', deck: buildDeck({ ...COMMON, topic: '风格煤烟测试 A', purpose: 'newlaunch' }) },
  { label: 'knowledge（补 compare）', deck: buildDeck({ ...COMMON, topic: '风格煤烟测试 B', purpose: 'knowledge' }) },
];

const ALL_TYPES = ['cover', 'hook', 'points', 'cards', 'table', 'compare', 'steps', 'faq', 'price', 'product', 'tasting', 'cta', 'end'];
const covered = new Set(DECKS.flatMap((d) => d.deck.slides.map((s) => s.type)));

console.log(`\n=== 视觉风格验收 ===`);
console.log(`场次：${DECKS.map((d) => d.deck.slides.length + ' 页').join(' + ')}`);
console.log(`覆盖版式 ${covered.size}/13：${ALL_TYPES.filter((t) => covered.has(t)).join(', ')}`);

async function loadPlaywright() {
  for (const c of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright', 'index.js'),
  ].filter(Boolean)) {
    try {
      return await import(c.startsWith('C:') ? pathToFileURL(c).href : c);
    } catch {}
  }
  throw new Error('找不到 playwright');
}

const styles = DECK_STYLES.filter((s) => s.ready && (!only || s.id === only));
if (!styles.length) {
  console.log(only ? `没有就绪的风格匹配 "${only}"` : '没有任何就绪的风格');
  process.exit(1);
}

const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;
const browser = await chromium.launch();
fs.mkdirSync(SHOT_DIR, { recursive: true });

const allShots = [];

for (const style of styles) {
  console.log(`\n── ${style.label}（${style.id}）`);
  const pageErrors = [];

  for (const { label: deckLabel, deck } of DECKS) {
    const tag = `${style.id}/${deckLabel.split('（')[0]}`;
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 170)));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 170));
    });

    /* ---- present ---- */
    const present = renderStyledDeck(deck, { style: style.id, mode: 'present' });
    const presentPath = path.join(OUT, `${style.id}-${deckLabel.split('（')[0]}-present.html`);
    fs.writeFileSync(presentPath, present.html, 'utf8');
    await page.goto(pathToFileURL(presentPath).href, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const meta = await page.evaluate(() => ({
      count: window.__deck ? window.__deck.count : -1,
      sections: document.querySelectorAll('.slide').length,
      external: [...document.querySelectorAll('link[href],script[src],img[src]')].map((e) => e.getAttribute('href') || e.getAttribute('src')),
    }));
    ok(meta.sections === deck.slides.length, `  [${tag}] present ${meta.sections}/${deck.slides.length} 页`);
    ok(meta.count === deck.slides.length, `  [${tag}] 运行时认出 ${meta.count} 页`);
    ok(meta.external.length === 0, `  [${tag}] 零外链`, meta.external.join(', '));

    /* ---- flat：逐页 element 截图 ---- */
    const flat = renderStyledDeck(deck, { style: style.id, mode: 'flat' });
    const flatPath = path.join(OUT, `${style.id}-${deckLabel.split('（')[0]}-flat.html`);
    fs.writeFileSync(flatPath, flat.html, 'utf8');
    await page.goto(pathToFileURL(flatPath).href, { waitUntil: 'load' });
    await page.waitForTimeout(1100);

    let shots = 0;
    for (let i = 0; i < Math.min(deck.slides.length, 40); i++) {
      const el = page.locator('.slide').nth(i);
      if (!(await el.count())) break;
      const f = path.join(SHOT_DIR, `${style.id}-${deckLabel.split('（')[0]}-p${String(i + 1).padStart(2, '0')}.png`);
      await el.screenshot({ path: f });
      allShots.push(f);
      shots++;
    }
    ok(shots === deck.slides.length, `  [${tag}] flat 截到 ${shots}/${deck.slides.length} 页`);

    /* ---- 全页文本量测 ---- */
    const measured = await page.evaluate(() => {
      const PUNCT = /^[\s·・•|/／\-—–~～.。,，、:：;；!！?？+＋*※#%…「」『』()（）[\]【】]+$/;
      const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
      const parse = (s) => {
        const m = String(s).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = (c) => {
        const f = (v) => ((v /= 255), v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const bgOf = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a >= 0.9) return c;
          n = n.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const isShell = (el) => {
        let n = el;
        while (n && n !== document.body) {
          if (n.closest && n.closest('.slide, #deck')) return false;
          if (getComputedStyle(n).position === 'fixed' && n.parentElement === document.body) return true;
          n = n.parentElement;
        }
        return false;
      };
      const foots = [...document.querySelectorAll('.slide')].map((s) => {
        const f = s.querySelector('.foot');
        return f ? f.innerText.replace(/\s+/g, ' ').trim() : '';
      });

      const out = { sizes: [], contrast: [], overflow: [], emoji: [], foots };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').trim();
        if (!t) continue;
        const el = node.parentElement;
        if (!el || isShell(el)) continue;
        // 只跳过**显式标记**的装饰（class="deco"）。
        // ⚠️ 不要用 aria-hidden 判装饰：外壳在翻页模式下会给非当前页打 aria-hidden，
        // 用它判会让检查只覆盖第 1 页（实测踩过，见 shell.mjs paint() 的注释）。
        if (el.closest && el.closest('.deco')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;

        const size = parseFloat(cs.fontSize);
        out.sizes.push({ size, text: t.slice(0, 22) });
        const fg = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
        const a1 = lum(fg) + 0.05, b1 = lum(bgOf(el)) + 0.05;
        const cr = Math.max(a1, b1) / Math.min(a1, b1);
        if (cr < 4.5 && !PUNCT.test(t)) out.contrast.push({ size, text: t.slice(0, 22), cr: Math.round(cr * 10) / 10 });
        if (EMOJI.test(t)) out.emoji.push(t.slice(0, 22));
        const host = el.closest('.slide');
        if (host) {
          const hr = host.getBoundingClientRect();
          const over = Math.max(r.right - hr.right, r.bottom - hr.bottom);
          if (over > 2) out.overflow.push({ text: t.slice(0, 22), over: Math.round(over) });
        }
      }
      return out;
    });

    const sizes = measured.sizes.map((s) => s.size).sort((a, b) => a - b);
    const tiny = measured.sizes.filter((s) => s.size < 14);
    ok(tiny.length === 0, `  [${tag}] 无 <14px 文字`, tiny.slice(0, 3).map((t) => `${t.size}px「${t.text}」`).join('; '));
    ok(measured.contrast.length === 0, `  [${tag}] 对比度 ≥4.5:1`, measured.contrast.slice(0, 3).map((c) => `${c.cr}:1「${c.text}」`).join('; '));
    ok(measured.overflow.length === 0, `  [${tag}] 不越出页面`, measured.overflow.slice(0, 3).map((o) => `+${o.over}px「${o.text}」`).join('; '));
    ok(measured.emoji.length === 0, `  [${tag}] 无 emoji`, measured.emoji.join(', '));
    const footHits = (measured.foots || [])
      .map((t, i) => ({ page: i + 1, t }))
      .filter((x) => x.t && new RegExp(`(^|[^\\d])0?${x.page}([^\\d]|$)`).test(x.t));
    ok(footHits.length === 0, `  [${tag}] 页内不带页码`, footHits.slice(0, 2).map((x) => `第${x.page}页「${x.t}」`).join('; '));
    console.log(`  [${tag}] 字号 min/中位/max = ${sizes[0]} / ${sizes[Math.floor(sizes.length / 2)]} / ${sizes[sizes.length - 1]} px`);

    await page.close();
  }

  ok(pageErrors.length === 0, `  [${style.id}] 无 JS 报错`, pageErrors.slice(0, 2).join(' | '));
}

await browser.close();

/* ---- 像素级墨迹检查：抓空白页（DOM 检查抓不到这一类） ---- */
console.log(`\n── 像素级墨迹检查（抓空白页）`);
if (allShots.length) {
  const r = spawnSync(PY, [INK, ...allShots], { encoding: 'utf8', timeout: 300000 });
  const tail = (r.stdout || '').trim().split('\n').pop();
  let blank = [];
  try {
    blank = JSON.parse(tail).blank || [];
  } catch {
    ok(false, '  墨迹检查输出无法解析');
  }
  ok(blank.length === 0, `  ${allShots.length} 页全部有内容（无空白页）`, blank.slice(0, 5).join(', '));
}

/* ---- 覆盖度自检：别让某个版式悄悄没被验过 ---- */
const missing = ALL_TYPES.filter((t) => !covered.has(t));
ok(missing.length === 0, `  13 种版式都被验收覆盖到`, `漏掉: ${missing.join(', ')}`);

console.log(`\n产物：${path.relative(ROOT, OUT)}`);
console.log(`${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
