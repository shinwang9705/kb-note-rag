/**
 * 入库任务数据访问层。
 * 单用户本地场景入库是同步完成的，任务表主要用于：
 *   1. 前端可轮询进度
 *   2. 失败后保留 stage / message，便于定位卡在哪一步
 */
import type { DbHandle } from '../db/connection.js';
import type { IngestStatus } from '@kb/shared';

export interface IngestTaskRow {
  id: number;
  user_id: number;
  doc_id: number | null;
  status: IngestStatus;
  stage: string;
  progress: number;
  message: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 入库阶段枚举（写库用的可读值） */
export const INGEST_STAGE = {
  QUEUED: 'queued',
  PARSE: 'parse',
  CHUNK: 'chunk',
  EMBED: 'embed',
  INDEX: 'index',
  DONE: 'done',
} as const;

export type IngestStageName = (typeof INGEST_STAGE)[keyof typeof INGEST_STAGE];

/** 创建任务（初始 queued） */
export function createIngestTask(db: DbHandle, userId: number, docId: number | null): IngestTaskRow {
  const row = db.driver.get<Pick<IngestTaskRow, 'id'>>(
    `INSERT INTO ingest_tasks (user_id, doc_id, status, stage, progress, message, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, 0, NULL, ${NOW}, ${NOW}) RETURNING id`,
    [userId, docId, INGEST_STAGE.QUEUED],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建入库任务失败：未返回主键');
  return findIngestTaskById(db, userId, id) as IngestTaskRow;
}

/** 按 id 查询（强制 user_id） */
export function findIngestTaskById(db: DbHandle, userId: number, id: number): IngestTaskRow | undefined {
  return db.driver.get<IngestTaskRow>('SELECT * FROM ingest_tasks WHERE id = ? AND user_id = ?', [id, userId]);
}

/** 推进任务状态（强制 user_id） */
export function updateIngestTask(
  db: DbHandle,
  userId: number,
  id: number,
  patch: { status?: IngestStatus; stage?: string; progress?: number; message?: string | null },
): IngestTaskRow | undefined {
  const existing = findIngestTaskById(db, userId, id);
  if (!existing) return undefined;

  db.driver.run(
    `UPDATE ingest_tasks SET
       status = ?, stage = ?, progress = ?, message = ?, updated_at = ${NOW}
     WHERE id = ? AND user_id = ?`,
    [
      patch.status ?? existing.status,
      patch.stage ?? existing.stage,
      Math.min(100, Math.max(0, Math.trunc(patch.progress ?? existing.progress))),
      patch.message === undefined ? existing.message : patch.message,
      id,
      userId,
    ],
  );
  return findIngestTaskById(db, userId, id);
}

/** 取某文档最近一条任务（强制 user_id） */
export function findLatestTaskByDoc(db: DbHandle, userId: number, docId: number): IngestTaskRow | undefined {
  return db.driver.get<IngestTaskRow>(
    'SELECT * FROM ingest_tasks WHERE doc_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    [docId, userId],
  );
}
