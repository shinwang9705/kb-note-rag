/**
 * 管理员账号管理（CLI 复用 + HTTP 管理接口共用）。
 * 独立成文件，避免 scripts/ 直接依赖同步的 repository API。
 */
import { randomBytes } from 'node:crypto';
import type { AdminUserItem, UserRole } from '@kb/shared';
import type { DbHandle } from '../db/connection.js';
import {
  countUsers,
  createUser,
  findByEmail,
  findUserById,
  findByUsername,
  listUsersPage as listUsersPageRepo,
  setRole,
  setStatus,
  updatePasswordHash,
  type UserRow,
} from '../repo/user.repo.js';
import { docCountByUser } from '../repo/usage.repo.js';
import { hashPassword } from '../util/crypto.js';
import { validatePassword, validateUsername } from './auth.service.js';
import { ApiError } from '../http/errors.js';

const DEFAULT_ADMIN_ROLE = 'admin' as const;

/** 创建管理员；已存在时返回 null */
export async function createAdmin(
  db: DbHandle,
  input: { username: string; password: string; email?: string | null },
): Promise<UserRow | null> {
  if (findByUsername(db, input.username)) return null;
  const passwordHash = await hashPassword(input.password);
  return createUser(db, {
    username: input.username,
    passwordHash,
    email: input.email ?? null,
    role: DEFAULT_ADMIN_ROLE,
  });
}

/** 重置管理员密码并恢复为启用状态；用户不存在时返回 null */
export async function resetAdminPassword(
  db: DbHandle,
  username: string,
  password: string,
): Promise<UserRow | null> {
  const row = findByUsername(db, username);
  if (!row) return null;
  updatePasswordHash(db, row.id, await hashPassword(password));
  setRole(db, row.id, DEFAULT_ADMIN_ROLE);
  setStatus(db, row.id, 'active');
  return row;
}

/** 确保管理员存在：不存在则创建，存在则重置密码 */
export async function ensureAdmin(
  db: DbHandle,
  username: string,
  password: string,
): Promise<{ user: UserRow; created: boolean }> {
  const existing = findByUsername(db, username);
  if (existing) {
    updatePasswordHash(db, existing.id, await hashPassword(password));
    setRole(db, existing.id, DEFAULT_ADMIN_ROLE);
    setStatus(db, existing.id, 'active');
    return { user: existing, created: false };
  }
  const created = await createAdmin(db, { username, password });
  if (!created) {
    throw new Error(`创建管理员失败：${username}`);
  }
  return { user: created, created: true };
}

/** 生成随机强密码（12 位，含大小写字母/数字/符号，去除易混淆字符） */
export function generateRandomPassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[(bytes[i] ?? 0) % chars.length];
  }
  return out;
}

/** UserRow -> 管理员列表项（附带文档数） */
function toAdminItem(row: UserRow, docCount: number): AdminUserItem {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    docCount,
    createdAt: row.created_at,
  };
}

export interface ListUsersPageInput {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
}

export interface ListUsersPageResult {
  items: AdminUserItem[];
  total: number;
}

/** 管理员分页列表（拼 docCount，不含任何文档内容） */
export function listUsersPage(db: DbHandle, input: ListUsersPageInput): ListUsersPageResult {
  const status = input.status === 'active' || input.status === 'disabled' ? input.status : undefined;
  const q = input.q?.trim() || undefined;

  const rows = listUsersPageRepo(db, {
    page: input.page,
    pageSize: input.pageSize,
    status,
    q,
  });
  const total = countUsers(db, { status, q });
  const docCounts = docCountByUser(db, rows.map((row) => row.id));

  return {
    items: rows.map((row) => toAdminItem(row, docCounts.get(row.id) ?? 0)),
    total,
  };
}

export interface SetUserStatusInput {
  operatorId: number;
  targetId: number;
  status: 'active' | 'disabled';
}

/** 启用/禁用用户；防自禁 + 防禁最后一个启用状态管理员 */
export function setUserStatus(db: DbHandle, input: SetUserStatusInput): UserRow {
  const target = findUserById(db, input.targetId);
  if (!target) throw new ApiError('USER_NOT_FOUND', '用户不存在', 404);

  if (input.targetId === input.operatorId) {
    throw new ApiError('CANNOT_DISABLE_SELF', '不能修改自己的账号状态', 409);
  }

  if (input.status === 'disabled' && target.role === 'admin') {
    const activeAdmins = countUsers(db, { role: 'admin', status: 'active' });
    if (activeAdmins <= 1) {
      throw new ApiError('CANNOT_DISABLE_LAST_ADMIN', '不能禁用最后一个启用状态的管理员', 409);
    }
  }

  setStatus(db, input.targetId, input.status);
  return findUserById(db, input.targetId) as UserRow;
}

export interface ResetUserPasswordInput {
  password?: string;
}

/** 重置密码：缺省生成一次性随机密码并返回；重置后恢复 active */
export async function resetUserPassword(
  db: DbHandle,
  targetId: number,
  input: ResetUserPasswordInput,
): Promise<{ user: UserRow; initialPassword?: string }> {
  const target = findUserById(db, targetId);
  if (!target) throw new ApiError('USER_NOT_FOUND', '用户不存在', 404);

  let plain: string;
  let generated: string | undefined;
  if (input.password) {
    validatePassword(input.password);
    plain = input.password;
  } else {
    generated = generateRandomPassword();
    plain = generated;
  }

  updatePasswordHash(db, targetId, await hashPassword(plain));
  setStatus(db, targetId, 'active');
  const user = findUserById(db, targetId) as UserRow;
  return generated ? { user, initialPassword: generated } : { user };
}

export interface CreateUserByAdminInput {
  username: string;
  password?: string;
  role?: UserRole;
  email?: string | null;
}

/** 管理员建号：未给密码时生成一次性随机密码返回 */
export async function createUserByAdmin(
  db: DbHandle,
  input: CreateUserByAdminInput,
): Promise<{ user: UserRow; initialPassword?: string }> {
  const username = String(input.username ?? '').trim();
  const email = input.email ? String(input.email).trim().toLowerCase() : null;

  validateUsername(username);
  if (findByUsername(db, username)) {
    throw new ApiError('USER_EXISTS', '用户名已被占用', 409);
  }
  if (email && findByEmail(db, email)) {
    throw new ApiError('EMAIL_TAKEN', '邮箱已被占用', 409);
  }

  let plain: string;
  let generated: string | undefined;
  if (input.password) {
    validatePassword(input.password);
    plain = input.password;
  } else {
    generated = generateRandomPassword();
    plain = generated;
  }

  const passwordHash = await hashPassword(plain);
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';
  const user = createUser(db, { username, passwordHash, email, role, status: 'active' });
  return generated ? { user, initialPassword: generated } : { user };
}
