/**
 * 片段（chunk）数据访问层。
 *
 * 注意：chunks 上的 FTS5 外部内容表由触发器自动同步（见 0002_fts_vec.sql），
 * 这里只管实表，不要手写 FTS 维护逻辑，否则容易与触发器重复写入。
 */
import type { DbHandle } from '../db/connection.js';
import type { TextChunk } from '../util/text.js';

export interface ChunkRow {
  id: number;
  user_id: number;
  doc_id: number;
  seq: number;
  content: string;
  char_start: number;
  char_end: number;
  section_path: string | null;
  created_at: string;
}

/**
 * 批量写入片段（单事务）。
 * 写入顺序即 seq 顺序；返回的 id 列表与传入 chunks 一一对应，供向量表按 rowid 关联。
 */
export function insertChunks(db: DbHandle, userId: number, docId: number, chunks: readonly TextChunk[]): number[] {
  if (chunks.length === 0) return [];
  const sql = `INSERT INTO chunks (user_id, doc_id, seq, content, char_start, char_end, section_path)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`;
  const ids: number[] = [];
  for (const chunk of chunks) {
    const row = db.driver.get<Pick<ChunkRow, 'id'>>(sql, [
      userId,
      docId,
      chunk.seq,
      chunk.content,
      chunk.charStart,
      chunk.charEnd,
      chunk.sectionPath ?? null,
    ]);
    ids.push(Number(row?.id ?? 0));
  }
  return ids;
}

/** 删除某文档的全部片段（强制 user_id） */
export function deleteChunksByDoc(db: DbHandle, userId: number, docId: number): number {
  const result = db.driver.run('DELETE FROM chunks WHERE doc_id = ? AND user_id = ?', [docId, userId]);
  return result.changes;
}

/** 列出某文档的片段（强制 user_id，按 seq 升序） */
export function listChunks(db: DbHandle, userId: number, docId: number): ChunkRow[] {
  return db.driver.all<ChunkRow>(
    'SELECT * FROM chunks WHERE doc_id = ? AND user_id = ? ORDER BY seq ASC, id ASC',
    [docId, userId],
  );
}

/** 统计某文档的片段数 */
export function countChunks(db: DbHandle, userId: number, docId: number): number {
  const row = db.driver.get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM chunks WHERE doc_id = ? AND user_id = ?',
    [docId, userId],
  );
  return Number(row?.c ?? 0);
}
