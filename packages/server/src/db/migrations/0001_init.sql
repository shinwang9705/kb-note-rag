-- 0001_init：核心实体表
-- 约定：
--   1. 所有业务表都带 user_id，多用户硬隔离（repository 层强制 WHERE user_id = ?）
--   2. 时间统一用 ISO8601 文本（UTC），便于排序与跨语言读取
--   3. 全部语句幂等（CREATE ... IF NOT EXISTS），可重复执行

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user'      CHECK (role IN ('admin', 'user')),
  status        TEXT    NOT NULL DEFAULT 'active'    CHECK (status IN ('active', 'disabled')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ---------- 知识库（文档分组） ----------
CREATE TABLE IF NOT EXISTS libraries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_libraries_user ON libraries(user_id, created_at DESC);

-- ---------- 文档 ----------
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id    INTEGER REFERENCES libraries(id) ON DELETE SET NULL,
  title         TEXT    NOT NULL,
  source_type   TEXT    NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload', 'text')),
  file_name     TEXT,
  file_ext      TEXT,
  file_size     INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT,
  storage_path  TEXT,
  char_count    INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(user_id, library_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(user_id, status);

-- ---------- 片段 ----------
CREATE TABLE IF NOT EXISTS chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  content    TEXT    NOT NULL,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_chunks_user_doc ON chunks(user_id, doc_id, seq);

-- ---------- 入库任务 ----------
CREATE TABLE IF NOT EXISTS ingest_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id     INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  status     TEXT    NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'running', 'done', 'failed')),
  stage      TEXT    NOT NULL DEFAULT '',
  progress   INTEGER NOT NULL DEFAULT 0,
  message    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ingest_user ON ingest_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_doc ON ingest_tasks(doc_id);

-- ---------- 登出令牌黑名单（JWT 无状态，靠 jti 失效） ----------
CREATE TABLE IF NOT EXISTS token_denylist (
  jti         TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,          -- epoch 秒
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_token_denylist_exp ON token_denylist(expires_at);
