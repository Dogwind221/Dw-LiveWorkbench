/**
 * 租户上下文。
 *
 * ## 为什么用 AsyncLocalStorage 而不是给每个函数加 tenantId 参数
 *
 * 一次请求会穿过几十层函数：handler → loadKB → readJson → paths…
 * 如果给每一层都加 `tenantId` 参数：
 *   - 要改几十个函数签名
 *   - **漏改一个就是越权漏洞，而且是静默的**（读到了别人的数据也不会报错）
 *   - 现有 100 多项测试全部要改
 *
 * `AsyncLocalStorage` 让租户身份像"隐式参数"一样贯穿整个调用链，
 * 函数签名一个都不用改。代价是**隐式依赖**（看代码看不出数据来自哪个租户），
 * 所以必须配一条硬规则：
 *
 *   > **只有 `paths.mjs` 和 `store.mjs` 允许读租户上下文。业务模块一律不读。**
 *
 * 这条规则把"隐式"限制在 2 个文件里，其他代码仍然只看得到"路径"。
 *
 * ## 另一个硬规则：身份只能来自 token
 *
 * `runAsTenant` 的调用点必须是**解析 token 之后**，绝不能拿请求体里的 tenantId。
 * 否则改一个参数就能读别人的数据 —— 这是多租户最经典的越权入口。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 没有租户上下文时（CLI、测试、启动期）用这个。也是迁移后旧数据的归属。 */
export const DEFAULT_TENANT = 'default';

/**
 * 合法租户 id 白名单。
 *
 * 用**白名单**而不是"过滤掉 .."：黑名单永远漏（`..%2f`、`....//`、Unicode 变体…）。
 * 这个正则同时挡住了路径穿越和奇怪的注入。
 */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const storage = new AsyncLocalStorage();

/**
 * 在租户上下文里执行一段逻辑。
 *
 * @param {{tenantId: string, userId?: string, role?: string}} ctx
 * @param {Function} fn
 */
export function runAsTenant(ctx, fn) {
  const tenantId = assertTenantId(ctx?.tenantId);
  return storage.run({ ...ctx, tenantId }, fn);
}

/** 当前请求的完整上下文（含 userId / role），没有则 null。 */
export function tenantContext() {
  return storage.getStore() || null;
}

/**
 * 当前租户 id。
 *
 * 返回 `null` 表示**没有上下文**（CLI/测试/启动期），由调用方决定怎么兜底。
 * 注意这里**不**直接返回 default —— 让"没上下文"和"default 租户"保持可区分，
 * 否则将来做"必须带身份才能访问"的校验时，就分不出"没登录"和"登录成默认租户"了。
 */
export function currentTenantId() {
  const ctx = storage.getStore();
  return ctx?.tenantId ?? null;
}

/** 校验租户 id 合法性。不合法直接抛错 —— 宁可 500，也不要静默降级到默认租户。 */
export function assertTenantId(id) {
  const s = String(id ?? '');
  if (!TENANT_ID_RE.test(s)) {
    const err = new Error(`非法租户 id：${JSON.stringify(s).slice(0, 40)}（只允许小写字母数字、- 和 _，2-32 位）`);
    err.code = 'BAD_TENANT_ID';
    throw err;
  }
  return s;
}

/** 是否合法租户 id（不抛错的版本，给校验用）。 */
export function isValidTenantId(id) {
  return TENANT_ID_RE.test(String(id ?? ''));
}

/** 测试用：清空上下文（在 runAsTenant 之外本来就没有，这里只是显式表达意图）。 */
export function withDefaultTenant(fn) {
  return runAsTenant({ tenantId: DEFAULT_TENANT }, fn);
}
