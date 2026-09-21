/**
 * 启动引导：首次运行时创建初始管理员。
 * 只在「系统内一个用户都没有」且配置了 BOOTSTRAP_ADMIN_PASS 时执行。
 */
import type { AppConfig } from './config.js';
import type { DbHandle } from './db/connection.js';
import { countUsers, createUser, findByUsername, type UserRow } from './repo/user.repo.js';
import { hashPassword } from './util/crypto.js';

/** 仅依赖最小日志接口，避免与 pino 具体类型耦合 */
export interface BootstrapLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface BootstrapContext {
  db: DbHandle;
  config: AppConfig;
  logger: BootstrapLogger;
}

/** 系统内是否存在用户 */
export function hasAnyUser(db: DbHandle): boolean {
  return countUsers(db) > 0;
}

/**
 * 创建初始管理员。
 * 返回创建的用户；已存在用户 / 未配置密码时返回 null（不覆盖既有账号）。
 */
export async function createBootstrapAdmin(ctx: BootstrapContext): Promise<UserRow | null> {
  const { adminUser, adminPass } = ctx.config.bootstrap;
  if (!adminUser || !adminPass) return null;
  if (hasAnyUser(ctx.db)) return null;
  if (findByUsername(ctx.db, adminUser)) return null;

  const passwordHash = await hashPassword(adminPass);
  const user = createUser(ctx.db, { username: adminUser, passwordHash, email: null, role: 'admin' });
  ctx.logger.warn({ username: user.username }, 'bootstrap admin created');
  return user;
}
