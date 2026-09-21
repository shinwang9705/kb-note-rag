/**
 * RAG 运行级配置单一出口（六期 T01）。
 *
 * 三层合并（逐字段）：DEFAULT_RAG_SETTINGS（代码常量）→ config.*（env 默认）→ stored.rag（用户偏好）。
 * 读时求值：每次调用都 SELECT user_settings.settings_json，天然「读到的就是最新的」，无需失效缓存。
 * 降级安全：JSON 损坏 / 字段类型错误 / 越界值 一律回退默认或 clamp，绝不断检索/生成主链路。
 */
import type {
  RagConfidenceSettings,
  RagContextSettings,
  RagRerankSettings,
  RagSearchMode,
  RagSearchSettings,
  RagSettings,
  RagSettingsPatch,
  RagStatus,
  ResolvedRagParams,
} from '@kb/shared';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RAG_SETTINGS,
  DEFAULT_RERANK_PROVIDER,
  RAG_RANGE,
} from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import type { RerankProvider } from '../rerank/types.js';

/** getRagSettings 所需的最小上下文 */
export interface RagServiceContext {
  db: DbHandle;
  config: AppConfig;
}

/** resolveRagParams 所需上下文（额外要求 rerank 能力） */
export interface RagResolveContext extends RagServiceContext {
  rerank: RerankProvider;
}

/** ragStatus 所需上下文（额外要求 embedding 能力） */
export interface RagStatusContext extends RagResolveContext {
  embedding: EmbeddingProvider;
}

const RAG_SEARCH_MODES: readonly string[] = ['auto', 'hybrid', 'keyword', 'vector'];

/** defaultMode 非法值一律回退 'auto'（字符串之外的类型也视为非法） */
function normalizeMode(value: unknown): RagSearchMode {
  return typeof value === 'string' && RAG_SEARCH_MODES.includes(value)
    ? (value as RagSearchMode)
    : 'auto';
}

/** 整数 clamp；非有限 number（含字符串/对象/undefined）回退 fallback */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.trunc(Math.min(max, Math.max(min, value)));
}

/** 浮点 clamp；非有限 number 回退 fallback */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 取首个「合法有限数」（stored → env → 代码常量），全部非法时返回 0（由 clamp 兜底） */
function firstNumber(...values: readonly unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** 读取已存的 rag 段（settings_json 损坏 -> {}；rag 非对象 -> {}） */
export function readStoredRag(db: DbHandle, userId: number): RagSettingsPatch {
  const row = db.driver.get<{ settings_json: string }>(
    'SELECT settings_json FROM user_settings WHERE user_id = ?',
    [userId],
  );
  if (!row?.settings_json) return {};
  try {
    const parsed = JSON.parse(row.settings_json) as { rag?: unknown };
    const rag = parsed?.rag;
    return rag && typeof rag === 'object' && !Array.isArray(rag)
      ? (rag as RagSettingsPatch)
      : {};
  } catch {
    return {};
  }
}

/**
 * 归一化：把任意 Partial<RagSettings> 收敛为完整且合法的 RagSettings。
 * 数值 clamp 到范围、defaultMode 非法回退 'auto'、字段缺失/类型错误回退默认值。
 */
export function normalizeRagSettings(partial?: RagSettingsPatch | null): RagSettings {
  const p = partial ?? {};
  const s: Partial<RagSearchSettings> = p.search ?? {};
  const c: Partial<RagContextSettings> = p.context ?? {};
  const r: Partial<RagRerankSettings> = p.rerank ?? {};
  const cf: Partial<RagConfidenceSettings> = p.confidence ?? {};
  return {
    search: {
      topK: clampInt(s.topK, RAG_RANGE.searchTopK.min, RAG_RANGE.searchTopK.max, DEFAULT_RAG_SETTINGS.search.topK),
      finalK: clampInt(s.finalK, RAG_RANGE.searchFinalK.min, RAG_RANGE.searchFinalK.max, DEFAULT_RAG_SETTINGS.search.finalK),
      defaultMode: normalizeMode(s.defaultMode),
    },
    context: {
      topK: clampInt(c.topK, RAG_RANGE.contextTopK.min, RAG_RANGE.contextTopK.max, DEFAULT_RAG_SETTINGS.context.topK),
    },
    rerank: {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_RAG_SETTINGS.rerank.enabled,
      topN: clampInt(r.topN, RAG_RANGE.rerankTopN.min, RAG_RANGE.rerankTopN.max, DEFAULT_RAG_SETTINGS.rerank.topN),
      topK: clampInt(r.topK, RAG_RANGE.rerankTopK.min, RAG_RANGE.rerankTopK.max, DEFAULT_RAG_SETTINGS.rerank.topK),
    },
    confidence: {
      groundedScore: clampFloat(cf.groundedScore, RAG_RANGE.confidence.min, RAG_RANGE.confidence.max, DEFAULT_RAG_SETTINGS.confidence.groundedScore),
      partialScore: clampFloat(cf.partialScore, RAG_RANGE.confidence.min, RAG_RANGE.confidence.max, DEFAULT_RAG_SETTINGS.confidence.partialScore),
    },
  };
}

/** 三层合并后的生效值（stored.rag > env 默认 > 代码常量） */
export function getRagSettings(ctx: RagServiceContext, userId: number): RagSettings {
  const stored = readStoredRag(ctx.db, userId);
  const config = ctx.config;
  const raw: RagSettingsPatch = {
    search: {
      topK: firstNumber(stored.search?.topK, config.search.topK, DEFAULT_RAG_SETTINGS.search.topK),
      finalK: firstNumber(stored.search?.finalK, config.search.finalK, DEFAULT_RAG_SETTINGS.search.finalK),
      defaultMode: normalizeMode(stored.search?.defaultMode),
    },
    context: {
      topK: firstNumber(stored.context?.topK, config.llm.contextTopK, DEFAULT_RAG_SETTINGS.context.topK),
    },
    rerank: {
      enabled: typeof stored.rerank?.enabled === 'boolean' ? stored.rerank.enabled : DEFAULT_RAG_SETTINGS.rerank.enabled,
      topN: firstNumber(stored.rerank?.topN, config.rerank.topN, DEFAULT_RAG_SETTINGS.rerank.topN),
      topK: firstNumber(stored.rerank?.topK, config.rerank.topK, DEFAULT_RAG_SETTINGS.rerank.topK),
    },
    confidence: {
      groundedScore: firstNumber(stored.confidence?.groundedScore, DEFAULT_RAG_SETTINGS.confidence.groundedScore),
      partialScore: firstNumber(stored.confidence?.partialScore, DEFAULT_RAG_SETTINGS.confidence.partialScore),
    },
  };
  return normalizeRagSettings(raw);
}

/**
 * 解析本次请求的 RAG 参数（三挂载点统一出口）。
 * rerankEnabled = rag.rerank.enabled && rerank.available；
 * finalK = rerankEnabled ? rag.rerank.topK : rag.context.topK。
 */
export function resolveRagParams(ctx: RagResolveContext, userId: number): ResolvedRagParams {
  const rag = getRagSettings(ctx, userId);
  const rerankEnabled = rag.rerank.enabled && ctx.rerank.available;
  return {
    searchTopK: rag.search.topK,
    searchFinalK: rag.search.finalK,
    searchMode: rag.search.defaultMode,
    topN: rag.rerank.topN,
    finalK: rerankEnabled ? rag.rerank.topK : rag.context.topK,
    rerankEnabled,
  };
}

/** 能力状态快照（设置页「能力状态卡」数据源） */
export function ragStatus(ctx: RagStatusContext, userId: number): RagStatus {
  const effective = getRagSettings(ctx, userId);
  const resolved = resolveRagParams(ctx, userId);
  // 结构级参数仅在偏离默认时给出提示；默认态 = 空数组（T04 条件化）
  const structuralHint: string[] = [];
  if (ctx.embedding.kind !== 'local') {
    structuralHint.push('embedding.provider 需重启生效');
  }
  if (ctx.rerank.kind !== DEFAULT_RERANK_PROVIDER) {
    structuralHint.push('rerank.provider 需重启生效');
  }
  if (ctx.config.chunk.size !== DEFAULT_CHUNK_SIZE || ctx.config.chunk.overlap !== DEFAULT_CHUNK_OVERLAP) {
    structuralHint.push('chunk.size/overlap 修改后需重建索引');
  }
  if (!ctx.db.vecAvailable) {
    structuralHint.push('语义检索不可用：sqlite-vec 未装载');
  }
  return {
    embedding: {
      provider: ctx.embedding.kind,
      model: ctx.embedding.model,
      available: ctx.embedding.available,
      dim: ctx.embedding.dim,
    },
    rerankProvider: {
      provider: ctx.rerank.kind,
      model: ctx.rerank.model,
      available: ctx.rerank.available,
    },
    vecAvailable: ctx.db.vecAvailable,
    chunk: { size: ctx.config.chunk.size, overlap: ctx.config.chunk.overlap },
    effective,
    resolved,
    structuralHint,
  };
}
