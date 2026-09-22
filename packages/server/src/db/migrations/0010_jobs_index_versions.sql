-- 持久化后台任务与索引版本元数据。任务租约使进程重启后可恢复；版本表用于识别配置漂移。
CREATE TABLE IF NOT EXISTS background_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  priority         INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  next_run_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  lease_owner      TEXT,
  lease_until      TEXT,
  progress         INTEGER NOT NULL DEFAULT 0,
  stage            TEXT NOT NULL DEFAULT '',
  message          TEXT,
  result_json      TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at      TEXT,
  UNIQUE (user_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON background_jobs(status, next_run_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON background_jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS index_profiles (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint        TEXT NOT NULL UNIQUE,
  parser_version     TEXT NOT NULL,
  chunk_size         INTEGER NOT NULL,
  chunk_overlap      INTEGER NOT NULL,
  embedding_provider TEXT NOT NULL,
  embedding_model    TEXT NOT NULL,
  embedding_dim      INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS index_generations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  profile_id    INTEGER NOT NULL REFERENCES index_profiles(id),
  status        TEXT NOT NULL CHECK (status IN ('building','active','superseded','failed')),
  scope_json    TEXT NOT NULL DEFAULT '{}',
  stats_json    TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_index_generations_user ON index_generations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_index_state (
  doc_id         INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id  INTEGER NOT NULL REFERENCES index_generations(id),
  source_hash    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('current','stale','failed')),
  indexed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  error_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_doc_index_state_user ON document_index_state(user_id, status);
