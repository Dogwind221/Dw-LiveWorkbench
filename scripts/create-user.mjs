/**
 * 用户管理（命令行）。
 *
 * 为什么先做命令行而不是界面：登录本身才是第 11 周的重点，
 * "增删改用户"是低频操作，脚本够用且更容易审计（谁在什么时候加了人）。
 * 界面版排在后面。
 *
 * 用法：
 *   node scripts/create-user.mjs                           # 列出所有用户
 *   node scripts/create-user.mjs alice --role editor       # 创建 alice（随机密码）
 *   node scripts/create-user.mjs alice --role approver --admin
 *   node scripts/create-user.mjs alice --password          # 重置为随机密码
 *   node scripts/create-user.mjs alice --disable           # 停用（同时踢掉会话）
 *   node scripts/create-user.mjs alice --enable            # 启用
 *   node scripts/create-user.mjs alice --delete            # 删除
 *
 * 选项：
 *   --role <viewer|editor|approver>   默认 editor
 *   --tenant <id>                     默认 default
 *   --admin                           标记为管理员
 *   --label "<说明>"
 */
import crypto from 'node:crypto';

import {
  listUsers,
  createUser,
  getUserByUsername,
  setPassword,
  setUserStatus,
  removeUser,
  isValidUsername,
} from '../server/lib/users.mjs';
import { ROLES } from '../server/lib/auth.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const username = positional[0] || '';

const randomPassword = () => crypto.randomBytes(9).toString('base64url');

function printUsers() {
  const users = listUsers();
  if (!users.length) {
    console.log('还没有任何用户。启动一次服务（WORKBENCH_AUTH=required）会自动创建 admin，');
    console.log('或者用：node scripts/create-user.mjs admin --role approver --admin');
    return;
  }
  console.log('');
  console.log(`  ${'用户名'.padEnd(16)}${'租户'.padEnd(12)}${'角色'.padEnd(10)}${'管理员'.padEnd(8)}${'状态'.padEnd(10)}最近登录`);
  console.log('  ' + '─'.repeat(76));
  for (const u of users) {
    console.log(
      `  ${u.username.padEnd(16)}${u.tenantId.padEnd(12)}${u.role.padEnd(10)}` +
      `${(u.isAdmin ? '是' : '-').padEnd(8)}${u.status.padEnd(10)}${u.lastLoginAt ? u.lastLoginAt.slice(0, 19) : '从未'}`
    );
  }
  console.log('');
}

/* ------------------------------------------------------------------ *
 * 无参数 / --list：列出用户
 * ------------------------------------------------------------------ */
if (!username || has('--list')) {
  printUsers();
  process.exit(0);
}

if (!isValidUsername(username)) {
  console.error(`✗ 用户名不合法：${JSON.stringify(username)}（2–32 位，只允许字母数字 . _ -）`);
  process.exit(1);
}

const existing = getUserByUsername(username);

/* ---- 删除 ---- */
if (has('--delete')) {
  if (!existing) {
    console.error(`✗ 用户不存在：${username}`);
    process.exit(1);
  }
  // removeUser 在领域层已经负责踢掉会话（不依赖调用方记得做）
  removeUser(existing.id);
  console.log(`✓ 已删除 ${username}（其所有会话已自动失效）`);
  process.exit(0);
}

/* ---- 停用 / 启用 ---- */
if (has('--disable') || has('--enable')) {
  if (!existing) {
    console.error(`✗ 用户不存在：${username}`);
    process.exit(1);
  }
  const status = has('--disable') ? 'disabled' : 'active';
  // setUserStatus 在领域层已经负责在停用时踢掉会话
  setUserStatus(existing.id, status);
  console.log(`✓ 已${status === 'disabled' ? '停用' : '启用'} ${username}` + (status === 'disabled' ? '（其所有会话已自动失效）' : ''));
  process.exit(0);
}

/* ---- 重置密码（只对已存在的用户）---- */
const pwGiven = valOf('--password');
if (has('--password') && existing) {
  const pw = pwGiven || randomPassword();
  setPassword(existing.id, pw);
  console.log(`✓ 已重置 ${username} 的密码：${pw}`);
  console.log('  （只显示这一次，请立即保存）');
  process.exit(0);
}
if (has('--password') && !existing && !pwGiven) {
  console.error(`✗ 用户不存在：${username}`);
  console.error('  要新建：去掉 --password，或用 --password <初始密码> 指定一个');
  console.error(`  例：node scripts/create-user.mjs ${username} --role approver --admin --password 你的密码`);
  process.exit(1);
}

/* ---- 创建 ---- */
if (existing) {
  console.error(`✗ 用户已存在：${username}`);
  console.error('  要重置密码加 --password；要停用加 --disable。');
  process.exit(1);
}

const role = valOf('--role', 'editor');
if (!ROLES.includes(role)) {
  console.error(`✗ 非法角色：${role}（只允许 ${ROLES.join(' / ')}）`);
  process.exit(1);
}
const tenantId = valOf('--tenant', 'default');
// 允许创建时直接指定密码（方便自己给自己开账号）；不指定就随机生成
const password = pwGiven || randomPassword();

try {
  const user = createUser({
    username,
    password,
    role,
    tenantId,
    isAdmin: has('--admin'),
    label: valOf('--label', ''),
  });
  console.log('');
  console.log(`✓ 已创建用户 ${user.username}`);
  console.log(`    租户：${user.tenantId}   角色：${user.role}   管理员：${user.isAdmin ? '是' : '否'}`);
  console.log(`    密  码：${password}`);
  console.log('  （只显示这一次，请立即保存）');
  console.log('');
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
