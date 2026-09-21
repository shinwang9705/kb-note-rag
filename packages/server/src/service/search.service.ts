/**
 * 检索服务：关键词通道（FTS5 + LIKE 兜底）与语义通道（sqlite-vec）融合。
 *
 * 关键设计：
 *   1. 两条通道独立取候选，用加权 RRF 融合 —— 不做分数归一化，
 *      因为 bm25 / 覆盖率 / 余弦距离 三者量纲完全不同，硬归一会被单一通道绑架。
 *   2. 向量通道是**增强**：provider 不可用或 sqlite-vec 未装载时自动降级为纯关键词，
 *      接口照常返回结果，只是 mode 变成 'keyword'。前端据此显示模式横幅。
 *   3. snippet 用偏移量而不是 HTML 标签表达高亮（见 shared/types.ts 的说明）。
 */
import type { SearchHit, SearchMode, SearchResult } from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import { searchByFts, searchByLike, searchByVector, type RawHit } from '../repo/search.repo.js';
import { tokenizeQuery } from '../search/tokenize.js';
import { excerpt } from '../util/text.js';
import { getRagSettings } from './rag.service.js';

export interface SearchContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
}

export interface SearchInput {
  userId: number;
  query: string;
  /** 限定在某个知识库内检索；null 表示全库 */
  libraryId?: number | null;
  /** 限定在某个文档内检索；null 表示不限定 */
  docId?: number | null;
  /** 期望模式；'auto' 或不传表示按能力自动降级 */
  mode?: SearchMode | 'auto';
  /** 单通道候选数 */
  topK?: number;
  /** 最终返回条数 */
  finalK?: number;
}

/** 检索结果：SearchResult 加上排障用的告警信息 */
export interface SearchOutcome extends SearchResult {
  /** 通道级错误（FTS 语法错误、向量检索失败等），不阻断整体返回 */
  warnings?: string[];
}

/** 是否具备向量检索能力 */
export function isVectorReady(db: DbHandle, provider: EmbeddingProvider): boolean {
  return db.vecAvailable && provider.available;
}

/**
 * 把期望模式解析为实际可用模式。
 * 请求 hybrid/vector 但向量不可用时，静默降级为 keyword，不报错。
 */
export function resolveSearchMode(
  requested: SearchMode | 'auto' | undefined,
  db: DbHandle,
  provider: EmbeddingProvider,
): SearchMode {
  const vecReady = isVectorReady(db, provider);
  if (!requested || requested === 'auto') return vecReady ? 'hybrid' : 'keyword';
  if (requested === 'keyword') return 'keyword';
  if (requested === 'vector') return vecReady ? 'vector' : 'keyword';
  return vecReady ? 'hybrid' : 'keyword';
}

/** RRF 常数，越大则排名靠前的优势越弱 */
const RRF_K = 60;
/** 各通道权重：向量略高（语义更贴近意图），LIKE 略低（易误召回） */
const CHANNEL_WEIGHT = { fts: 1, like: 0.8, vec: 1.2 } as const;

interface FusedEntry {
  hit: RawHit;
  score: number;
  channels: Set<'fts' | 'like' | 'vec'>;
}

/** 加权 RRF 融合 */
function fuse(channels: Array<{ name: 'fts' | 'like' | 'vec'; hits: readonly RawHit[] }>): FusedEntry[] {
  const merged = new Map<number, FusedEntry>();

  for (const channel of channels) {
    channel.hits.forEach((hit, index) => {
      const key = Number(hit.chunkId);
      const existing = merged.get(key);
      const contribution = CHANNEL_WEIGHT[channel.name] / (RRF_K + index + 1);
      if (existing) {
        existing.score += contribution;
        existing.channels.add(channel.name);
      } else {
        merged.set(key, { hit, score: contribution, channels: new Set([channel.name]) });
      }
    });
  }

  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export interface SnippetParts {
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
}

const SNIPPET_MAX = 160;
const SNIPPET_LEAD = 40;

/** 无 FTS snippet 时，围绕首个命中词手工截取 */
function buildSnippet(content: string, terms: readonly string[]): SnippetParts {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (terms.length === 0 || flat.length === 0) {
    return { snippet: excerpt(flat, SNIPPET_MAX), highlightStart: -1, highlightEnd: -1 };
  }

  // 长词优先：命中"数据备份"比命中"数据"更贴近意图
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  let bestIndex = -1;
  let bestTerm = '';
  for (const term of sorted) {
    const index = flat.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
      bestTerm = term;
    }
  }

  if (bestIndex < 0) {
    return { snippet: excerpt(flat, SNIPPET_MAX), highlightStart: -1, highlightEnd: -1 };
  }

  const start = Math.max(0, bestIndex - SNIPPET_LEAD);
  const end = Math.min(flat.length, start + SNIPPET_MAX);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return {
    snippet: `${prefix}${flat.slice(start, end)}${suffix}`,
    highlightStart: prefix.length + (bestIndex - start),
    highlightEnd: prefix.length + (bestIndex - start) + bestTerm.length,
  };
}

/**
 * 执行检索。
 * 返回 SearchResult，其中 stats 记录各通道原始命中数，便于排查"为什么搜不到"。
 */
export async function search(ctx: SearchContext, input: SearchInput): Promise<SearchOutcome> {
  const startedAt = Date.now();
  const { db, config, embedding } = ctx;

  const tokens = tokenizeQuery(input.query);
  // 运行级实时参数：请求显式传参优先；未传时用三层合并后的 rag 默认值（stored.rag > env > 常量）
  const rag = getRagSettings({ db, config }, input.userId);
  const requestedMode = input.mode && input.mode !== 'auto' ? input.mode : rag.search.defaultMode;
  let mode = resolveSearchMode(requestedMode, db, embedding);
  const topK = Math.min(Math.max(1, Math.trunc(input.topK ?? rag.search.topK)), 100);
  const finalK = Math.min(Math.max(1, Math.trunc(input.finalK ?? rag.search.finalK)), 50);
  const libraryId = input.libraryId ?? null;
  const docId = input.docId ?? null;

  const ftsEnabled = mode === 'keyword' || mode === 'hybrid';
  const vecEnabled = mode === 'vector' || mode === 'hybrid';

  // ---------- 关键词通道 ----------
  let ftsHits: RawHit[] = [];
  let ftsError: string | null = null;
  if (ftsEnabled && tokens.ftsPhrase) {
    try {
      ftsHits = searchByFts(db, input.userId, tokens.ftsPhrase, topK, libraryId, docId);
    } catch (error) {
      ftsError = error instanceof Error ? error.message : String(error);
      // FTS 挂了不能让整个检索失败，交给 LIKE 兜底
    }
  }

  // FTS 无命中时启用 LIKE 兜底（1-2 字中文、trigram 无法覆盖的短查询、FTS 报错）
  let likeHits: RawHit[] = [];
  const needLike = ftsEnabled && (ftsHits.length < finalK || ftsError !== null);
  if (needLike && tokens.terms.length > 0) {
    try {
      likeHits = searchByLike(db, input.userId, tokens.terms, topK, libraryId, docId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ftsError = ftsError ? `${ftsError}；${message}` : message;
    }
  }

  // ---------- 语义通道 ----------
  let vecHits: RawHit[] = [];
  let vecError: string | null = null;
  if (vecEnabled && isVectorReady(db, embedding)) {
    try {
      const queryVector = await embedding.embedQuery(tokens.raw);
      if (queryVector.length !== embedding.dim || !queryVector.every(Number.isFinite) || !queryVector.some((v) => v !== 0)) {
        throw new Error('向量模型未返回有效向量，已降级关键词检索');
      }
      vecHits = searchByVector(db, input.userId, queryVector, topK, libraryId, docId);
    } catch (error) {
      vecError = error instanceof Error ? error.message : String(error);
    }
  }

  if (vecError) {
    mode = 'keyword';
    // vector-only 请求运行中失败时也必须真正执行关键词兜底。
    if (!ftsEnabled) {
      try {
        if (tokens.ftsPhrase) ftsHits = searchByFts(db, input.userId, tokens.ftsPhrase, topK, libraryId, docId);
      } catch (error) { ftsError = error instanceof Error ? error.message : String(error); }
      try {
        if (ftsHits.length < finalK) likeHits = searchByLike(db, input.userId, tokens.terms, topK, libraryId, docId);
      } catch (error) { ftsError = error instanceof Error ? error.message : String(error); }
    }
  }
  // LIKE 是关键词通道补充，不能为同一条 FTS 命中重复加权。
  const ftsIds = new Set(ftsHits.map((hit) => hit.chunkId));
  likeHits = likeHits.filter((hit) => !ftsIds.has(hit.chunkId));

  // ---------- 融合 ----------
  const channels: Array<{ name: 'fts' | 'like' | 'vec'; hits: readonly RawHit[] }> = [];
  if (ftsHits.length > 0) channels.push({ name: 'fts', hits: ftsHits });
  if (likeHits.length > 0) channels.push({ name: 'like', hits: likeHits });
  if (vecHits.length > 0) channels.push({ name: 'vec', hits: vecHits });

  const fused = fuse(channels).slice(0, finalK);

  const hits: SearchHit[] = fused.map((entry) => {
    // 统一由 JS 构造片段：三条通道表现一致，且不依赖 FTS5 的 snippet() 辅助函数
    const parts = buildSnippet(entry.hit.content, tokens.terms);
    const hasVec = entry.channels.has('vec');
    const hasKeyword = entry.channels.has('fts') || entry.channels.has('like');
    return {
      chunkId: Number(entry.hit.chunkId),
      docId: Number(entry.hit.docId),
      docTitle: entry.hit.docTitle ?? '',
      snippet: parts.snippet,
      score: Number(entry.score.toFixed(6)),
      charStart: Number(entry.hit.charStart),
      charEnd: Number(entry.hit.charEnd),
      seq: Number(entry.hit.seq),
      highlightStart: parts.highlightStart,
      highlightEnd: parts.highlightEnd,
      source: hasVec && hasKeyword ? 'both' : hasVec ? 'vec' : 'fts',
      ...(entry.hit.sectionPath ? { sectionPath: entry.hit.sectionPath } : {}),
    };
  });

  return {
    query: tokens.raw,
    mode,
    hits,
    tookMs: Date.now() - startedAt,
    // 兜底判定：FTS 通道没出结果，是 LIKE 把结果救回来的
    fallbackLike: ftsHits.length === 0 && likeHits.length > 0,
    stats: { fts: ftsHits.length, vec: vecHits.length, like: likeHits.length },
    ...(ftsError || vecError
      ? { warnings: [ftsError, vecError].filter((item): item is string => Boolean(item)) }
      : {}),
  };
}
