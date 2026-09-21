/**
 * 用户数据访问层（薄 repository，原生 SQL）。
 *
 * 铁律：所有查询都显式带 user_id 条件（多用户硬隔离的第一道闸）。
 */
import type { DbHandle } from '../db/connection.js';
import type { UserRole, UserStatus } from '@kb/shared';

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  username: string;
  /** 已哈希的密码（哈希在 service 层完成，repository 保持同步） */
  passwordHash: string;
  email?: string | null;
  role?: UserRole;
  status?: UserStatus;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 新增用户；用户名冲突会抛 SQLITE_CONSTRAINT，由调用方转换 */
export function createUser(db: DbHandle, input: CreateUserInput): UserRow {
  const row = db.driver.get<Pick<UserRow, 'id'>>(
    `INSERT INTO users (username, email, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ${NOW}, ${NOW})
     RETURNING id`,
    [input.username, input.email ?? null, input.passwordHash, input.role ?? 'user', input.status ?? 'active'],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建用户失败：未返回主键');
  return findUserById(db, id) as UserRow;
}

/** 按用户名查找（登录用） */
export function findByUsername(db: DbHandle, username: string): UserRow | undefined {
  return db.driver.get<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
}

/** 按邮箱查找（注册去重） */
export function findByEmail(db: DbHandle, email: string): UserRow | undefined {
  return db.driver.get<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
}

/** 按 id 查找 */
export function findUserById(db: DbHandle, id: number): UserRow | undefined {
  return db.driver.get<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

/** 更新密码哈希 */
export function updatePasswordHash(db: DbHandle, userId: number, passwordHash: string): void {
  db.driver.run(`UPDATE users SET password_hash = ?, updated_at = ${NOW} WHERE id = ?`, [
    passwordHash,
    userId,
  ]);
}

/** 更新角色 */
export function setRole(db: DbHandle, userId: number, role: UserRole): void {
  db.driver.run(`UPDATE users SET role = ?, updated_at = ${NOW} WHERE id = ?`, [role, userId]);
}

/** 更新状态 */
export function setStatus(db: DbHandle, userId: number, status: UserStatus): void {
  db.driver.run(`UPDATE users SET status = ?, updated_at = ${NOW} WHERE id = ?`, [status, userId]);
}

export interface UserCountFilter {
  status?: UserStatus;
  role?: UserRole;
  /** 按 username / email 模糊匹配 */
  q?: string;
}

/** 用户总数（默认无过滤；可用于判断是否首次启动、或按状态/角色/关键字过滤） */
export function countUsers(db: DbHandle, filter: UserCountFilter = {}): number {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.role) {
    where.push('role = ?');
    params.push(filter.role);
  }
  if (filter.q) {
    where.push('(username LIKE ? OR email LIKE ?)');
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  const row = db.driver.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM users${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    params,
  );
  return Number(row?.c ?? 0);
}

/** 是否存在管理员 */
export function hasAdmin(db: DbHandle): boolean {
  const row = db.driver.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
  return Number(row?.c ?? 0) > 0;
}

/** 列出用户（管理用途，带分页） */
export function listUsers(db: DbHandle, limit = 50, offset = 0): UserRow[] {
  return db.driver.all<UserRow>('SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?', [limit, offset]);
}

export interface ListUsersPageQuery {
  page: number;
  pageSize: number;
  status?: UserStatus;
  role?: UserRole;
  q?: string;
}

/** 分页列出用户（可按状态/角色/关键字过滤，q 按 username/email LIKE 模糊） */
export function listUsersPage(db: DbHandle, query: ListUsersPageQuery): UserRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.role) {
    where.push('role = ?');
    params.push(query.role);
  }
  if (query.q) {
    where.push('(username LIKE ? OR email LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }

  const pageSize = Math.min(Math.max(1, Math.trunc(query.pageSize)), 200);
  const page = Math.max(1, Math.trunc(query.page));
  const offset = (page - 1) * pageSize;

  return db.driver.all<UserRow>(
    `SELECT * FROM users${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
     ORDER BY id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
}

/** 把 UserRow 转成对外类型（剔除敏感字段） */
export function toPublicUser(row: UserRow): {
  id: number;
  username: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
} {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}
