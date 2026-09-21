#!/usr/bin/env node
/**
 * 创建或重置管理员账号（需 tsx 运行，见根脚本 npm run create-admin）。
 * 用法：
 *   npm run create-admin                            # 默认 admin + 随机一次性密码
 *   npm run create-admin myadmin MyPass123          # 指定账号密码
 *   npm run create-admin myadmin MyPass123 --reset  # 重置已存在账号
 */
import { randomBytes } from 'node:crypto';

const { loadConfig } = await import('../packages/server/src/config.ts');
const { initDatabase, closeDatabase } = await import('../packages/server/src/db/connection.ts');
const { runMigrations } = await import('../packages/server/src/db/migrate.ts');
const { ensureAdmin } = await import('../packages/server/src/service/user-admin.ts');
const { findByUsername } = await import('../packages/server/src/repo/user.repo.ts');

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));
const reset = flags.includes('--reset');

const config = loadConfig();
const db = await initDatabase(config);
const migration = runMigrations(db, { embeddingDim: config.embedding.dim });
if (migration.applied.length > 0) {
  console.log(`[create-admin] 已执行迁移：${migration.applied.join(', ')}`);
}

const username = positional[0] || config.bootstrap.adminUser || 'admin';
const password = positional[1] || `kb-${randomBytes(6).toString('base64url')}`;

const existing = findByUsername(db, username);
if (existing && !reset) {
  console.log(`管理员「${username}」已存在（id=${existing.id}, role=${existing.role}）。`);
  console.log('如需重置密码，请追加 --reset 参数。');
  closeDatabase();
  process.exit(0);
}

const { user, created } = await ensureAdmin(db, username, password);

console.log('------------------------------------------');
console.log(`  用户名：${username}`);
console.log(`  密码　：${password}`);
console.log(`  角色　：${user.role}`);
console.log(`  id　　：${user.id}`);
console.log(`  操作　：${created ? '新建' : '重置密码'}`);
console.log(`  数据库：${config.db.path}`);
console.log('------------------------------------------');
console.log('若为随机一次性密码，请登录后立即修改。');

closeDatabase();
process.exit(0);
