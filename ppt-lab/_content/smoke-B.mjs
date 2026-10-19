/**
 * 外壳功能冒烟测试:ESC 索引、P 演讲者模式、B 低功耗,以及字体/圆角/渐变体检。
 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const HTML = 'F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/motion\.min\.js|ERR_FAILED/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load' });
await page.waitForTimeout(2000);

console.log('motion-ready:', await page.evaluate(() => document.body.classList.contains('motion-ready')));
console.log('字体体检(页面内所有元素 family 是否含 serif):', await page.evaluate(() => {
  const bad = new Set();
  document.querySelectorAll('section.slide *').forEach((el) => {
    const f = getComputedStyle(el).fontFamily.toLowerCase();
    if (/serif/.test(f) && !/sans-serif/.test(f)) bad.add(f);
  });
  return bad.size ? [...bad] : '无衬线 ✓';
}));
console.log('圆角 / 阴影 / 渐变体检(当前页内联样式):', await page.evaluate(() => {
  const hits = [];
  document.querySelectorAll('section.slide [style]').forEach((el) => {
    const s = el.getAttribute('style');
    if (/border-radius/.test(s) && !/border-radius:\s*0/.test(s)) hits.push('radius: ' + s.slice(0, 60));
    if (/box-shadow/.test(s)) hits.push('shadow: ' + s.slice(0, 60));
    if (/gradient/.test(s)) hits.push('gradient: ' + s.slice(0, 60));
  });
  return hits.length ? hits : '无 ✓';
}));

// B 低功耗
await page.keyboard.press('b');
await page.waitForTimeout(600);
console.log('按 B 后 low-power:', await page.evaluate(() => document.body.classList.contains('low-power')),
  '| ascii canvas display:', await page.evaluate(() => getComputedStyle(document.querySelector('canvas.ascii-bg')).display),
  '| hint 文案:', await page.evaluate(() => document.querySelector('.ppt-low-power-label')?.textContent));
await page.keyboard.press('b');
await page.waitForTimeout(400);

// ESC 索引
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
console.log('ESC 索引可见:', await page.evaluate(() => getComputedStyle(document.getElementById('overview')).display));
await page.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/smoke-overview.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// P 演讲者模式
await page.keyboard.press('p');
await page.waitForTimeout(1200);
console.log('演讲者模式:', await page.evaluate(() => document.body.classList.contains('ppt-presenter')),
  '| deck 可见性:', await page.evaluate(() => getComputedStyle(document.getElementById('deck')).visibility));
await page.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/smoke-presenter.png' });
console.log('errors:', errs.length ? errs : '无');
await browser.close();
