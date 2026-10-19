/**
 * 直播工作台 —— DSH 插件「客户端半边」（手写产物，不需要编译）。
 *
 * ⚠️ 包装格式是契约：`window.__ModuleLoader__.load({ id, factory })` 里的 id
 * 必须等于 **package.json 的包名**（`dsh-live-workbench`）。DSH 的 client-modules
 * 以包名作为模块表行 id，取件地址是 /plugins/<包名>/client.js。
 * 这里手写而不走 tsdown：产物就是这么一层包装 + 一个 CJS 模块，没必要引入构建链。
 *
 * 提供的界面（左下角）：
 *   sidebar.footer.action        侧栏底部、Settings 上方的那一行（本插件的入口）
 *   sidebarRightTabs + 两个 seat  点它把工作台开在右侧栏，会话继续占中栏
 *
 * 页面本体是同源 iframe /live-workbench/，由宿主半边注册的前缀路由提供。
 */
window.__ModuleLoader__.load({ id: "dsh-live-workbench", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require('react');
var h = React.createElement;

/** 需要的外壳服务：插槽注册表、右侧栏页签类型表、右侧栏控制器。 */
var inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

/** 侧栏入口的 cell id。 */
var ENTRY_ID = 'live-workbench';
/** 页签类型判别符，openTab 用它。 */
var TAB_KIND = 'live-workbench';
/** 本实现在页签系统里的身份，body/title 两个 seat 用它当 key。 */
var TAB_ID = 'dsh-live-workbench';
/** 工作台页面地址（宿主半边注册的同源前缀路由）。 */
var WORKBENCH_URL = '/live-workbench/';

/** 侧栏控制器句柄，apply 时抓一次，入口和状态查询共用。 */
var sidebarRightHandle;

/* ---------------------------------------------------------------- 图标 */
/**
 * 茶叶图标（内联 SVG）。
 *
 * 不用「茶」字：汉字在 15px 下像个小色块，和旁边的 ◈ 自媒体工作台也不搭。
 * 叶形和 PPT 封面上的品牌纹样是同一套形状语言（同一段路径）。
 * @param {number} size 边长像素
 * @returns {object} React 元素
 */
function leafIcon(size) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 200 220',
    'aria-hidden': true, focusable: 'false',
    style: { flex: '0 0 auto', display: 'block' },
  }, h('path', {
    d: 'M100,6 C158,54 162,138 100,214 C38,138 42,54 100,6 Z',
    fill: 'currentColor',
  }));
}

/* ---------------------------------------------------------------- 样式 */
var entryStyle = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
  padding: '8px 10px', borderRadius: 8, border: '1px solid transparent',
  background: 'transparent', color: 'var(--dsw-alias-label-secondary, #b9b9c0)',
  cursor: 'pointer', fontSize: 13, lineHeight: 1.2, textAlign: 'left',
};
var tabBodyStyle = {
  height: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column',
  background: '#faf7f2',
};
var frameStyle = { flex: '1 1 auto', minHeight: 0, width: '100%', border: 0, background: '#faf7f2' };

/* ------------------------------------------------------------ 控制器 */
/** 工作台是否已经在右侧栏打开。座位未挂载时不能抛错。 */
function sideWorkbenchOpen() {
  if (sidebarRightHandle === undefined) return false;
  try {
    var active = sidebarRightHandle.active();
    return active !== undefined && active.kind === TAB_KIND;
  } catch (e) {
    return false;
  }
}

/** 开/关右侧栏里的工作台。已经打开就关掉，否则打开（打开会顺带展开侧栏）。 */
function toggleSideWorkbench() {
  if (sidebarRightHandle === undefined) return;
  var active;
  try {
    active = sidebarRightHandle.active();
  } catch (e) {
    active = undefined;
  }
  var open = active !== undefined && active.kind === TAB_KIND;
  try {
    if (open) sidebarRightHandle.close(active.id);
    else sidebarRightHandle.openTab(TAB_KIND);
  } catch (e) {
    /* 侧栏尚未挂载：下一次点击再试 */
  }
}

/* ------------------------------------------------------------ 组件 */
/** 左下角入口行（owner props: 侧栏是否展开）。 */
function WorkbenchEntry(props) {
  var wide = props && props.wide;
  return h('button', {
    type: 'button',
    title: '直播工作台（右侧栏打开）',
    'aria-label': '直播工作台（右侧栏打开）',
    'data-live-workbench-foot': true,
    style: entryStyle,
    onClick: toggleSideWorkbench,
  },
  leafIcon(15),
  wide ? h('span', null, '直播工作台') : null);
}

/** 右侧栏页签内容：同源 iframe 里的工作台页面。 */
function WorkbenchTabBody() {
  return h('div', { style: tabBodyStyle, 'data-live-workbench-tab': true },
    h('iframe', { src: WORKBENCH_URL, title: '直播工作台', style: frameStyle }),
  );
}

/** 页签上的标题。 */
function WorkbenchTabTitle() {
  return h('span', null, '直播工作台');
}

/** 页签指引里的图标（同一个茶叶图标）。 */
function WorkbenchGlyph(props) {
  return leafIcon((props && props.size) || 16);
}

/* -------------------------------------------------------------- 装配 */
function apply(ctx) {
  sidebarRightHandle = ctx.sidebarRight;

  ctx.effect(function () {
    return ctx.slots.inject('sidebar.footer.action', function () {
      return ctx.slots.register({
        name: 'sidebar.footer.action',
        id: ENTRY_ID,
        order: 20,
        label: '直播工作台',
      }, WorkbenchEntry);
    });
  }, 'live-workbench: sidebar foot entry');

  ctx.effect(function () {
    return ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: function () { return '直播工作台'; },
      guide: [{
        id: ENTRY_ID,
        order: 30,
        title: function () { return '直播工作台'; },
        description: function () { return '每日情报、山头知识库、PPT与口播稿、提词器、合规检查、复盘切片'; },
        icon: WorkbenchGlyph,
      }],
    });
  }, 'live-workbench: right tab type');

  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.pane.tab', function () {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, WorkbenchTabBody);
    });
  }, 'live-workbench: right tab body');

  ctx.effect(function () {
    return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, WorkbenchTabTitle);
    });
  }, 'live-workbench: right tab title');
}

exports.inject = inject;
exports.apply = apply;
return module.exports; } });
