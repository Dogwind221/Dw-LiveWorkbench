/** 确认两页的文案都真实存在且可见(不是被裁掉/隐藏)。 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(pathToFileURL('F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际.html').href, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const probe = () => page.evaluate(() => [...document.querySelectorAll('section.slide')].map((el) => {
  const r = el.getBoundingClientRect();
  const texts = [...el.querySelectorAll('*')].filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
  return {
    layout: el.dataset.layout,
    ariaHidden: el.getAttribute('aria-hidden'),
    slideRect: [Math.round(r.left), Math.round(r.width)],
    textNodes: texts.length,
    visibleTextNodes: texts.filter((n) => { const b = n.getBoundingClientRect(); return b.width > 1 && b.height > 1 && getComputedStyle(n).visibility !== 'hidden'; }).length,
    onScreenTextNodes: texts.filter((n) => { const b = n.getBoundingClientRect(); return b.right > 0 && b.left < 1920 && b.bottom > 0 && b.top < 1080; }).length,
  };
}));
console.log('page1:', JSON.stringify(await probe(), null, 1));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(2000);
console.log('page2:', JSON.stringify(await probe(), null, 1));
await browser.close();
