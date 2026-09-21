/**
 * 三期 LLM 声明式能力目录类型（与二期 llm/types.ts 并存，互不冲突）。
 *
 * 边界：本批次（T01+T02）只定义类型与声明数据，暂不被任何调用消费；
 *       T04 再做 OpenAICompatAdapter / Router / ModelGateway 把它们用起来。
 *
 * 关键设计：
 *   1. ProviderProfile 把厂商方言差异全部收敛到声明式配置对象 —— 新增厂商只写一个对象（≤60 行）；
 *   2. NormalizedError 是跨端错误归一化类型（单一数据源在 @kb/shared，这里 re-export 便于 llm 层内聚）。
 */
import type { ErrorKind, NormalizedError, ProviderId, SuggestedAction } from '@kb/shared';

export type { ErrorKind, NormalizedError, ProviderId, SuggestedAction };

export type ApiKind = 'openai-compat';

/** 各家 reasoning 内容的方言差异（adapter 据此分流到 reasoning_delta） */
export type ReasoningMode = 'none' | 'reasoning_content' | 'reasoning' | 'thinking_blocks' | 'inline_tag';

export interface ProviderAuthScheme {
  header: 'Authorization';
  prefix: 'Bearer ';
}

export interface ProviderReasoning {
  mode: ReasoningMode;
  /** 兜底：正文内 <think>…</think> 剥离 */
  inlineTag?: { open: string; close: string };
}

export interface ProviderQuirks {
  streamOptionsUsage: boolean;
  supportsJsonMode: boolean;
  jsonModeNeedsKeyword: boolean;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  forbidTemperatureWhenReasoning: boolean;
  requiresUserAlternation: boolean;
  sseKeepAliveComment: boolean;
}

export interface ModelProfile {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  supportsJsonMode: boolean;
  supportsStop: boolean;
  tags: Array<'chat' | 'reasoning' | 'long-context'>;
}

export interface ProviderProfile {
  id: ProviderId;
  displayName: string;
  apiKind: ApiKind;
  baseUrl: string;
  authScheme: ProviderAuthScheme;
  reasoning: ProviderReasoning;
  quirks: ProviderQuirks;
  models: ModelProfile[];
  limits?: { rpm: number; tpm: number };
  pricing?: { inputPerMTokensCNY: number; outputPerMTokensCNY: number };
  docsUrl: string;
  keyFormatHint: string;
}

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestParams {
  temperature: number;
  topP: number;
  maxTokens: number;
  stop?: string[];
}

export interface ChatRequest {
  providerId: ProviderId;
  model: string;
  messages: ChatRequestMessage[];
  params: ChatRequestParams;
  responseFormat?: 'text' | 'json_object';
  meta: { purpose: 'chat' | 'thinking' | 'summary'; conversationId?: number };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export type ChatStreamEvent =
  | { type: 'start'; responseId: string; model: string; providerId: ProviderId }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; finishReason: 'stop' | 'length' | 'aborted' | 'error'; usage?: TokenUsage }
  | { type: 'error'; error: NormalizedError };
