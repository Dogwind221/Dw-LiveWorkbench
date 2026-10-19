/**
 * 逐页把「当前页」的可读性底线量清楚(字号 / 对比度 / 越界),并单独标出页面内容与外壳 UI。
 * 逻辑照抄 ppt-lab/audit-demo.mjs,但只统计当前活动页,且打印全部明细。
 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL('F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html').href, { waitUntil: 'load' });
await page.waitForTimeout(1800);

const measure = () => page.evaluate(() => {
  const parseColor = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parseColor(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.9) return c; n = n.parentElement; } const c = parseColor(getComputedStyle(document.body).backgroundColor); return c && c.a >= 0.9 ? c : { r: 255, g: 255, b: 255, a: 1 }; };
  const inSlide = (el) => !!el.closest('section.slide');
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.nodeValue || '').trim(); if (!t) continue;
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
    const cr = Math.round(contrast(parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 }, bgOf(el)) * 10) / 10;
    out.push({
      text: t.slice(0, 20), size, weight: cs.fontWeight, contrast: cr,
      slide: inSlide(el), cls: String(el.className).slice(0, 26),
      over: Math.round(r.right - 1920), under: Math.round(-r.left),
    });
  }
  return out;
});

for (let i = 0; i < 2; i++) {
  if (i) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1500); }
  const rows = await measure();
  const p = rows.filter((r) => r.slide);
  console.log(`\n===== 第 ${i + 1} 页(仅页面内容)=====`);
  console.log(`  文本节点 ${p.length} 个;最小字号 ${Math.min(...p.map((r) => r.size))}px;最大 ${Math.max(...p.map((r) => r.size))}px`);
  const bad = p.filter((r) => r.size < 14 || r.contrast < 4.5 || r.over > 2 || r.under > 2);
  console.log('  不达标:', bad.length ? '' : '无');
  bad.forEach((r) => console.log('   ', JSON.stringify(r)));
  console.log('  字号分布:', [...new Set(p.map((r) => r.size))].sort((a, b) => a - b).join(', '));
  const shell = rows.filter((r) => !r.slide);
  console.log('  外壳 UI 低对比项:', shell.filter((r) => r.contrast < 4.5).map((r) => r.text + '@' + r.contrast).join(' | ') || '无');
}
await browser.close();
