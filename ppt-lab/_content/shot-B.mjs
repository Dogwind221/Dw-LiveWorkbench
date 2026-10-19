/**
 * 交付截图 + 细节裁剪。
 * 与 ppt-lab/shot-deck.mjs 同一方法(开页 → 翻页 → 截 1920×1080),
 * 但**翻页后等 3.5s**:S11 的 timeline-walk recipe 是 4 个节点依次点亮,
 * 最后一节点在翻页后约 2.2s 才落定,1.4s 会截到动画中间态(04 还没出现)。
 * 另附:非 16:9 窗口(1280×1024)截图,用来核对 letterbox 是否留边不变形。
 */
import { pathToFileURL } from 'node:url';
const pw = await import('file:///C:/Users/ASUS/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const OUT = 'F:/dsh/直播工作台/ppt-lab/design-demos/B-瑞士国际';
const HTML = OUT + '.html';
const browser = await chromium.launch();

// 1) 交付尺寸 1920×1080
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load' });
await page.evaluate(() => document.fonts && document.fonts.ready);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}-p1.png` });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}-p2.png` });
// 细节裁剪:封面右下(外壳 UI 与页面文案是否打架)
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(1200);
await page.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/crop-cover-bottomright.png', clip: { x: 1180, y: 900, width: 740, height: 180 } });
await page.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/crop-cover-title.png', clip: { x: 0, y: 380, width: 1100, height: 260 } });
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(3500);
await page.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/crop-chain-axis.png', clip: { x: 120, y: 520, width: 1700, height: 460 } });
await ctx.close();

// 2) 非 16:9:验证 letterbox
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 1024 }, deviceScaleFactor: 1 });
const p2 = await ctx2.newPage();
await p2.goto(pathToFileURL(HTML).href, { waitUntil: 'load' });
await p2.waitForTimeout(2200);
await p2.screenshot({ path: 'F:/dsh/直播工作台/ppt-lab/_content/letterbox-1280x1024.png' });
await ctx2.close();
await browser.close();
console.log('shots done');
