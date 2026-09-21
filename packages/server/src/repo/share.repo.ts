/**
 * 知识库只读共享数据访问层（四期 T04）。
 *
 * 隔离模型（关键）：共享**不放松** WHERE user_id=? —— 本表只记录 (library_id, created_by)，
 * 检索仍以 created_by（token 声明的库主）的 user_id 为边界。写入/删除/修改路径完全不变。
 */
import type { DbHandle } from '../db/connection.js';

export interface ShareRow {
  id: number;
  library_id: number;
  token: string;
  created_by: number;
  expires_at: string | null;
  created_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 创建分享（expiresAt 为 ISO-8601 UTC，null = 永久） */
export function createShare(
  db: DbHandle,
  libraryId: number,
  createdBy: number,
  token: string,
  expiresAt: string | null,
): ShareRow {
  const row = db.driver.get<{ id: number }>(
    `INSERT INTO library_shares (library_id, token, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ${NOW}) RETURNING id`,
    [libraryId, token, createdBy, expiresAt],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建分享失败：未返回主键');
  return findShareByToken(db, token) as ShareRow;
}

/** 按 token 查询（不校验过期，过期判断在 service 层做，便于统一 404） */
export function findShareByToken(db: DbHandle, token: string): ShareRow | undefined {
  return db.driver.get<ShareRow>('SELECT * FROM library_shares WHERE token = ?', [token]);
}

/** 查询某知识库当前未过期的分享（用于「已分享则续期返回同 token」） */
export function findActiveShareByLibrary(db: DbHandle, libraryId: number): ShareRow | undefined {
  return db.driver.get<ShareRow>(
    `SELECT * FROM library_shares
     WHERE library_id = ? AND (expires_at IS NULL OR expires_at > ${NOW})
     ORDER BY id DESC LIMIT 1`,
    [libraryId],
  );
}

/** 撤销某知识库的全部分享（幂等；返回是否真的删除了行） */
export function deleteShareByLibrary(db: DbHandle, libraryId: number): boolean {
  const result = db.driver.run('DELETE FROM library_shares WHERE library_id = ?', [libraryId]);
  return result.changes > 0;
}

/** 按 token 撤销分享 */
export function deleteShareByToken(db: DbHandle, token: string): boolean {
  const result = db.driver.run('DELETE FROM library_shares WHERE token = ?', [token]);
  return result.changes > 0;
}
