/**
 * 知识库（文档分组）数据访问层。
 * 所有查询强制带 user_id —— 即使调用方传错 userId，也只会读到该用户自己的数据。
 */
import type { DbHandle } from '../db/connection.js';

export interface LibraryRow {
  id: number;
  user_id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 列出某用户的知识库（强制 user_id） */
export function listLibraries(db: DbHandle, userId: number): LibraryRow[] {
  return db.driver.all<LibraryRow>(
    'SELECT * FROM libraries WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    [userId],
  );
}

/** 按 id 查询（强制 user_id，越权访问返回 undefined） */
export function findLibraryById(db: DbHandle, userId: number, id: number): LibraryRow | undefined {
  return db.driver.get<LibraryRow>('SELECT * FROM libraries WHERE id = ? AND user_id = ?', [id, userId]);
}

/** 创建知识库 */
export function createLibrary(
  db: DbHandle,
  userId: number,
  name: string,
  description = '',
): LibraryRow {
  const row = db.driver.get<Pick<LibraryRow, 'id'>>(
    `INSERT INTO libraries (user_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ${NOW}, ${NOW}) RETURNING id`,
    [userId, name, description],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建知识库失败：未返回主键');
  return findLibraryById(db, userId, id) as LibraryRow;
}

/** 更新知识库（强制 user_id） */
export function updateLibrary(
  db: DbHandle,
  userId: number,
  id: number,
  patch: { name?: string; description?: string },
): LibraryRow | undefined {
  const existing = findLibraryById(db, userId, id);
  if (!existing) return undefined;
  db.driver.run(`UPDATE libraries SET name = ?, description = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ?`, [
    patch.name ?? existing.name,
    patch.description ?? existing.description,
    id,
    userId,
  ]);
  return findLibraryById(db, userId, id);
}

/** 删除知识库（强制 user_id） */
export function deleteLibrary(db: DbHandle, userId: number, id: number): boolean {
  const result = db.driver.run('DELETE FROM libraries WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

/** 统计某用户的知识库数量 */
export function countLibraries(db: DbHandle, userId: number): number {
  const row = db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM libraries WHERE user_id = ?', [userId]);
  return Number(row?.c ?? 0);
}
