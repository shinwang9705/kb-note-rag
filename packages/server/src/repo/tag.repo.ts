/**
 * 标签数据访问层（五期 §5.2）。
 *
 * 隔离铁律：所有查询强制带 user_id；标签与文档的关联也按「先验 doc 归属、再验 tag 归属」，
 * 越权一律表现为「查不到 / 无效果」，不泄露存在性。
 */
import type { DbHandle } from '../db/connection.js';

export interface DocTagRow {
  id: number;
  name: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 列出某用户全部标签（按名称升序） */
export function listTags(db: DbHandle, userId: number): DocTagRow[] {
  return db.driver.all<DocTagRow>(
    'SELECT id, name FROM document_tags WHERE user_id = ? ORDER BY name ASC, id ASC',
    [userId],
  );
}

/** 按名称查标签（强制 user_id；越权返回 undefined） */
export function findTagByName(db: DbHandle, userId: number, name: string): DocTagRow | undefined {
  return db.driver.get<DocTagRow>(
    'SELECT id, name FROM document_tags WHERE user_id = ? AND name = ?',
    [userId, name],
  );
}

/** 创建标签；同名已存在时幂等返回既有标签 */
export function createTag(db: DbHandle, userId: number, name: string): DocTagRow | undefined {
  const existing = findTagByName(db, userId, name);
  if (existing) return existing;
  const row = db.driver.get<Pick<DocTagRow, 'id'>>(
    `INSERT INTO document_tags (user_id, name, created_at) VALUES (?, ?, ${NOW}) RETURNING id`,
    [userId, name],
  );
  const id = Number(row?.id ?? 0);
  return id > 0 ? { id, name } : undefined;
}

/** 删除标签（强制 user_id；关联自动级联删除）；返回是否真的删掉 */
export function deleteTag(db: DbHandle, userId: number, id: number): boolean {
  const result = db.driver.run('DELETE FROM document_tags WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

/**
 * 覆盖式设置某文档的标签（POST /:id/tags 的语义）。
 * 仅保留「归属当前用户」的 tagIds（跨用户 tag id 静默忽略，符合越权无效果铁律）。
 */
export function setDocTags(db: DbHandle, userId: number, docId: number, tagIds: readonly number[]): void {
  const ids = [...new Set(tagIds.map((id) => Number(id))).values()].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  let validIds: number[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.driver.all<{ id: number }>(
      `SELECT id FROM document_tags WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...ids],
    );
    validIds = rows.map((row) => Number(row.id));
  }

  db.driver.transaction(() => {
    db.driver.run('DELETE FROM document_tag_links WHERE doc_id = ?', [docId]);
    for (const tagId of validIds) {
      db.driver.run('INSERT OR IGNORE INTO document_tag_links (tag_id, doc_id) VALUES (?, ?)', [tagId, docId]);
    }
  });
}

/** 列出某标签下命中的文档 id（强制 user_id；按 doc_id 升序） */
export function listDocsByTag(db: DbHandle, userId: number, tagId: number): number[] {
  const rows = db.driver.all<{ docId: number }>(
    `SELECT l.doc_id AS docId
     FROM document_tag_links l
     JOIN document_tags t ON t.id = l.tag_id
     WHERE t.user_id = ? AND t.id = ?
     ORDER BY l.doc_id ASC`,
    [userId, tagId],
  );
  return rows.map((row) => Number(row.docId));
}

/** 批量取多个文档的标签名（用于列表 DTO 聚合）；返回 docId -> 标签名[] */
export function listTagsForDocs(db: DbHandle, userId: number, docIds: readonly number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (docIds.length === 0) return map;
  const placeholders = docIds.map(() => '?').join(',');
  const rows = db.driver.all<{ docId: number; name: string }>(
    `SELECT l.doc_id AS docId, t.name AS name
     FROM document_tag_links l
     JOIN document_tags t ON t.id = l.tag_id
     WHERE t.user_id = ? AND l.doc_id IN (${placeholders})
     ORDER BY t.name ASC, t.id ASC`,
    [userId, ...docIds],
  );
  for (const row of rows) {
    const docId = Number(row.docId);
    const list = map.get(docId) ?? [];
    list.push(row.name);
    map.set(docId, list);
  }
  return map;
}
