/**
 * 检索历史数据访问层（SRCH-08）。
 * 写入后按 created_at DESC 裁剪到最近 50 条，防止表无限增长。
 */
import type { DbHandle } from '../db/connection.js';
import type { SearchHistoryItem } from '@kb/shared';

const MAX_HISTORY = 50;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** 记录一条检索历史，并裁剪到最近 50 条（强制 user_id） */
export function record(
  db: DbHandle,
  userId: number,
  input: { query: string; mode: string; hitCount: number },
): void {
  db.driver.run(
    `INSERT INTO search_history (user_id, query, mode, hit_count, created_at)
     VALUES (?, ?, ?, ?, ${NOW})`,
    [userId, input.query, input.mode, Math.max(0, Math.trunc(input.hitCount))],
  );
  db.driver.run(
    `DELETE FROM search_history
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM search_history
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ${MAX_HISTORY}
       )`,
    [userId, userId],
  );
}

/** 列出最近 50 条检索历史（强制 user_id） */
export function listRecent(db: DbHandle, userId: number, limit = MAX_HISTORY): SearchHistoryItem[] {
  const rows = db.driver.all<{
    id: number;
    query: string;
    mode: string;
    hit_count: number;
    created_at: string;
  }>(
    `SELECT id, query, mode, hit_count, created_at
     FROM search_history WHERE user_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, Math.min(Math.max(1, Math.trunc(limit)), 200)],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    query: row.query,
    mode: row.mode,
    hitCount: Number(row.hit_count),
    createdAt: row.created_at,
  }));
}

/** 清空某用户全部检索历史 */
export function clear(db: DbHandle, userId: number): number {
  const result = db.driver.run('DELETE FROM search_history WHERE user_id = ?', [userId]);
  return result.changes;
}
