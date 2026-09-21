/**
 * 鉴权服务：注册 / 登录 / 登出 / 令牌校验。
 * 密码哈希与 JWT 在 util/crypto.ts，本层只做业务编排与错误语义。
 */
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import {
  findByEmail,
  findByUsername,
  findUserById,
  createUser,
  toPublicUser,
  updatePasswordHash,
  type UserRow,
} from '../repo/user.repo.js';
import { getGuard, recordFailure, resetGuard } from '../repo/login-guard.repo.js';
import { extractBearerToken, hashPassword, signJwt, verifyJwt, verifyPassword } from '../util/crypto.js';
import { USERNAME_MAX, USERNAME_MIN, USERNAME_PATTERN, PASSWORD_MIN, PASSWORD_MAX } from '@kb/shared';

export interface AuthContext {
  db: DbHandle;
  config: AppConfig;
}

export interface AuthResult {
  user: ReturnType<typeof toPublicUser>;
  token: string;
  expiresIn: number;
}

export class AuthError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 用户名合法性校验 */
export function validateUsername(username: string): void {
  const value = String(username ?? '').trim();
  if (value.length < USERNAME_MIN || value.length > USERNAME_MAX) {
    throw new AuthError('INVALID_USERNAME', `用户名长度需为 ${USERNAME_MIN}-${USERNAME_MAX} 个字符`);
  }
  if (!USERNAME_PATTERN.test(value)) {
    throw new AuthError('INVALID_USERNAME', '用户名只能包含字母、数字、下划线和连字符');
  }
}

/** 密码强度校验 */
export function validatePassword(password: string): void {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new AuthError('WEAK_PASSWORD', `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`);
  }
}

/** 注册 */
export async function register(
  ctx: AuthContext,
  input: { username: string; password: string; email?: string | null },
): Promise<AuthResult> {
  if (!ctx.config.auth.allowRegister) {
    throw new AuthError('REGISTER_DISABLED', '当前系统未开放注册', 403);
  }

  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  const email = input.email ? String(input.email).trim().toLowerCase() : null;

  validateUsername(username);
  validatePassword(password);

  if (findByUsername(ctx.db, username)) {
    throw new AuthError('USERNAME_TAKEN', '用户名已被占用', 409);
  }
  if (email && findByEmail(ctx.db, email)) {
    throw new AuthError('EMAIL_TAKEN', '邮箱已被占用', 409);
  }

  const passwordHash = await hashPassword(password);
  const row = createUser(ctx.db, { username, passwordHash, email, role: 'user' });
  return issueToken(ctx, row);
}

/** 登录（含限流锁定：锁检查在查库之前，避免时序侧信道） */
export async function login(
  ctx: AuthContext,
  input: { username: string; password: string },
): Promise<AuthResult> {
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '');
  if (!username || !password) {
    throw new AuthError('INVALID_CREDENTIALS', '用户名或密码不能为空', 400);
  }

  const key = username.toLowerCase();
  const maxAttempts = ctx.config.auth.loginMaxAttempts;
  const lockMinutes = ctx.config.auth.loginLockMinutes;

  // 锁检查在查库之前：不区分用户是否存在，避免通过时序探测用户名
  const guard = getGuard(ctx.db, key);
  if (guard?.locked_until) {
    const lockedUntilMs = new Date(guard.locked_until).getTime();
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now()) {
      const remainingMin = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 60000));
      throw new AuthError('LOGIN_LOCKED', `尝试过于频繁，请 ${remainingMin} 分钟后重试`, 429);
    }
    // 锁已过期：清空计数，重新开始
    resetGuard(ctx.db, key);
  }

  const row = findByUsername(ctx.db, username);
  // 用户不存在时也执行一次哈希，避免通过响应时间枚举用户名
  if (!row) {
    await hashPassword(password);
    const updated = recordFailure(ctx.db, key, maxAttempts, lockMinutes);
    if (updated.locked_until) throw new AuthError('LOGIN_LOCKED', `尝试过于频繁，请 ${lockMinutes} 分钟后重试`, 429);
    throw new AuthError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  }
  if (row.status !== 'active') {
    throw new AuthError('USER_DISABLED', '账号已被禁用', 403);
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const updated = recordFailure(ctx.db, key, maxAttempts, lockMinutes);
    if (updated.locked_until) {
      throw new AuthError('LOGIN_LOCKED', `尝试过于频繁，请 ${lockMinutes} 分钟后重试`, 429);
    }
    throw new AuthError('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  }

  resetGuard(ctx.db, key);
  return issueToken(ctx, row);
}

/** 修改密码：校验原密码 -> 校验新密码策略 -> 更新哈希 */
export async function changePassword(
  ctx: AuthContext,
  userId: number,
  input: { oldPassword: string; newPassword: string },
): Promise<void> {
  const row = findUserById(ctx.db, userId);
  if (!row) throw new AuthError('USER_NOT_FOUND', '用户不存在', 404);

  const oldOk = await verifyPassword(String(input.oldPassword ?? ''), row.password_hash);
  if (!oldOk) throw new AuthError('INVALID_OLD_PASSWORD', '原密码不正确', 400);

  validatePassword(String(input.newPassword ?? ''));
  updatePasswordHash(ctx.db, userId, await hashPassword(String(input.newPassword)));
}

/** 签发 token */
export function issueToken(ctx: AuthContext, row: UserRow): AuthResult {
  const { token } = signJwt(
    { sub: String(row.id), username: row.username, role: row.role },
    ctx.config.auth.jwtSecret,
    ctx.config.auth.jwtExpiresInSec,
  );
  return { user: toPublicUser(row), token, expiresIn: ctx.config.auth.jwtExpiresInSec };
}

/**
 * 登出：把 jti 加入黑名单（JWT 无状态，只在服务端记录已失效的 jti）。
 * 同时清理过期记录，避免表无限增长。
 */
export function logout(ctx: AuthContext, token: string | null): boolean {
  if (!token) return false;
  const payload = verifyJwt(token, ctx.config.auth.jwtSecret);
  if (!payload) return false;
  const now = Math.floor(Date.now() / 1000);
  ctx.db.driver.run('INSERT OR REPLACE INTO token_denylist (jti, user_id, expires_at) VALUES (?, ?, ?)', [
    payload.jti,
    Number(payload.sub),
    payload.exp,
  ]);
  ctx.db.driver.run('DELETE FROM token_denylist WHERE expires_at < ?', [now]);
  return true;
}

/** jti 是否已被登出 */
export function isTokenRevoked(ctx: AuthContext, jti: string): boolean {
  const row = ctx.db.driver.get<{ jti: string }>('SELECT jti FROM token_denylist WHERE jti = ?', [jti]);
  return row !== undefined;
}

/** 从 Authorization 头解析出当前用户（供 HTTP 钩子使用） */
export function resolveUserFromHeader(ctx: AuthContext, header: string | undefined | null): UserRow | null {
  const token = extractBearerToken(header);
  if (!token) return null;
  const payload = verifyJwt(token, ctx.config.auth.jwtSecret);
  if (!payload) return null;
  if (isTokenRevoked(ctx, payload.jti)) return null;
  const row = findUserById(ctx.db, Number(payload.sub));
  if (!row || row.status !== 'active') return null;
  return row;
}

/** 供 bootstrap 使用：创建初始管理员 */
export async function createBootstrapAdmin(ctx: AuthContext): Promise<UserRow | null> {
  const { adminUser, adminPass } = ctx.config.bootstrap;
  if (!adminUser || !adminPass) return null;
  if (findByUsername(ctx.db, adminUser)) return null;
  const passwordHash = await hashPassword(adminPass);
  return createUser(ctx.db, { username: adminUser, passwordHash, email: null, role: 'admin' });
}
