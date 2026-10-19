/**
 * 给用户创建一个 API token（给脚本 / 集成用）。
 *
 * 浏览器用账号密码登录；token 是给程序用的"长期 API key"。
 * 两者最终都归约成同一份身份 `{ tenantId, userId, role }`。
 *
 * 用法：
 *   node scripts/create-token.mjs <用户名>
 *   node scripts/create-token.mjs alice --label "CI 机器人"
 *   node scripts/create-token.mjs --list          # 看已有 token 的元数据（不含明文）
 */
import { getUserByUsername, listUsers } from '../server/lib/users.mjs';
import { createToken, listTokens } from '../server/lib/auth.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (has('--list')) {
  const tokens = listTokens();
  if (!tokens.length) {
    console.log('还没有任何 token。');
    process.exit(0);
  }
  console.log('');
  console.log(`  ${'tokenId'.padEnd(20)}${'租户'.padEnd(12)}${'用户'.padEnd(16)}${'角色'.padEnd(10)}说明`);
  console.log('  ' + '─'.repeat(80));
  for (const t of tokens) {
    console.log(
      `  ${t.id.padEnd(20)}${t.tenantId.padEnd(12)}${t.userId.padEnd(16)}${t.role.padEnd(10)}${t.label || '-'}`
    );
  }
  console.log('');
  console.log('  撤销：node -e "..." 或调用 revokeToken({id})（见 README-multitenant.md）');
  process.exit(0);
}

const username = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) || '';
if (!username) {
  console.error('用法：node scripts/create-token.mjs <用户名> [--label "说明"]');
  console.error('      node scripts/create-token.mjs --list');
  console.error('');
  console.error('现有用户：');
  for (const u of listUsers()) console.error(`  ${u.username}（${u.tenantId} / ${u.role}）`);
  process.exit(1);
}

const user = getUserByUsername(username);
if (!user) {
  console.error(`✗ 用户不存在：${username}`);
  console.error('  先创建用户：node scripts/create-user.mjs <用户名> --role editor');
  process.exit(1);
}
if (user.status === 'disabled') {
  console.error(`✗ 用户 ${username} 已停用，不能发 token`);
  process.exit(1);
}

const { raw, record } = createToken({
  tenantId: user.tenantId,
  userId: user.username,
  role: user.role,
  label: valOf('--label', `for ${user.username}`),
});

console.log('');
console.log(`✓ 已为 ${user.username} 创建 token（只显示这一次）`);
console.log(`    ${raw}`);
console.log('');
console.log(`    租户：${record.tenantId}   角色：${record.role}   tokenId：${record.id}`);
console.log('');
console.log('  用法：');
console.log(`    curl -H "Authorization: Bearer ${raw.slice(0, 10)}…" http://127.0.0.1:8788/api/kb`);
console.log('');
console.log('  ⚠ 明文不落盘（只存 sha256），丢了就撤销重建。');
