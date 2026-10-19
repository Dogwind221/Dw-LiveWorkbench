/**
 * 插件契约测试（不需要启动 DSH）。
 *
 * 验证三件事：
 *   1) package.json 满足 client-modules 的 dsh.client 契约（包名 = 模块表行 id）
 *   2) 宿主半边能被 Cordis 装配，并注册 /live-workbench 前缀路由
 *   3) 客户端半边能在模拟的 __ModuleLoader__ 里加载，并按契约注册
 *      左下角入口（sidebar.footer.action）与右侧栏页签
 *
 * 用法：node scripts/plugin-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN = path.join(ROOT, 'plugin', 'dsh-live-workbench');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [PASS]' : '  [FAIL]'} ${label}${extra && !cond ? ' → ' + extra : ''}`);
};
const read = (rel) => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');

/* ------------------------------------------------- 1. package.json 契约 */
console.log('=== 1. 包契约（client-modules 的 dsh.client）===');
const pkg = JSON.parse(read('package.json'));
ok(pkg.name === 'dsh-live-workbench', `包名 ${pkg.name}`);
ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web');
ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject 已声明');
ok(pkg.exports?.['./client']?.default === './client/client.js', 'exports["./client"] 指向客户端产物');
ok(fs.existsSync(path.join(PLUGIN, pkg.exports['./client'].default)), '客户端产物文件存在');
const mainRel = pkg.main || pkg.exports?.['.']?.default;
ok(fs.existsSync(path.join(PLUGIN, mainRel)), `宿主半边文件存在（${mainRel}）`);

/* --- 客户端产物里的注册 id 必须等于包名，否则模块表找不到这一行 --- */
const clientSrc = read('client/client.js');
const idMatch = clientSrc.match(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/);
ok(!!idMatch, '客户端产物带 __ModuleLoader__.load 包装');
ok(idMatch && idMatch[1] === pkg.name, `注册 id 等于包名（${idMatch && idMatch[1]}）`);

/* --------------------------------------------------- 2. 宿主半边装配 */
console.log('\n=== 2. 宿主半边（Cordis 装配）===');
const hostUrl = pathToFileURL(path.join(PLUGIN, mainRel)).href;
const host = await import(hostUrl);
ok(host.name === 'live-workbench', `插件名 ${host.name}`);
ok(Array.isArray(host.inject) && host.inject.includes('webServer'), 'inject 声明了 webServer');

const routes = [];
const fakeCtx = {
  effect: (fn) => fn(),
  webServer: {
    register: (r) => {
      routes.push(r);
      return () => {};
    },
  },
};
let hostError = '';
try {
  host.apply(fakeCtx, {});
} catch (e) {
  hostError = e.message;
}
ok(hostError === '', 'apply() 不抛错', hostError);
// 处理器是动态 import（为了穿透 ESM 缓存），路由注册是异步的，等一拍再断言
await new Promise((r) => setTimeout(r, 400));
ok(routes.length === 1, `注册了 ${routes.length} 条路由`);
ok(routes[0]?.kind === 'prefix', '路由类型是 prefix');
ok(routes[0]?.path === '/live-workbench', `路由路径 ${routes[0]?.path}`);
ok(typeof routes[0]?.handler === 'function', '路由带 handler');

/* --- 路由真的能把工作台服务出来 --- */
if (typeof routes[0]?.handler === 'function') {
  const server = http.createServer(routes[0].handler);
  await new Promise((r) => server.listen(8792, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:8792/live-workbench/');
    const html = await res.text();
    ok(res.status === 200 && html.includes('直播工作台'), '前缀路由能服务工作台页面');
    const api = await fetch('http://127.0.0.1:8792/live-workbench/api/health');
    const health = await api.json();
    ok(api.status === 200 && health.ok === true, '前缀路由下 API 可用');
  } finally {
    // 必须 await 关闭完成：紧接着 process.exit() 会和 libuv 的 handle 收尾竞态，
    // Windows 上会触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并返回 1
    await new Promise((r) => server.close(r));
  }
}

/* --------------------------------------------------- 3. 客户端半边装配 */
console.log('\n=== 3. 客户端半边（模拟 __ModuleLoader__）===');
const pending = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => {
      pending.set(registration.id, registration.factory);
    },
  },
};
await import(pathToFileURL(path.join(PLUGIN, 'client', 'client.js')).href);
ok(pending.size === 1, `模块加载器收到 ${pending.size} 个注册`);

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
};
const factory = pending.get(pkg.name);
ok(typeof factory === 'function', '工厂函数可取到');
const loaded = factory((id) => {
  if (id === 'react') return fakeReact;
  throw new Error(`未预期的 require: ${id}`);
});
ok(Array.isArray(loaded.inject), `客户端 inject: ${JSON.stringify(loaded.inject)}`);
ok(typeof loaded.apply === 'function', '客户端导出 apply()');

/* --- 用记录型 ctx 跑一遍 --- */
const slotRecords = [];
const tabDefs = [];
const opened = [];
const clientCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, install) => install(),
    register: (options, component) => {
      slotRecords.push({ options, component });
      return () => {};
    },
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabDefs.push(definition);
      return () => {};
    },
  },
  sidebarRight: {
    active: () => undefined,
    openTab: (kind) => opened.push(kind),
    close: () => {},
  },
};
let clientError = '';
try {
  loaded.apply(clientCtx);
} catch (e) {
  clientError = e.message;
}
ok(clientError === '', 'apply() 不抛错', clientError);

const foot = slotRecords.find((r) => r.options.name === 'sidebar.footer.action');
ok(!!foot, '注册到了 sidebar.footer.action（左下角插槽）');
ok(foot?.options.id === 'live-workbench', `入口 id ${foot?.options.id}`);
ok(typeof foot?.component === 'function', '入口是组件');

const bodySeat = slotRecords.find((r) => r.options.name === 'sidebar.right.pane.tab');
const titleSeat = slotRecords.find((r) => r.options.name === 'sidebar.right.pane.tab.title');
ok(!!bodySeat && bodySeat.options.key === 'dsh-live-workbench', '注册了页签内容 seat（key = 实现 id）');
ok(!!titleSeat && titleSeat.options.key === 'dsh-live-workbench', '注册了页签标题 seat');

const tabDef = tabDefs[0];
ok(!!tabDef, '注册了右侧栏页签类型');
ok(tabDef?.id === 'dsh-live-workbench' && tabDef?.kind === 'live-workbench', '页签类型 id/kind 正确');
ok(typeof tabDef?.title === 'function' && tabDef.title('') === '直播工作台', '页签标题正确');
ok(Array.isArray(tabDef?.guide) && !!tabDef.guide[0]?.id, 'guide 条目带必填的 id');
ok(tabDef?.patterns === undefined, '是页面类型（未声明 patterns，只能按 kind 打开）');

/* --- 组件行为 --- */
const tree = foot.component({ wide: true });
ok(tree?.type === 'button', '入口渲染成 button');
ok(!!tree?.props?.['data-live-workbench-foot'], '入口带可定位的 data 属性');
tree.props.onClick();
ok(opened.length === 1 && opened[0] === 'live-workbench', `点击入口调用 openTab('live-workbench')`);

const narrow = foot.component({ wide: false });
ok(narrow.children.length === 2 && narrow.children[1] === null, '侧栏收起时只显示图标');

// 图标必须是茶叶 SVG，而不是一个汉字（「茶」在 15px 下像个小色块，也和旁边的 ◈ 不搭）
const icon = narrow.children[0];
ok(icon?.type === 'svg', `入口图标是 svg（实际 ${icon?.type}）`);
const iconPath = (icon?.children || [])[0];
ok(iconPath?.type === 'path' && /^M[\d.,\sCAZ-]+$/i.test(iconPath?.props?.d || ''), '图标里是一条叶子路径');
ok(icon?.props?.width === 15, `图标尺寸 ${icon?.props?.width}px`);
ok(!/茶/.test(JSON.stringify(icon)), '图标里没有汉字');

const bodyTree = bodySeat.component({});
const iframe = (bodyTree.children || []).find((c) => c && c.type === 'iframe');
ok(!!iframe, '页签内容渲染 iframe');
ok(iframe?.props?.src === '/live-workbench/', `iframe 指向 ${iframe?.props?.src}`);
ok((iframe.props.src || '').startsWith('/'), 'iframe 用同源绝对路径（避免挂载点漂移）');

/* --- 已打开时再点应当关闭而不是重复打开 --- */
opened.length = 0;
clientCtx.sidebarRight.active = () => ({ id: 'tab-1', kind: 'live-workbench' });
let closed = null;
clientCtx.sidebarRight.close = (id) => {
  closed = id;
};
loaded.apply(clientCtx);
const foot2 = slotRecords.filter((r) => r.options.name === 'sidebar.footer.action').pop();
foot2.component({ wide: true }).props.onClick();
ok(closed === 'tab-1' && opened.length === 0, '已打开时点击是关闭（不会重复开）');

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}`);
process.exitCode = failures === 0 ? 0 : 1;
