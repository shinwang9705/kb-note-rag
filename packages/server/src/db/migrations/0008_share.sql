-- 0008_share：知识库只读共享（显式 opt-in 例外，默认仍硬隔离）
-- token 唯一、URL-safe、node:crypto 随机；expires_at NULL = 永久有效
CREATE TABLE IF NOT EXISTS library_shares (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id  INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  token       TEXT    NOT NULL UNIQUE,
  created_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT,   -- ISO-8601 UTC；NULL = 永久
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_share_token   ON library_shares(token);
CREATE INDEX IF NOT EXISTS idx_share_library ON library_shares(library_id);
