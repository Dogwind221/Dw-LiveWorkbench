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
 * 工作台处理器用**动态 import + 缓存穿透**加载，而不是静态 import。
 *
 * 原因：Node 的 ESM 模块缓存按解析后的 URL 记账。触碰 cordis.patch.yml 触发 HMR 时，
 * Cordis 会重新调用 apply()，但静态 import 的 `server/` 代码命中缓存、不会重新求值 ——
 * 于是「改完后端碰一下补丁就生效」是假的，GUI 里跑的还是旧引擎。
 * 带一个变化的 query 就能拿到全新模块实例，重载才是真的重载。
 *
 * 代价：每次重载多一份模块实例（忽略不计）。
 */
const HANDLER_URL = new URL('../../../server/lib/handler.mjs', import.meta.url).href;

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
    let disposed = false;
    let disposeRoute = () => {};

    // 带 query 的动态 import：每次重载都拿到全新模块实例（见 HANDLER_URL 的说明）
    import(`${HANDLER_URL}?v=${Date.now()}`)
      .then(({ createWorkbenchHandler }) => {
        if (disposed) return; // 加载期间被卸载：别把路由留给下一个实例
        disposeRoute = ctx.webServer.register({
          kind: 'prefix',
          path: basePath,
          handler: createWorkbenchHandler({ basePath }),
        });
        breadcrumb(`activated basePath=${basePath}`);
      })
      .catch((error) => {
        breadcrumb(`activate failed: ${error && error.message}`);
        console.error('[live-workbench] 工作台处理器加载失败：', error);
      });

    return () => {
      disposed = true;
      breadcrumb(`disposed basePath=${basePath}`);
      disposeRoute();
    };
  }, 'live-workbench: workbench route');

  breadcrumb(`apply() basePath=${basePath}`);
}
