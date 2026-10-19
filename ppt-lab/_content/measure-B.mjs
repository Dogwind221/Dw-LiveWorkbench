/**
 * 方向 B 自测量:把 validator 判定为「没问题」的项也打印出具体数值,
 * 方便精确调整间距。同时输出 1600×900(校验器视口)与 1920×1080(交付尺寸)两组数字。
 * 用法: node ppt-lab/_content/measure-B.mjs
 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const file = 'F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const [W, H] of [[1600, 900], [1920, 1080], [1280, 1024]]) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(1500);
  const out = await page.evaluate(() => {
    const deck = document.getElementById('deck');
    const dr = deck.getBoundingClientRect();
    const hasText = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    const label = (n) => '.' + String(n.className).split(' ').filter(Boolean).join('.') + ' "' + n.textContent.trim().replace(/\s+/g, ' ').slice(0, 22) + '"';
    return {
      stage: [Math.round(dr.width), Math.round(dr.height), Math.round(dr.left), Math.round(dr.top)],
      slides: [...document.querySelectorAll('section.slide')].map((el) => {
        const er = el.getBoundingClientRect();
        const nodes = [...el.querySelectorAll('*')].filter((n) => {
          const r = n.getBoundingClientRect();
          const cs = getComputedStyle(n);
          if (r.width < 6 || r.height < 6) return false;
          if (n === el || n.classList.contains('canvas-card')) return false;
          if (n.matches('canvas.ascii-bg,.dot-mat,.ring-mat,.cross-mat')) return false;
          return hasText(n) || ['IMG', 'CANVAS', 'SVG'].includes(n.tagName) || (r.height <= 4 && parseFloat(cs.borderTopWidth) >= 1);
        });
        let top = Infinity, bottom = -Infinity, tn = null, bn = null;
        for (const n of nodes) {
          const r = n.getBoundingClientRect();
          if (r.top - er.top < top) { top = r.top - er.top; tn = n; }
          if (r.bottom - er.top > bottom) { bottom = r.bottom - er.top; bn = n; }
        }
        const H = el.clientHeight;
        const h2 = el.querySelector('h2');
        const num = el.querySelector('.num-mega');
        const dots = [...el.querySelectorAll('.th-node .dot')].map((d) => {
          const r = d.getBoundingClientRect();
          return Math.round(r.top - er.top + r.height / 2);
        });
        const labels = [...el.querySelectorAll('.th-node .label')].map((l) => {
          const r = l.getBoundingClientRect();
          return [Math.round(r.top - er.top), Math.round(r.bottom - er.top), Math.round(r.left - er.left)];
        });
        return {
          layout: el.dataset.layout, H,
          top: Math.round(top), bottom: Math.round(bottom),
          bottomGap: Math.round(H - bottom), safeBottom: Math.round(H * 0.93),
          activeRatio: +((bottom - top) / H).toFixed(3),
          topNode: tn && label(tn), bottomNode: bn && label(bn),
          titleGap: h2 && num ? Math.round(num.getBoundingClientRect().top - h2.getBoundingClientRect().bottom) : null,
          dots, labels,
          navTop: Math.round(document.getElementById('nav').getBoundingClientRect().top - er.top),
        };
      }),
    };
  });
  console.log(`\n=== ${W}×${H} · stage ${out.stage.join(',')} ===`);
  for (const s of out.slides) {
    console.log(` ${s.layout}: H=${s.H} top=${s.top} bottom=${s.bottom} (nav-safe ${s.safeBottom}, gap ${s.safeBottom - s.bottom}) bottomGap=${s.bottomGap} active=${s.activeRatio} titleGap=${s.titleGap} navTop=${s.navTop}`);
    console.log(`   lowest: ${s.bottomNode}`);
    if (s.labels.length) console.log(`   dots=${s.dots.join(',')} labels(top,bottom,left)=${JSON.stringify(s.labels)}`);
  }
  await ctx.close();
}
await browser.close();
