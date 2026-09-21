-- 0006_providers：多厂商 API 凭据（多用户硬隔离：每个用户配置自己的 Key）
-- 能力目录（ProviderProfile：baseUrl/模型/reasoning 方言/quirks/定价）在代码里（llm/providers/*.ts），
-- 不在本表 —— "新增一家厂商 = 加一个声明式配置对象，0 业务代码改动"。

CREATE TABLE IF NOT EXISTS provider_credentials (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id       TEXT    NOT NULL,                   -- deepseek | qwen | doubao | glm
  api_key_enc       TEXT    NOT NULL,                   -- AES-256-GCM 密文（v1:iv:tag:cipher，base64）
  base_url_override TEXT,                               -- 私有网关 / 内网代理
  enabled           INTEGER NOT NULL DEFAULT 1,
  is_default        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_user ON provider_credentials(user_id);
