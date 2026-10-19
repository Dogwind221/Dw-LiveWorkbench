/**
 * 视觉风格注册表。
 *
 * DeckSpec 只描述内容；视觉风格是**渲染期选择**。这样同一份方案可以按不同风格输出，
 * 也可以以后再加风格，不用动生成引擎。
 *
 * 每个风格模块见 CONTRACT.md，只导出 meta / css / slide() 三样。
 */
import { renderDeckHtml } from './shell.mjs';
import * as song from './song.mjs';
import * as magazine from './magazine.mjs';
import * as swiss from './swiss.mjs';

/** 顺序即 UI 上的展示顺序 */
const MODULES = [magazine, swiss, song];

/** UI / API 用的风格清单（不含实现细节） */
export const DECK_STYLES = MODULES.map((m) => ({
  id: m.meta.id,
  label: m.meta.label,
  desc: m.meta.desc,
  source: m.meta.source,
  swatches: m.meta.swatches || [],
  // ready:false 的风格在 UI 上禁用，避免用户选了却渲染不出来
  ready: m.meta.ready !== false,
}));

export const DEFAULT_STYLE = MODULES.find((m) => m.meta.ready !== false)?.meta.id || MODULES[0].meta.id;

export function getStyleModule(id) {
  const m = MODULES.find((x) => x.meta.id === id);
  return m || null;
}

/**
 * 把一份 DeckSpec 渲染成单文件 HTML。
 * @param {object} deck
 * @param {{style?: string, mode?: 'present'|'flat', title?: string}} [opts]
 */
export function renderStyledDeck(deck, opts = {}) {
  const id = opts.style || DEFAULT_STYLE;
  const mod = getStyleModule(id);
  if (!mod) throw new Error(`未知的视觉风格: ${id}`);
  if (mod.meta.ready === false) throw new Error(`视觉风格「${mod.meta.label}」尚未实现`);
  return {
    style: id,
    label: mod.meta.label,
    html: renderDeckHtml(deck, mod, { mode: opts.mode, title: opts.title }),
  };
}
