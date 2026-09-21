-- 0009_tags：文档标签 + 收藏 + 分块章节路径
-- 标签为覆盖式 set（POST /api/documents/:id/tags 传完整 tagIds）；收藏为布尔位。
-- section_path 供分块结构感知（RAG 溯源展示「文档名 > 章节路径 > 片段」）。
-- 说明：chunks_fts 是 external content 表、只索引 content 列，加列不影响 FTS。
-- 版本门控（user_version）下可安全 ALTER TABLE ADD COLUMN，无需 IF NOT EXISTS。

-- ---------- 标签 ----------
CREATE TABLE IF NOT EXISTS document_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS document_tag_links (
  tag_id INTEGER NOT NULL REFERENCES document_tags(id) ON DELETE CASCADE,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_tag_links_doc ON document_tag_links(doc_id);

-- ---------- 收藏 ----------
ALTER TABLE documents ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

-- ---------- 分块章节路径 ----------
ALTER TABLE chunks ADD COLUMN section_path TEXT;
