-- 0005_thinking：深度思考引擎（验收条款 2/3 的数据基础）
-- ★ B/S 化改造：thinking_runs / thinking_rounds 均加 user_id

CREATE TABLE IF NOT EXISTS thinking_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id        INTEGER,                            -- 软引用 messages.id（终稿落点）
  question          TEXT    NOT NULL,
  strategy          TEXT    NOT NULL DEFAULT 'sequential',
  requested_rounds  INTEGER NOT NULL DEFAULT 3,
  completed_rounds  INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','running','synthesizing','completed','aborted','failed')),
  budget_json       TEXT    NOT NULL DEFAULT '{}',      -- ThinkingBudget
  consumed_in       INTEGER NOT NULL DEFAULT 0,
  consumed_out      INTEGER NOT NULL DEFAULT 0,
  consumed_ms       INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT,                               -- StopReason
  final_content     TEXT    NOT NULL DEFAULT '',
  summary_json      TEXT,                               -- SummaryState（中断续跑用）
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_user_conv     ON thinking_runs(user_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_user_resumable ON thinking_runs(user_id, status);

CREATE TABLE IF NOT EXISTS thinking_rounds (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id                  INTEGER NOT NULL REFERENCES thinking_runs(id) ON DELETE CASCADE,
  round_index             INTEGER NOT NULL,             -- 1..N（UI 显示"第 n/N 轮"）
  strategy                TEXT    NOT NULL,
  instruction             TEXT    NOT NULL DEFAULT '',  -- 本轮指令原文（可解释性）
  draft                   TEXT    NOT NULL DEFAULT '',
  reasoning               TEXT,
  outline_json            TEXT    NOT NULL DEFAULT '[]',
  changes_json            TEXT    NOT NULL DEFAULT '[]',
  self_score_json         TEXT,
  has_further_improvement INTEGER,                      -- 早停信号①：NULL/1/0
  status                  TEXT    NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','done','failed','skipped','aborted')),
  token_in                INTEGER NOT NULL DEFAULT 0,
  token_out               INTEGER NOT NULL DEFAULT 0,
  latency_ms              INTEGER NOT NULL DEFAULT 0,
  error_json              TEXT,
  started_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at                TEXT,
  UNIQUE (run_id, round_index)
);
CREATE INDEX IF NOT EXISTS idx_round_run  ON thinking_rounds(run_id, round_index);
CREATE INDEX IF NOT EXISTS idx_round_user ON thinking_rounds(user_id, run_id);
