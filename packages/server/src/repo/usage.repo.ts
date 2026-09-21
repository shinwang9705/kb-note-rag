/**
 * 用量统计数据访问层。
 * S2 只需 docCountByUser（管理员列表拼文档数）；S4 扩展用量看板 + 文档/索引健康。
 */
import type { AdminUsageStats, DocumentStats, UsageStats } from '@kb/shared';
import type { DbHandle } from '../db/connection.js';
import { countDocuments } from './document.repo.js';

/** 统计某用户的存储占用字节数（SUM(file_size)） */
export function storageBytesOf(db: DbHandle, userId: number): number {
  const row = db.driver.get<{ s: number }>(
    'SELECT COALESCE(SUM(file_size), 0) AS s FROM documents WHERE user_id = ?',
    [userId],
  );
  return Number(row?.s ?? 0);
}

/**
 * 统计指定用户的文档数。
 * @returns userId -> 文档数（无文档的用户不在 Map 中）
 */
export function docCountByUser(db: DbHandle, userIds: readonly number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (userIds.length === 0) return result;

  const placeholders = userIds.map(() => '?').join(',');
  const rows = db.driver.all<{ user_id: number; c: number }>(
    `SELECT user_id, COUNT(*) AS c FROM documents WHERE user_id IN (${placeholders}) GROUP BY user_id`,
    [...userIds],
  );
  for (const row of rows) result.set(Number(row.user_id), Number(row.c));
  return result;
}

/** 个人用量统计（文档数/存储/近 7 日检索/任务成功率） */
export function usageOf(db: DbHandle, userId: number): UsageStats {
  const docCount = countDocuments(db, userId);
  const storageBytes = storageBytesOf(db, userId);

  const searchRow = db.driver.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM search_history WHERE user_id = ? AND created_at >= datetime('now', '-7 days')",
    [userId],
  );
  const searchCount7d = Number(searchRow?.c ?? 0);

  const taskRow = db.driver.get<{ total: number; done: number }>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done FROM ingest_tasks WHERE user_id = ?",
    [userId],
  );
  const total = Number(taskRow?.total ?? 0);
  const done = Number(taskRow?.done ?? 0);
  // 无任务时按 1 处理（乐观：没有失败记录）
  const taskSuccessRate = total === 0 ? 1 : done / total;

  return { docCount, storageBytes, searchCount7d, taskSuccessRate };
}

/** 管理员全局用量统计（跨用户聚合，不含任何文档内容） */
export function adminUsage(db: DbHandle): AdminUsageStats {
  const userCount = Number(db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0);
  const docCount = Number(db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents')?.c ?? 0);
  const storageBytes = Number(
    db.driver.get<{ s: number }>('SELECT COALESCE(SUM(file_size), 0) AS s FROM documents')?.s ?? 0,
  );
  const searchCount7d = Number(
    db.driver.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM search_history WHERE created_at >= datetime('now', '-7 days')",
    )?.c ?? 0,
  );
  return { userCount, docCount, storageBytes, searchCount7d };
}

/** 文档/索引健康统计（IDX-07） */
export function documentStats(db: DbHandle, userId: number, libraryId: number | null = null): DocumentStats {
  const docTotal = countDocuments(db, userId, { libraryId });
  const docReady = countDocuments(db, userId, { status: 'ready', libraryId });
  const docFailed = countDocuments(db, userId, { status: 'failed', libraryId });

  const libWhere = libraryId !== null ? ' AND d.library_id = ?' : '';
  const libParams: (string | number)[] = libraryId !== null ? [userId, libraryId] : [userId];

  const chunkRow = db.driver.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.user_id = ?${libWhere}`,
    libParams,
  );
  const chunkTotal = Number(chunkRow?.c ?? 0);

  const storageRow = db.driver.get<{ s: number }>(
    `SELECT COALESCE(SUM(file_size), 0) AS s FROM documents WHERE user_id = ?${libWhere}`,
    libParams,
  );
  const storageBytes = Number(storageRow?.s ?? 0);

  // vec0 元数据列（user_id/doc_id）绑定必须用 BigInt；扩展未装载时表不存在
  let vecCovered = 0;
  if (db.vecAvailable) {
    if (libraryId !== null) {
      const docIds = db.driver
        .all<{ id: number }>('SELECT id FROM documents WHERE user_id = ? AND library_id = ?', [userId, libraryId])
        .map((row) => Number(row.id));
      if (docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',');
        const row = db.driver.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM vec_chunks WHERE user_id = ? AND doc_id IN (${placeholders})`,
          [BigInt(userId), ...docIds.map((id) => BigInt(id))],
        );
        vecCovered = Number(row?.c ?? 0);
      }
    } else {
      const row = db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM vec_chunks WHERE user_id = ?', [
        BigInt(userId),
      ]);
      vecCovered = Number(row?.c ?? 0);
    }
  }

  const vecCoverage = chunkTotal === 0 ? 0 : Math.min(1, vecCovered / chunkTotal);
  return { docTotal, docReady, docFailed, chunkTotal, vecCovered, vecCoverage, storageBytes };
}
