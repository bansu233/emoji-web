'use strict';

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/database');
const {
  hashPassword,
  normalizeUsername,
  validateUsername,
  validatePassword,
} = require('../src/security');

async function main() {
  const [usernameArg, roleArg] = process.argv.slice(2);
  const password = process.env.NEW_USER_PASSWORD;
  const username = normalizeUsername(usernameArg);
  const role = roleArg || 'user';

  if (!username || !role) {
    console.error(
      '用法: NEW_USER_PASSWORD=你的密码 node scripts/create-user.js <用户名> <user|reviewer|admin>'
    );
    process.exitCode = 1;
    return;
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    console.error(usernameError);
    process.exitCode = 1;
    return;
  }
  if (!['user', 'reviewer', 'admin'].includes(role)) {
    console.error('角色只能是 user、reviewer 或 admin');
    process.exitCode = 1;
    return;
  }
  if (!password) {
    console.error('请通过 NEW_USER_PASSWORD 环境变量提供密码，避免密码出现在命令历史中。');
    process.exitCode = 1;
    return;
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    console.error(passwordError);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(process.env, { seedDemoAccounts: false });
  const db = openDatabase(config);
  try {
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(username);
    const passwordHash = await hashPassword(password);

    if (existing) {
      db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(
        passwordHash,
        role,
        existing.id
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
      console.log(`已更新账号 ${username}，角色 ${role}，并让已有会话全部失效。`);
    } else {
      db.prepare(
        'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
      ).run(username, passwordHash, role, new Date().toISOString());
      console.log(`已创建账号 ${username}，角色 ${role}。`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('操作失败:', error.message);
  process.exitCode = 1;
});
