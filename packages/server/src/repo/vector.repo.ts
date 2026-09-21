/**
 * sqlite-vec 向量表数据访问层。
 *
 * 实测踩坑（不可更改）：
 *   1. vec0 的 rowid 与 integer metadata 列（user_id / doc_id）绑定**必须**用 BigInt，
 *      传 number 会报 "datatype mismatch"；
 *   2. KNN 查询里 `k = ?` 与 `LIMIT` 互斥，只能二选一；
 *   3. 向量以 Float32Array 的底层字节（BLOB）传入，长度必须等于建表维度。
 *
 * 调用前必须确认 db.vecAvailable === true，否则表不存在。
 */
import type { DbHandle } from '../db/connection.js';

export interface VectorRow {
  chunkId: number;
  vector: number[];
}

/** 把 number[] 转成 Float32Array 字节（sqlite-vec 期望的 BLOB 格式） */
export function toVectorBlob(vector: readonly number[]): Buffer {
  const array = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    array[i] = Number.isFinite(value) ? value : 0;
  }
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * 批量写入向量。rowid 直接使用 chunks.id，便于检索后回查片段内容。
 * @returns 实际写入条数
 */
export function insertVectors(db: DbHandle, userId: number, docId: number, rows: readonly VectorRow[]): number {
  if (rows.length === 0) return 0;
  const sql = 'INSERT INTO vec_chunks(rowid, embedding, user_id, doc_id) VALUES (?, ?, ?, ?)';
  let written = 0;
  for (const row of rows) {
    db.driver.run(sql, [BigInt(row.chunkId), toVectorBlob(row.vector), BigInt(userId), BigInt(docId)]);
    written += 1;
  }
  return written;
}

/**
 * 删除指定片段对应的向量。
 * 只按 rowid 删除：vec0 对 metadata 列的约束删除支持不稳定，rowid 删除是确定性路径。
 */
export function deleteVectorsByChunkIds(db: DbHandle, chunkIds: readonly number[]): number {
  let removed = 0;
  for (const chunkId of chunkIds) {
    const result = db.driver.run('DELETE FROM vec_chunks WHERE rowid = ?', [BigInt(chunkId)]);
    removed += result.changes;
  }
  return removed;
}
