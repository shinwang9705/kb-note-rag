/**
 * 用户设置读写（三期 T04）。
 *
 * 默认值合并：shared 默认 -> config.generation/config.thinking -> 用户已存设置。
 * patch 只合并白名单字段（generation/thinking/ui/wizardCompleted），落库 user_settings。
 */
import type { PatchSettingsInput, RagSettings, RagSettingsPatch, Settings } from '@kb/shared';
import { DEFAULT_GENERATION_PARAMS, DEFAULT_THINKING_BUDGET } from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { getRagSettings, normalizeRagSettings } from './rag.service.js';

export interface SettingsServiceContext {
  db: DbHandle;
  config: AppConfig;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function parseStored(raw: string | null | undefined): Partial<Settings> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<Settings>;
  } catch {
    return {};
  }
}

export function getSettings(ctx: SettingsServiceContext, userId: number): Settings {
  const row = ctx.db.driver.get<{ settings_json: string }>('SELECT settings_json FROM user_settings WHERE user_id = ?', [userId]);
  const stored = parseStored(row?.settings_json);
  return {
    generation: { ...DEFAULT_GENERATION_PARAMS, ...ctx.config.generation, ...(stored.generation ?? {}) },
    thinking: { ...DEFAULT_THINKING_BUDGET, ...ctx.config.thinking, ...(stored.thinking ?? {}) },
    rag: getRagSettings(ctx, userId),
    ui: { themeId: 'light', ...(stored.ui ?? {}) },
    wizardCompleted: stored.wizardCompleted ?? false,
  };
}

/** rag 段深合并：仅 patch 提供的嵌套字段覆盖当前值，未提供的字段保留 */
function mergeRag(base: RagSettings, patch: RagSettingsPatch): RagSettings {
  return {
    search: { ...base.search, ...(patch.search ?? {}) },
    context: { ...base.context, ...(patch.context ?? {}) },
    rerank: { ...base.rerank, ...(patch.rerank ?? {}) },
    confidence: { ...base.confidence, ...(patch.confidence ?? {}) },
    chunk: { ...base.chunk, ...(patch.chunk ?? {}) },
  };
}

export function patchSettings(ctx: SettingsServiceContext, userId: number, patch: PatchSettingsInput): Settings {
  const current = getSettings(ctx, userId);
  const next: Settings = {
    generation: patch.generation ? { ...current.generation, ...patch.generation } : current.generation,
    thinking: patch.thinking ? { ...current.thinking, ...patch.thinking } : current.thinking,
    rag: patch.rag ? normalizeRagSettings(mergeRag(current.rag, patch.rag)) : current.rag,
    ui: patch.ui ? { ...current.ui, ...patch.ui } : current.ui,
    wizardCompleted: patch.wizardCompleted ?? current.wizardCompleted,
  };

  ctx.db.driver.run(
    `INSERT INTO user_settings (user_id, settings_json, updated_at)
     VALUES (?, ?, ${NOW})
     ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(next)],
  );
  return next;
}
