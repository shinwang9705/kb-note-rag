-- 0004_conversation：多轮对话（条款 7/8）
-- 隔离铁律：全部业务表带 user_id，repo 层强制 WHERE user_id = ?

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL DEFAULT '新对话',
  mode            TEXT    NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat','agent')),
  provider_id     TEXT    NOT NULL DEFAULT '',          -- '' = 用用户默认供应商
  model           TEXT    NOT NULL DEFAULT '',          -- '' = 用供应商默认模型
  params_json     TEXT    NOT NULL DEFAULT '{}',        -- GenerationParams {temperature,topP,maxTokens,thinkingRounds}
  strategy        TEXT    NOT NULL DEFAULT 'sequential',
  kb_enabled      INTEGER NOT NULL DEFAULT 0,           -- 是否挂载知识库
  kb_scope_json   TEXT,                                  -- {libraryId?, documentIds?}（会话级检索范围）
  summary_json    TEXT,                                  -- 滚动摘要 {text, upToSeq}（上下文裁剪复用）
  message_count   INTEGER NOT NULL DEFAULT 0,
  token_in        INTEGER NOT NULL DEFAULT 0,
  token_out       INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_message_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated  ON conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_user_lastmsg  ON conversations(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_user_archived ON conversations(user_id, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,                     -- 会话内单调序号
  role            TEXT    NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT    NOT NULL DEFAULT '',
  reasoning       TEXT,                                 -- 归一化思考内容（结构化，非 HTML 字符串）
  parent_id       INTEGER,                              -- 分支：重新生成挂在同一 parent_id 下
  branch_index    INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'done'
                  CHECK (status IN ('pending','streaming','done','aborted','failed')),
  thinking_run_id INTEGER,                              -- 软引用 thinking_runs.id（无 FK，跨迁移顺序安全）
  citations_json  TEXT,                                 -- Citation[]
  model           TEXT,
  provider_id     TEXT,
  token_in        INTEGER NOT NULL DEFAULT 0,
  token_out       INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  error_json      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq  ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_msg_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_run        ON messages(thinking_run_id);

-- ---------- 消息全文索引（trigram 对中文友好；1-2 字由 service 层 LIKE 兜底） ----------
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
