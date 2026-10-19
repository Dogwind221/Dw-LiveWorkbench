/**
 * 诊断:项目 audit-demo.mjs 在横向轨道 deck 上会把「非当前页」判成越界。
 * 这里检查翻页是否真的发生、以及每页可见元素的边界。
 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
await page.goto(pathToFileURL('F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html').href, { waitUntil: 'load' });
await page.waitForTimeout(1800);

const snap = () => page.evaluate(() => {
  const deck = document.getElementById('deck');
  const dr = deck.getBoundingClientRect();
  const cs = getComputedStyle(deck);
  return {
    transform: cs.transform,
    deckRect: [Math.round(dr.left), Math.round(dr.top), Math.round(dr.width), Math.round(dr.height)],
    active: window.__currentSlideIndex,
    slides: [...document.querySelectorAll('section.slide')].map((el) => {
      const r = el.getBoundingClientRect();
      return { layout: el.dataset.layout, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    }),
  };
});
console.log('page1:', JSON.stringify(await snap()));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(1600);
console.log('after ArrowRight:', JSON.stringify(await snap()));
const outside = await page.evaluate(() => {
  const bad = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (!t) continue;
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > 1922 || r.left < -2 || r.bottom > 1082 || r.top < -2) {
      bad.push({ text: t.slice(0, 18), left: Math.round(r.left), right: Math.round(r.right) });
    }
  }
  return bad.slice(0, 12);
});
console.log('元素越出 1920×1080 视口的文本节点(翻页后):');
outside.forEach((b) => console.log('  ', JSON.stringify(b)));
console.log('pageErrors:', errors);
await browser.close();
