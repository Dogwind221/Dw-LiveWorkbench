/**
 * 直播工作台 —— DSH 插件「宿主半边」。
 *
 * 职责只有一个：把工作台的 HTTP 处理器挂到 GUI 的同源路径 `/live-workbench`
 * 上。这样左下角的入口就能用 iframe 嵌入工作台，且和 GUI 同源，没有跨域问题。
 *
 * 工作台的实现仍然只有一份：server/lib/handler.mjs。独立进程模式
 * （node server/index.mjs）和插件模式共用它，不存在两套路由。
 *
 * 客户端半边在 client/client.js：往侧栏底部（左下角）加一个入口。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 静态 import —— 这是为了让 HMR 能顺着依赖链替换工作台代码。
 *
 * 历史（2026-10-23 修正）：
 * 早期这里用的是「动态 import + `?v=timestamp` 缓存穿透」，理由是 Node 的
 * ESM 缓存按 URL 记账、碰补丁重跑 apply() 时静态 import 不会重新求值。
 *
 * 但这条路有两个天花板，见 deepseek-ai/deepseek-harness Discussion #10774
 * （维护者 Caldera 回复 + Node 22.23.4 / 26.12.1 实测）：
 *   1. 改被 import 文件的 URL **不会**改它静态 import 的 URL——
 *      `handler.mjs?v=2` 会重新求值 handler，但 handler import 的十几个
 *      server/lib/*.mjs 兄弟仍读旧实例。工作台恰恰是多文件依赖，所以
 *      「带 query 就算真重载」是假的。
 *   2. DSH 的模块替换路径**沿静态 import 链接走**；只有静态 import 才给
 *      HMR 一条回到插件的依赖路径。
 *
 * 因此：改为静态 import，并配合 profile 里的 `hmr` 条目
 * （`config.base: 'file:///F:/dsh/直播工作台/'`，见 ~/.dsh/profiles/<profile>/cordis.patch.yml）
 * 让源码编辑本身成为重载触发，而不是碰补丁文件。
 *
 * 代价：handler 模块求值失败会直接让插件加载失败（而不是被 catch 住）。
 * 这是刻意的「失败要响」——静默失败比报错更难查。
 */
import { createWorkbenchHandler } from '../../../server/lib/handler.mjs';

/** Cordis 插件名（Loader 行标识，不是客户端包名）。 */
export const name = 'live-workbench';

/** 只需要 webServer：不碰模型、不碰会话、不碰连接。 */
export const inject = ['webServer'];

/** 挂载前缀。改这里要同步改 client/client.js 里的 WORKBENCH_URL。 */
export const ROUTE_PATH = '/live-workbench';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUS_FILE = join(HERE, '..', '.activation.log');

/**
 * 激活留痕。
 *
 * 存在的意义是「可自证」：插件是否真的被宿主加载，过去只能靠翻宿主日志或
 * 猜；写一行本地记录后，任何脚本都能直接确认，排障也不用重启 GUI。
 * @param {string} line
 */
function breadcrumb(line) {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    appendFileSync(STATUS_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 留痕失败不能影响插件本身 */
  }
}

/**
 * @param {object} ctx Cordis 上下文（用到的只有 effect 与 webServer）。
 * @param {{basePath?: string}} [config]
 */
export function apply(ctx, config) {
  const basePath = (config && config.basePath) || ROUTE_PATH;

  ctx.effect(() => {
    let disposeRoute = () => {};

    // 处理器已是静态 import：这里直接构造，注册失败只影响本次挂载，
    // 但模块加载失败会让插件整体报错（见文件顶部说明）。
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: basePath,
        handler: createWorkbenchHandler({ basePath }),
      });
      breadcrumb(`activated basePath=${basePath}`);
    } catch (error) {
      breadcrumb(`activate failed: ${error && error.message}`);
      console.error('[live-workbench] 工作台路由注册失败：', error);
    }

    return () => {
      breadcrumb(`disposed basePath=${basePath}`);
      disposeRoute();
    };
  }, 'live-workbench: workbench route');

  breadcrumb(`apply() basePath=${basePath}`);
}
