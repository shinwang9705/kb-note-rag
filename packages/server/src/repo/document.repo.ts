/**
 * 文档数据访问层。
 * 铁律：所有查询强制带 user_id —— 越权访问表现为「查不到」而不是「报错」，避免探测资源是否存在。
 */
import type { DbHandle } from '../db/connection.js';
import type { DocumentStatus } from '@kb/shared';

export interface DocumentRow {
  id: number;
  user_id: number;
  library_id: number | null;
  title: string;
  source_type: 'upload' | 'text';
  file_name: string | null;
  file_ext: string | null;
  file_size: number;
  mime_type: string | null;
  storage_path: string | null;
  char_count: number;
  chunk_count: number;
  status: DocumentStatus;
  error_message: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface CreateDocumentInput {
  userId: number;
  libraryId: number | null;
  title: string;
  sourceType: 'upload' | 'text';
  fileName?: string | null;
  fileExt?: string | null;
  fileSize?: number;
  mimeType?: string | null;
  storagePath?: string | null;
  status?: DocumentStatus;
}

export interface UpdateDocumentPatch {
  title?: string;
  libraryId?: number | null;
  status?: DocumentStatus;
  charCount?: number;
  chunkCount?: number;
  storagePath?: string | null;
  errorMessage?: string | null;
  fileName?: string | null;
  fileExt?: string | null;
  fileSize?: number;
  mimeType?: string | null;
  sourceType?: 'upload' | 'text';
  isFavorite?: boolean;
}

export interface ListDocumentsQuery {
  libraryId?: number | null;
  status?: DocumentStatus | null;
  tagId?: number | null;
  favoriteOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** 列出某用户的文档（强制 user_id；收藏置顶） */
export function listDocuments(db: DbHandle, userId: number, query: ListDocumentsQuery = {}): DocumentRow[] {
  const where: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  if (query.libraryId !== undefined && query.libraryId !== null) {
    where.push('library_id = ?');
    params.push(Number(query.libraryId));
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.tagId !== undefined && query.tagId !== null) {
    where.push('id IN (SELECT doc_id FROM document_tag_links WHERE tag_id = ?)');
    params.push(Number(query.tagId));
  }
  if (query.favoriteOnly) {
    where.push('is_favorite = 1');
  }

  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 200);
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));

  return db.driver.all<DocumentRow>(
    `SELECT * FROM documents WHERE ${where.join(' AND ')}
     ORDER BY is_favorite DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

/** 按 id 查询（强制 user_id，越权返回 undefined） */
export function findDocumentById(db: DbHandle, userId: number, id: number): DocumentRow | undefined {
  return db.driver.get<DocumentRow>('SELECT * FROM documents WHERE id = ? AND user_id = ?', [id, userId]);
}

/** 创建文档（默认 pending，由入库流程推进到 processing/ready/failed） */
export function createDocument(db: DbHandle, input: CreateDocumentInput): DocumentRow {
  const row = db.driver.get<Pick<DocumentRow, 'id'>>(
    `INSERT INTO documents
       (user_id, library_id, title, source_type, file_name, file_ext, file_size,
        mime_type, storage_path, char_count, chunk_count, status, error_message,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ${NOW}, ${NOW}) RETURNING id`,
    [
      input.userId,
      input.libraryId,
      input.title,
      input.sourceType,
      input.fileName ?? null,
      input.fileExt ?? null,
      Math.max(0, Math.trunc(input.fileSize ?? 0)),
      input.mimeType ?? null,
      input.storagePath ?? null,
      input.status ?? 'pending',
    ],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建文档失败：未返回主键');
  return findDocumentById(db, input.userId, id) as DocumentRow;
}

/** 更新文档（强制 user_id）；返回 undefined 表示文档不存在或无权访问 */
export function updateDocument(
  db: DbHandle,
  userId: number,
  id: number,
  patch: UpdateDocumentPatch,
): DocumentRow | undefined {
  const existing = findDocumentById(db, userId, id);
  if (!existing) return undefined;

  db.driver.run(
    `UPDATE documents SET
       title = ?, library_id = ?, status = ?, char_count = ?, chunk_count = ?,
       storage_path = ?, error_message = ?,
       file_name = ?, file_ext = ?, file_size = ?, mime_type = ?, source_type = ?,
       is_favorite = ?,
       updated_at = ${NOW}
     WHERE id = ? AND user_id = ?`,
    [
      patch.title ?? existing.title,
      patch.libraryId === undefined ? existing.library_id : patch.libraryId,
      patch.status ?? existing.status,
      patch.charCount ?? existing.char_count,
      patch.chunkCount ?? existing.chunk_count,
      patch.storagePath === undefined ? existing.storage_path : patch.storagePath,
      patch.errorMessage === undefined ? existing.error_message : patch.errorMessage,
      patch.fileName === undefined ? existing.file_name : patch.fileName,
      patch.fileExt === undefined ? existing.file_ext : patch.fileExt,
      patch.fileSize ?? existing.file_size,
      patch.mimeType === undefined ? existing.mime_type : patch.mimeType,
      patch.sourceType ?? existing.source_type,
      patch.isFavorite === undefined ? existing.is_favorite : patch.isFavorite ? 1 : 0,
      id,
      userId,
    ],
  );
  return findDocumentById(db, userId, id);
}

/** 删除文档（强制 user_id）；返回是否真的删掉了 */
export function deleteDocument(db: DbHandle, userId: number, id: number): boolean {
  const result = db.driver.run('DELETE FROM documents WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

export interface CountDocumentsFilter {
  status?: DocumentStatus;
  libraryId?: number | null;
  tagId?: number | null;
  favoriteOnly?: boolean;
}

/** 统计某用户文档数（可按状态 / 知识库 / 标签 / 收藏过滤） */
export function countDocuments(db: DbHandle, userId: number, filter: CountDocumentsFilter = {}): number {
  const where: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.libraryId !== undefined && filter.libraryId !== null) {
    where.push('library_id = ?');
    params.push(Number(filter.libraryId));
  }
  if (filter.tagId !== undefined && filter.tagId !== null) {
    where.push('id IN (SELECT doc_id FROM document_tag_links WHERE tag_id = ?)');
    params.push(Number(filter.tagId));
  }
  if (filter.favoriteOnly) {
    where.push('is_favorite = 1');
  }

  const row = db.driver.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM documents WHERE ${where.join(' AND ')}`,
    params,
  );
  return Number(row?.c ?? 0);
}

/**
 * 列出 ready 状态的文档（供全量重建索引）。
 * userId 传 null 表示跨用户（仅管理员全量重建用）。
 */
export function listReadyDocuments(
  db: DbHandle,
  userId: number | null,
  libraryId: number | null = null,
): DocumentRow[] {
  const where: string[] = ["status = 'ready'"];
  const params: (string | number)[] = [];
  if (userId !== null) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (libraryId !== null) {
    where.push('library_id = ?');
    params.push(libraryId);
  }
  return db.driver.all<DocumentRow>(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY id ASC`,
    params,
  );
}
