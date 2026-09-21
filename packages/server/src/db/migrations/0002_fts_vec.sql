-- 0002_fts_vec：FTS5 关键词索引 + sqlite-vec 向量索引
--
-- 关键实测结论（不可更改）：
--   1. 中文必须用 tokenize='trigram'；unicode61 对中文命中恒为 0
--   2. trigram 最小 3 字符，1-2 字中文查询恒 0 命中 -> 检索层需 LIKE 兜底
--   3. vec0 的 integer metadata 列（user_id/doc_id）绑定必须用 BigInt
--   4. KNN 查询里 k = ? 与 LIMIT 互斥
--
-- 维度占位符会在迁移执行时替换为配置的向量维度。
-- 被 VEC-ONLY 标记包裹的语句块，仅在向量扩展装载成功时执行。

-- ---------- FTS5 外部内容表（关键词通道） ----------
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id',
  tokenize='trigram'
);

-- 保持 FTS 索引与 chunks 实表同步
CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

-- >>>VEC_ONLY
-- ---------- sqlite-vec 向量表（语义通道） ----------
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding float[{{EMBEDDING_DIM}}],
  user_id integer,
  doc_id integer
);
-- <<<VEC_ONLY
