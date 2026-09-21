/**
 * 问答数据访问层：按命中 chunkId 回表取**完整正文**。
 *
 * 关键：SearchHit.snippet 是截断摘要，喂 LLM 必须用 chunks.content 完整正文，
 * 故这里二次 JOIN documents 取 title 并强制 user_id + status='ready'。
 *
 * 隔离铁律：chunk 侧 WHERE c.user_id=?，文档侧再 WHERE d.status='ready'，
 * 越权/未就绪一律表现为「查不到」。
 */
import type { DbHandle } from '../db/connection.js';

export interface ContextChunk {
  chunkId: number;
  docId: number;
  docTitle: string;
  content: string;
  charStart: number;
  charEnd: number;
  sectionPath?: string;
}

/**
 * 取上下文片段完整正文。
 * @returns 命中 chunk 的完整正文（顺序由 SQL 决定，调用方需按命中顺序自行重排）
 */
export function getContextChunks(db: DbHandle, userId: number, chunkIds: readonly number[]): ContextChunk[] {
  if (chunkIds.length === 0) return [];

  const placeholders = chunkIds.map(() => '?').join(',');
  const rows = db.driver.all<{
    chunkId: number;
    docId: number;
    docTitle: string;
    content: string;
    charStart: number;
    charEnd: number;
    sectionPath: string | null;
  }>(
    `SELECT
       c.id            AS chunkId,
       c.doc_id        AS docId,
       d.title         AS docTitle,
       c.content       AS content,
       c.char_start    AS charStart,
       c.char_end      AS charEnd,
       c.section_path  AS sectionPath
     FROM chunks c
     JOIN documents d ON d.id = c.doc_id
     WHERE c.id IN (${placeholders})
       AND c.user_id = ?
       AND d.status = 'ready'`,
    [...chunkIds, userId],
  );

  return rows.map((row) => ({
    chunkId: Number(row.chunkId),
    docId: Number(row.docId),
    docTitle: row.docTitle ?? '',
    content: row.content ?? '',
    charStart: Number(row.charStart),
    charEnd: Number(row.charEnd),
    ...(row.sectionPath ? { sectionPath: row.sectionPath } : {}),
  }));
}
