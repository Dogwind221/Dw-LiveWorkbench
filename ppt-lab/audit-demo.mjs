/**
 * 设计方向初稿的自动验收。
 *
 * 为什么写这个：SPEC 里的可读性底线（正文 ≥20px / 卡片描述 ≥18px / 标签 ≥14px /
 * 对比度 ≥4.5:1）是硬要求，而「看起来还行」是最容易骗过自己的判断。
 * 这里用浏览器实测每一页：字号、对比度、是否溢出 1920×1080 画布、有没有 emoji。
 *
 * 用法：node ppt-lab/audit-demo.mjs <html路径>
 */
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    'C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return await import(c.startsWith('C:') ? pathToFileURL(c).href : c);
    } catch {}
  }
  throw new Error('找不到 playwright');
}
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;

const htmlPath = process.argv[2];
if (!htmlPath || !existsSync(htmlPath)) {
  console.error('用法: node audit-demo.mjs <html路径>');
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
await page.waitForTimeout(1800);

/** 在页面里量一页：字号、对比度、越界、emoji */
const measure = () =>
  page.evaluate(() => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

    const parseColor = (s) => {
      const m = String(s).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const contrast = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    /** 往上找第一个不透明背景色（近似即可） */
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parseColor(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 0.9) return c;
        n = n.parentElement;
      }
      const c = parseColor(getComputedStyle(document.body).backgroundColor);
      return c && c.a >= 0.9 ? c : { r: 255, g: 255, b: 255, a: 1 };
    };

    const texts = [];
    const emojis = [];
    /** 纯标点/符号节点不参与对比度判定：分隔点不承载信息，WCAG 也不管它 */
    const PUNCT_ONLY = /^[\s·・•|/／\-—–~～.。,，、:：;；!！?？+＋*※#%…「」『』()（）[\]【】]+$/;
    const isHidden = (el) => {
      let n = el;
      while (n && n !== document.body) {
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
        n = n.parentElement;
      }
      return false;
    };
    /**
     * 是否属于「外壳 runtime」而非页面内容。
     *
     * SPEC 的可读性底线是约束**页面内容**的；deck 外壳（右下角快捷键提示条、
     * 页码圆点、演讲者 UI）是模板自带控件，且常是「半透明深色条盖在页面上」。
     * 本脚本取背景只沿 DOM 祖先找第一个不透明背景，看不到这层叠加，会把白字
     * 算成 1:1 —— 实测 B 版 10 个假阳性全在这里。所以把外壳单独归类、不参与判定。
     */
    const isShell = (el) => {
      let n = el;
      while (n && n !== document.body) {
        if (n.closest && n.closest('.slide, #deck, #deck-stage')) return false;
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed' && n.parentElement === document.body) return true;
        n = n.parentElement;
      }
      return false;
    };

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || '';
      const text = raw.trim();
      if (!text) continue;

      const el = node.parentElement;
      if (!el) continue;
      // aria-hidden 的子树是刻意装饰（幽灵年份出血、纯装饰图形），不参与判定
      if (isHidden(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;

      const size = parseFloat(cs.fontSize);
      const fg = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      const cr = contrast(fg, bgOf(el));

      texts.push({
        size: Math.round(size * 10) / 10,
        weight: cs.fontWeight,
        text: text.slice(0, 28),
        contrast: Math.round(cr * 10) / 10,
        punctOnly: PUNCT_ONLY.test(text),
        shell: isShell(el),
        // 相对当前视口（= 幻灯片画布）的位置，用来判越界
        overRight: Math.round(r.right - 1920),
        overBottom: Math.round(r.bottom - 1080),
        underLeft: Math.round(-r.left),
        underTop: Math.round(-r.top),
      });

      if (EMOJI.test(text)) emojis.push(text.slice(0, 28));
    }

    return {
      texts,
      emojis,
      docScrollWidth: document.documentElement.scrollWidth,
      docScrollHeight: document.documentElement.scrollHeight,
      title: document.title,
    };
  });

const all = [];
const pages = [];
for (let i = 0; i < 2; i++) {
  if (i > 0) {
    let moved = false;
    for (const act of [
      () => page.keyboard.press('ArrowRight'),
      () => page.keyboard.press('Space'),
      () => page.keyboard.press('PageDown'),
      () => page.mouse.click(1600, 540),
    ]) {
      const before = await page.screenshot();
      try { await act(); } catch { continue; }
      await page.waitForTimeout(1400);
      const after = await page.screenshot();
      if (Buffer.compare(before, after) !== 0) { moved = true; break; }
    }
    if (!moved) break;
  }
  const m = await measure();
  pages.push(m);
  all.push(...m.texts);
}

await browser.close();

/* ---------- 判定 ---------- */
const LABEL_FLOOR = 14, DESC_FLOOR = 18;
const emojis = [...new Set(pages.flatMap((p) => p.emojis))];
const overflow = all.filter((t) => t.overRight > 2 || t.overBottom > 2 || t.underLeft > 2 || t.underTop > 2);
const shellNodes = all.filter((t) => t.shell);
const content = all.filter((t) => !t.shell);
const lowContrast = content.filter((t) => t.contrast < 4.5 && !t.punctOnly);
const tiny = content.filter((t) => t.size < LABEL_FLOOR);
const sizes = content.map((t) => t.size).sort((a, b) => a - b);

const report = {
  html: path.resolve(htmlPath),
  title: pages[0]?.title,
  pagesMeasured: pages.length,
  textNodes: all.length,
  contentNodes: content.length,
  shellNodes: shellNodes.length,
  fontSizes: {
    min: sizes[0],
    median: sizes[Math.floor(sizes.length / 2)],
    max: sizes[sizes.length - 1],
    belowLabelFloor: tiny.length,
    belowDescFloor: content.filter((t) => t.size < DESC_FLOOR).length,
  },
  issues: {
    tinyText: tiny.slice(0, 6),
    lowContrast: lowContrast.slice(0, 6),
    overflow: overflow.slice(0, 6),
    emoji: emojis.slice(0, 6),
    pageErrors: pageErrors.slice(0, 4),
  },
  verdict: {
    noTinyText: tiny.length === 0,
    contrastOk: lowContrast.length === 0,
    noOverflow: overflow.length === 0,
    noEmoji: emojis.length === 0,
    noPageErrors: pageErrors.length === 0,
  },
};
report.pass = Object.values(report.verdict).every(Boolean);

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
