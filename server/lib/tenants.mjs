/**
 * 租户注册表。
 *
 * `data/tenants.json` 是**平台级**文件（不属于任何租户）—— 它要回答
 * "系统里到底有哪些租户"，这必须在任何租户上下文建立之前就能读。
 *
 * 这里只做"注册表"的事：列表、查询、启用/停用、配额。
 * 租户的**数据**在 `data/tenants/<id>/` 下，由 `paths.mjs` 解析。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_ROOT, tenantsFile } from './paths.mjs';
import { assertTenantId, isValidTenantId, DEFAULT_TENANT } from './tenant.mjs';

const TENANT_STATUS = ['active', 'disabled'];

function readRegistry() {
  try {
    const raw = fs.readFileSync(tenantsFile(), 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return { version: 1, tenants: [] };
    const j = JSON.parse(raw);
    return { version: j.version || 1, tenants: Array.isArray(j.tenants) ? j.tenants : [] };
  } catch {
    return { version: 1, tenants: [] };
  }
}

function writeRegistry(reg) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const tmp = `${tenantsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, tenantsFile());
}

export function listTenants() {
  return readRegistry().tenants;
}

/** 只返回启用中的租户。认证和路由应该只认这些。 */
export function listActiveTenants() {
  return listTenants().filter((t) => t.status !== 'disabled');
}

export function activeTenantCount() {
  return listActiveTenants().length;
}

export function getTenant(id) {
  return listTenants().find((t) => t.id === id) || null;
}

/** 租户是否可用（存在且未停用）。认证时用它做第二道检查。 */
export function isTenantActive(id) {
  const t = getTenant(id);
  return !!t && t.status !== 'disabled';
}

/**
 * 新增或更新租户。
 *
 * 注意：**只写注册表，不创建目录**。目录在首次写入时由 `store.writeJson` 的
 * `ensureDir` 兜底创建 —— 让"注册一个租户"和"给这个租户建一堆空目录"解耦。
 */
export function upsertTenant({ id, name, status = 'active', quota } = {}) {
  const tenantId = assertTenantId(id);
  if (!TENANT_STATUS.includes(status)) {
    const err = new Error(`非法租户状态：${status}（只允许 ${TENANT_STATUS.join(' / ')}）`);
    err.code = 'BAD_TENANT_STATUS';
    throw err;
  }
  const reg = readRegistry();
  const idx = reg.tenants.findIndex((t) => t.id === tenantId);
  const now = new Date().toISOString();
  const base = {
    id: tenantId,
    name: String(name || tenantId),
    status,
    quota: quota || { dailyCalls: 2000, monthlyTokens: 2000000 },
  };
  if (idx >= 0) {
    reg.tenants[idx] = { ...reg.tenants[idx], ...base, updatedAt: now };
  } else {
    reg.tenants.push({ ...base, createdAt: now });
  }
  writeRegistry(reg);
  return getTenant(tenantId);
}

/** 停用而不是删除：数据还在，只是不能再被认证通过。 */
export function disableTenant(id) {
  return upsertTenant({ ...(getTenant(id) || { id }), id, status: 'disabled' });
}

/**
 * 从注册表里**彻底移除**一个租户（不删数据目录）。
 *
 * 存在的意义有两个：管理员清理，以及测试跑完必须还原环境 ——
 * 否则注册表里多出两个租户，下次以"未开认证"启动时会被安全护栏拦住。
 * 注意拒绝删除 default：它是迁移后旧数据的归属，删了数据就"无主"了。
 */
export function removeTenant(id) {
  const tenantId = assertTenantId(id);
  if (tenantId === DEFAULT_TENANT) {
    const err = new Error(`不能移除 ${DEFAULT_TENANT} 租户（迁移保留的旧数据归属）`);
    err.code = 'CANNOT_REMOVE_DEFAULT';
    throw err;
  }
  const reg = readRegistry();
  const before = reg.tenants.length;
  reg.tenants = reg.tenants.filter((t) => t.id !== tenantId);
  writeRegistry(reg);
  return before - reg.tenants.length;
}

/** 确保 default 租户存在（迁移后首次启动、或误删时的自愈）。 */
export function ensureDefaultTenant() {
  if (getTenant(DEFAULT_TENANT)) return getTenant(DEFAULT_TENANT);
  return upsertTenant({ id: DEFAULT_TENANT, name: '默认租户（迁移保留）' });
}

/** 校验 id 但不做副作用 —— 供 HTTP 层在创建租户前先挡一道。 */
export { isValidTenantId };
