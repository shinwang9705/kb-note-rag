-- 0003_rag_ops：登录限流（ACC-06）+ 检索历史（SRCH-08，S3 才写数据）
--
-- 幂等：全部 CREATE ... IF NOT EXISTS，迁移器按文件名升序执行一次（PRAGMA user_version 驱动）。
-- 隔离说明：search_history 带 user_id（隔离铁律）；login_guard 不带（登录前无身份，按 user_key）。

-- ---------- 登录限流（ACC-06） ----------
CREATE TABLE IF NOT EXISTS login_guard (
  user_key     TEXT PRIMARY KEY,            -- lower(username)
  fail_count   INTEGER NOT NULL DEFAULT 0,
  first_fail   TEXT,
  locked_until TEXT,                        -- ISO-8601 UTC；NULL = 未锁定
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- 检索历史（SRCH-08，S3 写数据） ----------
CREATE TABLE IF NOT EXISTS search_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query      TEXT    NOT NULL,
  mode       TEXT    NOT NULL DEFAULT 'keyword',     -- hybrid | keyword | vector
  hit_count  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);
