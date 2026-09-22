-- 用户级 RAG 模型 API：Embedding 与 Rerank 凭据独立加密存储。
CREATE TABLE IF NOT EXISTS rag_model_credentials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL CHECK (capability IN ('embedding','rerank')),
  api_key_enc TEXT NOT NULL,
  api_base    TEXT NOT NULL,
  model       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  timeout_ms  INTEGER NOT NULL DEFAULT 10000,
  dim         INTEGER,
  batch_size  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_rag_model_credentials_user ON rag_model_credentials(user_id);
