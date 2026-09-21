/**
 * 检索数据访问层：FTS5 通道 / LIKE 兜底通道 / sqlite-vec 通道。
 *
 * 所有查询都强制带 user_id —— 越权一律表现为"查不到"。
 * 只检索 status='ready' 的文档，避免 failed/processing 的半成品进结果。
 *
 * 实测约束（不可更改）：
 *   1. trigram 分词器对 1-2 字中文查询命中恒为 0 -> 必须 LIKE 兜底
 *   2. vec0 的 KNN 用 `k = ?`，**与 LIMIT 互斥**；integer metadata 列必须用 BigInt 绑定
 *   3. FTS5 查询语法特殊字符会抛 syntax error -> 必须转义后用短语查询
 */
import type { DbHandle } from '../db/connection.js';
import { escapeLike } from '../search/tokenize.js';

/** 单通道候选上限 */
const CANDIDATE_LIMIT = 200;

export interface RawHit {
  chunkId: number;
  docId: number;
  docTitle: string;
  seq: number;
  content: string;
  charStart: number;
  charEnd: number;
  /** 通道内原始分数（FTS 为 -bm25，越大越相关；LIKE 为覆盖率；VEC 为 1/(1+distance)） */
  score: number;
  /** 章节路径（五期分块结构感知；旧数据无此字段） */
  sectionPath?: string;
}

/**
 * FTS5 通道。
 *
 * 这里**不用** FTS5 的 snippet()：
 *   1. snippet() 的分隔符参数必须是字面量或绑定参数，而绑定参数是按 SQL 文本顺序定位的 ——
 *      SELECT 里的 snippet(?, ?) 会排在 WHERE 里 MATCH ? 之前，极易绑错位；
 *   2. 三条通道（FTS / LIKE / 向量）需要一致的高亮表现，统一在 service 层用 JS 构造片段更可控。
 */
export function searchByFts(
  db: DbHandle,
  userId: number,
  phrase: string,
  limit: number,
  libraryId: number | null,
  docId: number | null = null,
): RawHit[] {
  const where: string[] = ['chunks_fts MATCH ?', 'c.user_id = ?', "d.status = 'ready'"];
  const params: (string | number)[] = [phrase, userId];
  if (libraryId !== null) {
    where.push('d.library_id = ?');
    params.push(libraryId);
  }
  if (docId !== null) {
    where.push('d.id = ?');
    params.push(docId);
  }

  const sql = `
    SELECT
      c.id          AS chunkId,
      c.doc_id      AS docId,
      d.title       AS docTitle,
      c.seq         AS seq,
      c.content     AS content,
      c.char_start  AS charStart,
      c.char_end    AS charEnd,
      c.section_path AS sectionPath,
      -bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c    ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.doc_id
    WHERE ${where.join(' AND ')}
    ORDER BY bm25(chunks_fts)
    LIMIT ?`;

  try {
    return db.driver.all<RawHit>(sql, [...params, limit]);
  } catch (error) {
    // FTS5 语法错误不应让整个检索崩掉，交给上层走 LIKE 兜底
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`FTS 查询失败：${message}`);
  }
}

/**
 * LIKE 兜底通道。
 * trigram 对 1-2 字中文恒 0 命中，短查询只能走这里；
 * 同时它也覆盖了"查询与正文只是部分字词重合"的场景。
 */
export function searchByLike(
  db: DbHandle,
  userId: number,
  terms: readonly string[],
  limit: number,
  libraryId: number | null,
  docId: number | null = null,
): RawHit[] {
  if (terms.length === 0) return [];

  const where: string[] = ['c.user_id = ?', "d.status = 'ready'"];
  const params: (string | number)[] = [userId];
  const ors: string[] = [];
  for (const term of terms) {
    ors.push('c.content LIKE ? ESCAPE \'\\\'');
    params.push(`%${escapeLike(term)}%`);
  }
  where.push(`(${ors.join(' OR ')})`);
  if (libraryId !== null) {
    where.push('d.library_id = ?');
    params.push(libraryId);
  }
  if (docId !== null) {
    where.push('d.id = ?');
    params.push(docId);
  }

  const sql = `
    SELECT
      c.id         AS chunkId,
      c.doc_id     AS docId,
      d.title      AS docTitle,
      c.seq        AS seq,
      c.content    AS content,
      c.char_start AS charStart,
      c.char_end   AS charEnd,
      c.section_path AS sectionPath
    FROM chunks c
    JOIN documents d ON d.id = c.doc_id
    WHERE ${where.join(' AND ')}
    LIMIT ?`;

  const rows = db.driver.all<Omit<RawHit, 'score'>>(sql, [...params, Math.min(limit * 3, CANDIDATE_LIMIT)]);

  // 覆盖率打分：命中词越长越多，分越高
  const lower = rows.map((r) => ({ row: r, text: r.content.toLowerCase() }));
  const scored: RawHit[] = [];
  for (const item of lower) {
    let matched = 0;
    let weight = 0;
    for (const term of terms) {
      if (item.text.includes(term.toLowerCase())) {
        matched += 1;
        weight += term.length;
      }
    }
    if (matched === 0) continue;
    scored.push({ ...item.row, score: weight / Math.max(1, terms.length * 3) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** vec0 KNN 通道；不可用时返回空数组，绝不抛错 */
export function searchByVector(
  db: DbHandle,
  userId: number,
  queryVector: readonly number[],
  k: number,
  libraryId: number | null,
  docId: number | null = null,
): RawHit[] {
  if (queryVector.length === 0) return [];

  // 先按文档归属/知识库/ready 状态缩小集合，再计算 topK。
  // vec0 的全局 KNN 后过滤会被库外近邻挤占，造成范围内明明有内容却搜不到。
  if (libraryId !== null || docId !== null) {
    const where = ['c.user_id = ?', "d.status = 'ready'"];
    const params: Array<number | Buffer> = [float32ToBlob(queryVector), userId];
    if (libraryId !== null) { where.push('d.library_id = ?'); params.push(libraryId); }
    if (docId !== null) { where.push('d.id = ?'); params.push(docId); }
    params.push(Math.max(1, Math.trunc(k)));
    const rows = db.driver.all<Omit<RawHit, 'score'> & { distance: number }>(`
      SELECT c.id AS chunkId, c.doc_id AS docId, d.title AS docTitle, c.seq AS seq,
             c.content, c.char_start AS charStart, c.char_end AS charEnd, c.section_path AS sectionPath,
             vec_distance_L2(v.embedding, ?) AS distance
      FROM chunks c JOIN documents d ON d.id = c.doc_id
      JOIN vec_chunks v ON v.rowid = c.id
      WHERE ${where.join(' AND ')} ORDER BY distance, c.id LIMIT ?`, params);
    return rows.map(({ distance, ...row }) => ({ ...row, score: 1 / (1 + Math.max(0, distance)) }));
  }

  const knnSql = `
    SELECT rowid AS chunkId, distance
    FROM vec_chunks
    WHERE embedding MATCH ? AND k = ? AND user_id = ?`;

  let knn: Array<{ chunkId: number; distance: number }>;
  try {
    const blob = float32ToBlob(queryVector);
    knn = db.driver.all<{ chunkId: number; distance: number }>(knnSql, [
      blob,
      Math.max(1, Math.trunc(k)),
      BigInt(userId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`向量检索失败：${message}`);
  }

  if (knn.length === 0) return [];

  const ids = knn.map((r) => Number(r.chunkId));
  const placeholders = ids.map(() => '?').join(',');
  const where: string[] = [
    `c.id IN (${placeholders})`,
    'c.user_id = ?',
    "d.status = 'ready'",
  ];
  const params: (string | number)[] = [...ids, userId];
  if (libraryId !== null) {
    where.push('d.library_id = ?');
    params.push(libraryId);
  }
  if (docId !== null) {
    where.push('d.id = ?');
    params.push(docId);
  }

  const rows = db.driver.all<Omit<RawHit, 'score'>>(
    `SELECT c.id AS chunkId, c.doc_id AS docId, d.title AS docTitle, c.seq AS seq,
            c.content AS content, c.char_start AS charStart, c.char_end AS charEnd,
            c.section_path AS sectionPath
     FROM chunks c JOIN documents d ON d.id = c.doc_id
     WHERE ${where.join(' AND ')}`,
    params,
  );

  const distanceOf = new Map<number, number>();
  for (const r of knn) distanceOf.set(Number(r.chunkId), Number(r.distance));

  return rows
    .map((row) => {
      const distance = distanceOf.get(Number(row.chunkId)) ?? 1;
      return { ...row, score: 1 / (1 + Math.max(0, distance)) };
    })
    .sort((a, b) => b.score - a.score);
}

/** number[] -> Float32Array 字节（sqlite-vec 期望的 BLOB） */
export function float32ToBlob(vector: readonly number[]): Buffer {
  const array = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    array[i] = Number.isFinite(value) ? value : 0;
  }
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}
