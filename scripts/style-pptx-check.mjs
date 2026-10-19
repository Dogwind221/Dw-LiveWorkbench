/**
 * 「按风格导出可编辑 PPTX」的验收。
 *
 * 为什么单独一个脚本：HTML 看起来没问题 ≠ 转出来的 PPTX 没问题。
 * 实测踩过两次同类坑：
 *   1) 翻页式 HTML（一页一显）转出来第 2 页起全白 —— 转换脚本会跳过隐藏元素
 *   2) 页脚用 left:0/right:0 横跨整页，转出来的文本框宽 1932 > 画布 1920
 * 这两个都只在**转换产物**里才看得见，所以必须真的转一遍再量。
 *
 * 检查项：
 *   - 转换是否成功、页数是否与方案一致
 *   - 形状是否全部落在画布内（含把文本量成整块贴图的风险）
 *   - 文字是否真的是文本框（可编辑），而不是整页图片
 *
 * 用法：node scripts/style-pptx-check.mjs           # 全部就绪风格
 *       node scripts/style-pptx-check.mjs song      # 指定风格
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDeck } from '../server/lib/deck/build.mjs';
import { DECK_STYLES, renderStyledDeck } from '../server/lib/deck/html/index.mjs';
import { exportStyledPptx, stylePptxStatus } from '../server/lib/pptxStyle.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 不写死用户名：优先环境变量，其次从 homedir 推导（Windows / macOS / Linux 都能用）
const PY =
  process.env.PYTHON ||
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe');
const LO_KIT =
  process.env.LO_KIT ||
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js');
const TMP = path.join(ROOT, 'output', '_pptxcheck');
// 用当前 node 可执行文件跑 LibreOffice 渲染 CLI（同一个运行时，不依赖 PATH）
const NODE = process.execPath;

async function loadPlaywright() {
  for (const c of [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright', 'index.js'),
  ].filter(Boolean)) {
    try {
      const looksLikePath = c.includes('/') || c.includes('\\');
      return await import(looksLikePath ? pathToFileURL(c).href : c);
    } catch {}
  }
  throw new Error('找不到 playwright');
}

/**
 * 把转出来的 PPTX **渲染成图**，和 HTML 原版逐页比底色与明暗。
 *
 * 为什么必须有这一步：前面那些检查量的都是 pptx 的**结构**（有没有文本框、形状越没越界），
 * 量不出「转换时把页面底色弄丢了」——实测杂志风封面转出来是白底 + 浅字，文字几乎不可见，
 * 而结构检查全绿。只有把两边的画面放在一起比才看得见。
 */
function renderedPagesMatch(style, deck, pptxPath) {
  const outDir = path.join(TMP, `${style}-pptx`);
  fs.rmSync(outDir, { recursive: true, force: true });
  const r = spawnSync(NODE, [LO_KIT, 'render', '--input', pptxPath, '--output-dir', outDir, '--dpi', '72'], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || '').slice(-160) };
  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  return { dir: outDir, files };
}

/** 用 PIL 逐页比：角落底色 + 平均亮度 */
function compareImages(htmlShots, pptxShots) {
  const code = `
import json, sys
from PIL import Image, ImageStat
h = sys.argv[1].split('|')
p = sys.argv[2].split('|')
rows = []
for i, (a, b) in enumerate(zip(h, p)):
    ia = Image.open(a).convert('RGB').resize((240,135))
    ib = Image.open(b).convert('RGB').resize((240,135))
    ca, cb = ia.getpixel((6,6)), ib.getpixel((6,6))
    la = sum(ImageStat.Stat(ia).mean)/3.0
    lb = sum(ImageStat.Stat(ib).mean)/3.0
    rows.append({'page': i+1, 'htmlCorner': ca, 'pptxCorner': cb,
                 'cornerDist': max(abs(ca[k]-cb[k]) for k in range(3)),
                 'lumDiff': round(abs(la-lb),1)})
print(json.dumps(rows))
`;
  const r = spawnSync(PY, ['-c', code, htmlShots.join('|'), pptxShots.join('|')], {
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) return { error: (r.stderr || '').slice(-200) };
  try {
    return { rows: JSON.parse(r.stdout.trim().split('\n').pop()) };
  } catch {
    return { error: '解析失败' };
  }
}

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${!cond && extra ? ' → ' + extra : ''}`);
};

const only = process.argv[2];
const st = stylePptxStatus();
console.log('\n=== 按风格导出可编辑 PPTX 验收 ===');
if (!st.ok) {
  console.log(`  [SKIP] 环境不可用：${st.message}`);
  console.log('（这是环境缺失而不是产物缺陷，CI 里应显式安装 huashu-design + python playwright）');
  process.exit(0);
}
console.log(`  python: ${st.python}`);
console.log(`  script: ${st.script}\n`);

const deck = buildDeck({
  topic: '风格转 PPTX 验收',
  host: '阿茶',
  brand: '山外山茶事',
  durationMin: 60,
  purpose: 'newlaunch',
  audience: 'veteran',
  products: [
    { name: '老班章古树春茶', mountainName: '老班章', type: '生普', spec: '357g/饼', price: 2680, comparePrice: 3280 },
    { name: '冰岛老寨春茶', mountainName: '冰岛', type: '生普', spec: '200g/饼', price: 1980 },
  ],
});
console.log(`方案：${deck.slides.length} 页\n`);

const styles = DECK_STYLES.filter((s) => s.ready && (!only || s.id === only));
if (!styles.length) {
  console.log(only ? `没有就绪的风格匹配 "${only}"` : '没有就绪的风格');
  process.exit(1);
}

/** 用 python-pptx 量一份 pptx：页数、文本框/图片数、越界形状 */
function inspect(pptxPath) {
  const code = `
import json, sys
from pptx import Presentation
p = Presentation(sys.argv[1])
W, H = p.slide_width, p.slide_height
pages = []
big = []
for i, s in enumerate(p.slides):
    tb = pic = 0
    bad = []
    for sh in s.shapes:
        if sh.has_text_frame and sh.text_frame.text.strip():
            tb += 1
        if sh.shape_type == 13:
            pic += 1
            try:
                cov = (sh.width * sh.height) / (W * H)
                if cov > 0.2:
                    big.append({'page': i + 1, 'cover': round(cov * 100, 1)})
            except Exception:
                pass
        try:
            r = sh.left + sh.width
            b = sh.top + sh.height
        except Exception:
            continue
        if r > W + 6350 or b > H + 6350 or sh.left < -6350 or sh.top < -6350:  # 0.5pt 容差
            t = ''
            try:
                t = sh.text_frame.text.strip().replace('\\n', '/')[:26]
            except Exception:
                pass
            bad.append({'right': round(r/12700, 1), 'bottom': round(b/12700, 1), 'text': t})
    pages.append({'page': i + 1, 'textBoxes': tb, 'pictures': pic, 'outOfCanvas': bad})
print(json.dumps({'slideW': round(W/12700,1), 'slideH': round(H/12700,1), 'bigImages': big, 'pages': pages}, ensure_ascii=False))
`;
  const r = spawnSync(PY, ['-c', code, pptxPath], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300) };
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return { error: '解析 python 输出失败' };
  }
}

for (const style of styles) {
  console.log(`── ${style.label}（${style.id}）`);
  const res = exportStyledPptx(deck, { style: style.id });
  if (!res.ok) {
    ok(false, `  转换成功`, `${res.error} ${res.message}`);
    continue;
  }
  ok(true, `  转换成功（${res.slides} 页 · ${(res.bytes / 1024).toFixed(1)} KB）`);

  const info = inspect(res.pptxPath);
  if (info.error) {
    ok(false, '  能读回 pptx 结构', info.error);
    continue;
  }
  ok(info.pages.length === deck.slides.length, `  pptx 页数 ${info.pages.length}/${deck.slides.length}`);
  ok(info.slideW === 1920 && info.slideH === 1080, `  画布 ${info.slideW}×${info.slideH} pt（1pt = 1css px）`);

  const totalBoxes = info.pages.reduce((a, p) => a + p.textBoxes, 0);
  const totalPics = info.pages.reduce((a, p) => a + p.pictures, 0);
  // 每页至少要有若干真文本框
  const minPerPage = Math.min(...info.pages.map((p) => p.textBoxes));
  ok(totalBoxes >= deck.slides.length * 2, `  文字是真文本框（共 ${totalBoxes} 个，最少一页 ${minPerPage} 个）`);
  // 小图标被转成图片是正常的（实测 26×16pt 那种）；要拦的是「整页贴图」
  const bigImgs = info.bigImages || [];
  ok(bigImgs.length === 0, `  没有整页贴图（小图 ${totalPics} 张，占页 >20% 的 ${bigImgs.length} 张）`);

  const bad = info.pages.filter((p) => p.outOfCanvas.length);
  ok(
    bad.length === 0,
    '  所有形状都在画布内',
    bad.slice(0, 3).map((p) => `第${p.page}页 ${p.outOfCanvas.map((x) => `${x.text || '形状'} 到 ${x.right}pt`).join(', ')}`).join(' | ')
  );
  const noText = info.pages.filter((p) => p.textBoxes === 0).map((p) => p.page);
  ok(noText.length === 0, '  没有空的页（每页都有文本框）', `空白页: ${noText.join(',')}`);

  /* ---- 关键一步：把 pptx 渲染成图，和 HTML 原版逐页比底色与明暗 ---- */
  fs.mkdirSync(TMP, { recursive: true });
  const flat = renderStyledDeck(deck, { style: style.id, mode: 'flat' });
  const flatPath = path.join(TMP, `${style.id}-flat.html`);
  fs.writeFileSync(flatPath, flat.html, 'utf8');

  const pw = await loadPlaywright();
  const br = (pw.chromium || pw.default?.chromium) ? await (pw.chromium || pw.default.chromium).launch() : null;
  const htmlShots = [];
  if (br) {
    const page = await br.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(flatPath).href, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    for (let i = 0; i < deck.slides.length; i++) {
      const el = page.locator('.slide').nth(i);
      if (!(await el.count())) break;
      const f = path.join(TMP, `${style.id}-html-p${String(i + 1).padStart(2, '0')}.png`);
      await el.screenshot({ path: f });
      htmlShots.push(f);
    }
    await page.close();
    await br.close();
  }

  const rp = renderedPagesMatch(style.id, deck, res.pptxPath);
  if (rp.error) {
    ok(false, '  能把 pptx 渲染成图（用于比底色）', rp.error);
  } else {
    const pptxShots = rp.files.map((f) => path.join(rp.dir, f));
    const cmp = compareImages(htmlShots, pptxShots);
    if (cmp.error) {
      ok(false, '  逐页比底色', cmp.error);
    } else {
      // 角落底色差 >60 或平均亮度差 >40 → 底色被转换弄丢了
      const off = cmp.rows.filter((r) => r.cornerDist > 60 || r.lumDiff > 40);
      ok(
        off.length === 0,
        `  每页底色/明暗与 HTML 一致（比了 ${cmp.rows.length} 页）`,
        off.slice(0, 4).map((r) => `第${r.page}页 底色 ${r.htmlCorner}→${r.pptxCorner} 亮度差 ${r.lumDiff}`).join(' | ')
      );
    }
  }
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
