/**
 * 普洱茶直播工作台 —— 独立进程入口。
 *
 * 只负责监听端口；所有路由都在 server/lib/handler.mjs 里，
 * 这样同一份实现既能独立跑，也能作为 DSH 插件挂在 GUI 里
 * （见 plugin/dsh-live-workbench/）。
 *
 * 多租户相关（Day 2）的三件事都在这里做启动检查：
 *   1. 确保 default 租户存在（迁移后首次启动 / 误删自愈）
 *   2. **安全护栏**：注册表里有 >1 个启用租户，但没开认证 → 拒绝启动
 *   3. 开了认证但一个 token 都没有 → 自动生成 owner token 并打印一次
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ROOT, DATA_ROOT, OUTPUT_ROOT, usersFile } from './lib/paths.mjs';
import { pptStatus } from './lib/ppt.mjs';
import { createWorkbenchHandler } from './lib/handler.mjs';
import { ensureDefaultTenant, activeTenantCount, listActiveTenants } from './lib/tenants.mjs';
import { authRequired, authMode } from './lib/auth.mjs';
import { ensureBootstrapAdmin } from './lib/users.mjs';

const PORT = Number(process.env.PORT || process.argv[2] || 8788);
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 绑定到 `0.0.0.0` = 局域网可访问（手机、别的电脑）。
 *
 * 默认仍是 `127.0.0.1`（只有本机能连）—— 因为**默认开放是个错误**：
 * 用户只是想自己用，却在不知情的情况下把工作台暴露给了整个 WiFi。
 * 想开放得显式设 `HOST=0.0.0.0`，或者双击 `启动-局域网.bat`。
 */
const LAN = HOST === '0.0.0.0' || HOST === '::';

/**
 * 枚举本机局域网 IPv4 地址，用来打印"手机上输哪个网址"。
 *
 * 一台电脑常有多个地址（WiFi、网线、Hyper-V、VMware、WSL…），
 * 直接全列出来用户会懵。所以：
 *   - `192.168.*` 最可能是家里/店里的路由器网段 → 排最前
 *   - 虚拟网卡（vEthernet/VMware/VirtualBox…）基本用不上 → 排最后并标注
 */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        out.push({
          name,
          address: a.address,
          virtual: /vEthernet|VMware|VirtualBox|Hyper-V|Default Switch|WSL|Tailscale|ZeroTier|vgate|Loopback/i.test(name),
        });
      }
    }
  }
  const rank = (x) => {
    if (x.virtual) return 10;
    if (/^192\.168\./.test(x.address)) return 0;
    if (/^10\./.test(x.address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(x.address)) return 2;
    return 3;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/* ------------------------------------------------------------------ *
 * 启动期检查
 * ------------------------------------------------------------------ */
ensureDefaultTenant();

/**
 * 安全护栏：**多租户 + 无认证 = 拒绝启动**。
 *
 * 理由：这是唯一一个"看起来能跑、实际上所有人都在同一个租户里"的配置。
 * 不做护栏的话，用户建了 tenant_b 却忘了开认证，所有数据会写进 default，
 * 而且不会有任何报错 —— 这种静默失败比启动失败危险得多。
 */
const tenantCount = activeTenantCount();
if (tenantCount > 1 && !authRequired()) {
  console.error('');
  console.error('  ✗ 拒绝启动：检测到多个启用租户，但没有开启身份认证');
  console.error('');
  console.error(`    当前启用租户（${tenantCount} 个）：${listActiveTenants().map((t) => t.id).join(', ')}`);
  console.error('    没有认证时，所有请求都会落到 default 租户 —— 多租户等于没做。');
  console.error('');
  console.error('    开启方式（PowerShell）：');
  console.error('      $env:WORKBENCH_AUTH = "required"');
  console.error('      node server/index.mjs');
  console.error('');
  process.exit(1);
}

// 开了认证但一个用户都没有：自动创建管理员并打印账号密码（Jupyter 的成熟做法）。
// 否则"开了认证但进不去"，唯一出路是手改 JSON。
//
// 为什么不再自动生成 API token：两种凭据同时打印会让人困惑"我该记哪个"。
// 浏览器登录用账号密码；脚本/集成用的 token 由 `node scripts/create-token.mjs` 显式创建。
const adminBootstrap = authRequired() ? ensureBootstrapAdmin() : null;

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
const server = http.createServer(createWorkbenchHandler());

server.listen(PORT, HOST, () => {
  // 绑 0.0.0.0 时不能直接打印 http://0.0.0.0:8788 —— 那个地址浏览器打不开。
  // 要打印本机地址 + 每个可用的局域网地址。
  const localUrl = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  普洱茶直播工作台已启动');
  if (LAN) {
    console.log(`  → 本机：${localUrl}`);
    const addrs = lanAddresses();
    if (addrs.length) {
      console.log('  → 局域网（同一 WiFi 的手机 / 别的电脑，在地址栏输下面这个）：');
      for (const a of addrs) {
        const tag = a.virtual ? '  ← 虚拟网卡，一般不用这个' : '';
        console.log(`        http://${a.address}:${PORT}      (${a.name})${tag}`);
      }
      const real = addrs.filter((a) => !a.virtual);
      if (real.length > 1) {
        console.log('  ℹ 有多条可用地址时，优先试最上面那个（192.168 开头通常是家里的路由器网段）');
      }
    } else {
      console.log('  ⚠ 没找到局域网地址：这台机器可能没连 WiFi/网线');
    }
  } else {
    console.log(`  → ${localUrl}      （只有本机能访问）`);
    console.log('  ℹ 想让手机/别的电脑也能看：用「启动-局域网.bat」，或设 HOST=0.0.0.0');
  }
  console.log(`  数据目录：${DATA_ROOT}（各租户在 tenants/ 下）`);
  console.log(`  导出目录：${OUTPUT_ROOT}（各租户在 tenants/ 下）`);
  console.log(`  认证模式：${authMode() === 'required' ? '✓ 已开启（浏览器需登录，API 需要 Bearer token 或会话）' : LAN ? '⚠ 本地模式（未开启认证）' : '本地模式（未开启认证，单用户）'}`);

  // 局域网 + 无认证 = 同一 WiFi 下任何人都能改数据。必须明确警告，不能静默。
  if (LAN && !authRequired()) {
    console.log('');
    console.log('  ⚠⚠ 安全提醒：当前是「局域网可访问 + 未开启认证」');
    console.log('     同一 WiFi 下的任何人（包括蹭网的）都能打开并修改你的数据。');
    console.log('     只是自己用手机演示，一般可以接受；');
    console.log('     给别人看之前，建议先建账号再带认证启动：');
    console.log('       node scripts/create-user.mjs owner --role approver --admin --password 你的密码');
    console.log('       然后设 $env:WORKBENCH_AUTH="required" 再启动');
  }

  if (adminBootstrap) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │ 已创建初始管理员（密码只显示这一次，请立即保存）              │');
    console.log('  └──────────────────────────────────────────────────────────────┘');
    console.log(`    用户名：${adminBootstrap.user.username}`);
    console.log(`    密  码：${adminBootstrap.password}`);
    console.log('');
    console.log(`  登录地址：${url}/login`);
    console.log(`  账号已写入：${usersFile()}（密码用 scrypt 加盐哈希，明文不落盘）`);
    console.log('  忘了密码：node scripts/create-user.mjs --password admin');
  }

  if (authMode() === 'required') {
    console.log('');
    console.log('  需要给脚本/集成用 API token 时：node scripts/create-token.mjs <用户名>');
  }

  const py = pptStatus();
  console.log(`  PPT 引擎：${py.ok ? `可用（python-pptx ${py.pptx}）` : '不可用 —— ' + py.error}`);
  console.log('');
});
