/**
 * 按视觉风格导出**可编辑** PPTX。
 *
 * 走的是 huashu-design 的路线 B：`scripts/pptx_from_rendered.py` 读浏览器渲染后的
 * 坐标，把每个元素翻译成 PowerPoint 的文本框/形状（文字是真文本，不是整页贴图）。
 *
 * 两个关键点，都是实测踩出来的：
 *
 * 1) **必须用 flat 模式的 HTML**。该脚本会跳过 `display:none` / `visibility:hidden` /
 *    `opacity:0` 的元素，所以翻页式（一页一显）的 HTML 转出来第 2 页起全是空白。
 *    我们的 flat 模式把所有页同时铺开可见，正好满足它。
 *
 * 2) **它依赖 Python 版 playwright**（含 chromium）。skill 自带脚本用的是
 *    `playwright.async_api`，Node 侧那份用不了。缺失时明确报错，不静默降级。
 *
 * 依赖外部 skill 的路径，所以找不到时返回可读的原因，而不是崩掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { ROOT } from './paths.mjs';
import { findPython } from './ppt.mjs';
import { renderStyledDeck } from './deck/html/index.mjs';

/** huashu-design skill 的安装位置（可用环境变量覆盖） */
function skillScript() {
  const roots = [
    process.env.HUASHU_SKILL_DIR,
    path.join(os.homedir(), '.agents', 'skills', 'huashu-design'),
    path.join(process.env.USERPROFILE || '', '.agents', 'skills', 'huashu-design'),
  ].filter(Boolean);
  for (const r of roots) {
    const f = path.join(r, 'scripts', 'pptx_from_rendered.py');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** Python 侧是否装了 playwright（缺失就装不了，明确告知） */
function pythonHasPlaywright(py) {
  const r = spawnSync(py, ['-c', 'import playwright'], { encoding: 'utf8', timeout: 30000 });
  return r.status === 0;
}

export function stylePptxStatus() {
  // 注意：findPython() 返回 {exe, pptxVersion}，没有 ok 字段，判存在要看 exe
  const py = findPython();
  if (!py || !py.exe) return { ok: false, message: '未找到可用的 Python' };
  const script = skillScript();
  if (!script) {
    return {
      ok: false,
      message: '未找到 huashu-design skill（需要它的 scripts/pptx_from_rendered.py）。可用 HUASHU_SKILL_DIR 指定安装位置。',
    };
  }
  if (!pythonHasPlaywright(py.exe)) {
    return {
      ok: false,
      message: 'Python 侧缺少 playwright，无法把 HTML 转成可编辑 PPTX。装法：python -m pip install "playwright==1.63.0"（与本地 chromium 版本对齐）',
    };
  }
  return { ok: true, script, python: py.exe };
}

/**
 * @param {object} deck DeckSpec
 * @param {{style?: string}} [opts]
 * @returns {{ok: boolean, message?: string, pptxPath?: string, slides?: number, bytes?: number, styleLabel?: string}}
 */
export function exportStyledPptx(deck, opts = {}) {
  const st = stylePptxStatus();
  if (!st.ok) return { ok: false, error: 'ENV', message: st.message };

  let rendered;
  try {
    // flat：所有页同时可见 —— 这是转换脚本能读到每一页的前提
    rendered = renderStyledDeck(deck, { style: opts.style, mode: 'flat' });
  } catch (e) {
    return { ok: false, error: 'STYLE_FAILED', message: e.message };
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(deck.meta?.title || 'deck').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const base = `${stamp}_${safe}_${rendered.style}`;
  const tmpHtml = path.join(ROOT, 'output', 'html', `${base}-flat-for-pptx.html`);
  const outPptx = path.join(ROOT, 'output', 'pptx', `${base}.pptx`);
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.mkdirSync(path.dirname(outPptx), { recursive: true });
  fs.writeFileSync(tmpHtml, rendered.html, 'utf8');

  const r = spawnSync(
    st.python,
    [
      st.script,
      tmpHtml,
      '-o',
      outPptx,
      '--selector',
      '.slide',
      // 装饰性出血元素（幽灵年份、刻度环等）用 class="deco" 标记并在这里跳过：
      // 它们是刻意的出血，转成文本框会越出画布（实测 2322pt > 1920）
      '--skip-class',
      'deco',
      '--font-ea',
      '微软雅黑',
      '--font-latin',
      'Microsoft YaHei',
    ],
    { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (r.status !== 0 || !fs.existsSync(outPptx)) {
    return {
      ok: false,
      error: 'CONVERT_FAILED',
      message: (r.stderr || r.stdout || '转换失败').trim().split('\n').slice(-4).join(' | ').slice(0, 500),
    };
  }

  return {
    ok: true,
    style: rendered.style,
    styleLabel: rendered.label,
    pptxPath: outPptx,
    fileName: path.basename(outPptx),
    slides: (deck.slides || []).length,
    bytes: fs.statSync(outPptx).size,
    htmlUsed: tmpHtml,
  };
}
