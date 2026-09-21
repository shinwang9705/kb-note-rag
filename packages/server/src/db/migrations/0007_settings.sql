-- 0007_settings：用户级设置（生成参数默认值 / 思考预算 / UI 偏好 / 向导状态）
-- 隔离铁律：user_id 主键，硬隔离。

CREATE TABLE IF NOT EXISTS user_settings (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT    NOT NULL DEFAULT '{}',
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
