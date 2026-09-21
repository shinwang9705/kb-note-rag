/**
 * 深度思考引擎 server 侧独有类型（跨端类型复用 @kb/shared）。
 *
 * 跨端单一数据源：RoundArtifact / ChangeItem / ThinkingBudget / StopReason /
 * ThinkingEvent / ThinkingRun / NormalizedError 均来自 @kb/shared（T01 已建）。
 * 这里只放引擎/依赖装配等 server 专属契约。
 */
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { GatewayLogger, ModelGateway } from '../llm/router.js';
import type { ContextChunk } from '../repo/chat.repo.js';
import type { RerankProvider } from '../rerank/types.js';
import type * as thinkingRepo from '../repo/thinking.repo.js';
import type { SearchOutcome } from '../service/search.service.js';
import type { KbScope, ThinkingBudget, ThinkingEvent, ThinkingRun } from '@kb/shared';

/** 引擎对外暴露的 run 摘要（B/S 下与持久化的 ThinkingRun 同构） */
export type ThinkingRunSummary = ThinkingRun;

/** 深度思考请求（signal 由 run/resume 的第二个参数单独传入，避免污染请求对象） */
export interface ThinkingRequest {
  conversationId: number;
  /** 终稿落点：assistant 消息 id */
  messageId?: number;
  userId: number;
  query: string;
  providerId?: string;
  model?: string;
  budget: ThinkingBudget;
  kbScope?: KbScope | null;
  /** 单轮生成温度（缺省取 config.generation.temperature） */
  temperature?: number;
  /** 单轮输出 token 上限（缺省由 budget.maxTotalOutputTokens / maxRounds / 1.2 反推） */
  maxTokens?: number;
}

/** 预绑定的检索（服务层已注入 embedding），引擎不感知 embedding 细节 */
export type ThinkingSearch = (input: {
  userId: number;
  query: string;
  libraryId?: number | null;
  docId?: number | null;
  topK?: number;
  finalK?: number;
  mode?: 'auto' | 'keyword' | 'hybrid' | 'vector';
}) => Promise<SearchOutcome>;

/** 回表取正文（薄封装，engine 调用时透传 db） */
export interface ThinkingChatRepo {
  getContextChunks(db: DbHandle, userId: number, chunkIds: readonly number[]): ContextChunk[];
}

export interface ThinkingEngineDeps {
  db: DbHandle;
  config: AppConfig;
  gateway: ModelGateway;
  rerank: RerankProvider;
  search: ThinkingSearch;
  chatRepo: ThinkingChatRepo;
  thinkingRepo: typeof thinkingRepo;
  logger: GatewayLogger | null;
}

export interface ThinkingEngine {
  run(req: ThinkingRequest, signal: AbortSignal, emit: (event: ThinkingEvent) => void): Promise<void>;
  /** userId 用于强制多用户隔离（越权 404）；resume 从 completed_rounds+1 续跑 */
  resume(runId: number, userId: number, signal: AbortSignal, emit: (event: ThinkingEvent) => void): Promise<void>;
  estimate(req: ThinkingRequest): Promise<{ maxInputTokens: number; maxOutputTokens: number }>;
}
