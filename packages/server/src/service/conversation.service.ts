/**
 * 多轮对话编排服务（三期 T02 + T03 + T04）。
 *
 * 核心职责：
 *   1. 会话 CRUD 的门面（参数面板归一化）；
 *   2. sendMessage：chat 模式 = 多轮上下文装配 + 裁剪/摘要 + 挂载知识库 + 走 ModelGateway 流式；
 *                  agent 模式 = 驱动深度思考引擎（thinking/engine，内部也走 ModelGateway）；
 *   3. abort：进程内 RunRegistry（Map<conversationId, AbortController>）。
 */
import type {
  Conversation,
  ConversationMode,
  ConversationSummary,
  GenerationParams,
  KbScope,
  MessageCitation,
  MessageView,
  NormalizedError,
  ProviderId,
  ThinkingEvent,
  ThinkingRun,
} from '@kb/shared';
import {
  CONTEXT_TRIM_KEEP_HEAD,
  CONTEXT_TRIM_KEEP_TAIL,
  DEFAULT_GENERATION_PARAMS,
  GENERATION_MAX_TOKENS_MAX,
  GENERATION_MAX_TOKENS_MIN,
  GENERATION_TEMPERATURE_MAX,
  GENERATION_TEMPERATURE_MIN,
  GENERATION_THINKING_ROUNDS_MAX,
  GENERATION_THINKING_ROUNDS_MIN,
  GENERATION_TOP_P_MAX,
  GENERATION_TOP_P_MIN,
} from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import type { RerankProvider } from '../rerank/types.js';
import type { ChatRequestMessage } from '../llm/catalog.js';
import { resolveDefaultProvider } from '../llm/index.js';
import type { GatewayRequest, ModelGateway, ResolvedTarget } from '../llm/router.js';
import { GatewayError, normalizedToCode } from '../llm/errors.js';
import { resolveModelContextWindow } from '../llm/providers/index.js';
import * as conversationRepo from '../repo/conversation.repo.js';
import * as messageRepo from '../repo/message.repo.js';
import * as thinkingRepo from '../repo/thinking.repo.js';
import { getContextChunks } from '../repo/chat.repo.js';
import { createThinkingEngine } from '../thinking/engine.js';
import { buildBudget } from '../thinking/budget.js';
import type { ThinkingRequest } from '../thinking/types.js';
import { ApiError } from '../http/errors.js';
import { excerpt } from '../util/text.js';
import { estimateMessagesTokens, estimateTokens } from '../util/token.js';
import { search } from './search.service.js';
import { resolveRagParams } from './rag.service.js';
import { assembleContext as assembleRagContext, type RankedChunk } from './rag-pipeline.js';

export interface ConversationServiceContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
  gateway: ModelGateway;
}

export type ConversationSseEvent =
  | { type: 'start'; conversation: Conversation; userMessage: MessageView; assistantMessageId: number }
  | { type: 'content_delta'; text: string }
  | { type: 'context_trimmed'; droppedCount: number }
  | { type: 'done'; message: MessageView }
  | { type: 'error'; code: string; message: string };

export type ConversationStreamEvent = ConversationSseEvent | ThinkingEvent;

const DEFAULT_CONTEXT_WINDOW = 32768;
const KNOWLEDGE_BUDGET_RATIO = 0.25;
const SAFETY_MARGIN_RATIO = 0.08;
const SUMMARY_MAX_TOKENS = 300;
const MAX_HISTORY_MESSAGES = 200;

const CHAT_SYSTEM_PROMPT =
  '你是 kb-note 的多轮对话助手。请结合对话历史连贯、准确地回答用户问题，语言简洁清晰，不要编造事实。';
const RAG_SYSTEM_PROMPT =
  '回答中引用知识库资料时，用 [1][2] 形式标注引用编号；只能依据【参考资料】回答，资料不足时如实说明。';

const activeRuns = new Map<number, AbortController>();

export function abortConversation(conversationId: number): boolean {
  const controller = activeRuns.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isConversationStreaming(conversationId: number): boolean {
  return activeRuns.has(conversationId);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.trunc(clamp(value, min, max));
}

export function normalizeGenerationParams(partial?: Partial<GenerationParams>): GenerationParams {
  const merged = { ...DEFAULT_GENERATION_PARAMS, ...(partial ?? {}) };
  return {
    temperature: clamp(merged.temperature, GENERATION_TEMPERATURE_MIN, GENERATION_TEMPERATURE_MAX),
    topP: clamp(merged.topP, GENERATION_TOP_P_MIN, GENERATION_TOP_P_MAX),
    maxTokens: clampInt(merged.maxTokens, GENERATION_MAX_TOKENS_MIN, GENERATION_MAX_TOKENS_MAX),
    thinkingRounds: clampInt(
      merged.thinkingRounds,
      GENERATION_THINKING_ROUNDS_MIN,
      GENERATION_THINKING_ROUNDS_MAX,
    ),
  };
}

export interface CreateConversationInput {
  userId: number;
  title?: string;
  mode?: ConversationMode;
  providerId?: string;
  model?: string;
  params?: Partial<GenerationParams>;
  kbEnabled?: boolean;
  kbScope?: KbScope | null;
}

export function createConversation(ctx: ConversationServiceContext, input: CreateConversationInput): Conversation {
  return conversationRepo.createConversation(ctx.db, input.userId, {
    title: input.title,
    mode: input.mode ?? 'chat',
    providerId: input.providerId ?? '',
    model: input.model ?? '',
    params: normalizeGenerationParams(input.params),
    kbEnabled: input.kbEnabled ?? false,
    kbScope: input.kbScope ?? null,
  });
}

export interface PatchConversationInput {
  userId: number;
  conversationId: number;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  params?: Partial<GenerationParams>;
  kbScope?: KbScope | null;
  kbEnabled?: boolean;
  providerId?: string;
  model?: string;
}

export function patchConversation(ctx: ConversationServiceContext, input: PatchConversationInput): Conversation {
  const existing = conversationRepo.getConversation(ctx.db, input.userId, input.conversationId);
  if (!existing) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);

  const updated = conversationRepo.patchConversation(ctx.db, input.userId, input.conversationId, {
    title: input.title,
    pinned: input.pinned,
    archived: input.archived,
    // 先合并现有 params 再归一化，避免只传部分参数时未覆盖项被重置为默认值
    params: input.params ? normalizeGenerationParams({ ...existing.params, ...input.params }) : undefined,
    kbScope: input.kbScope,
    kbEnabled: input.kbEnabled,
    providerId: input.providerId,
    model: input.model,
  });
  if (!updated) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
  return updated;
}

// ---------------------------------------------------------------------------
// 上下文装配（chat 模式）
// ---------------------------------------------------------------------------
interface HistoryItem {
  seq: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface AssembledContext {
  messages: ChatRequestMessage[];
  droppedCount: number;
  citations: MessageCitation[];
  summary: ConversationSummary | null;
}

interface TrimResult {
  messages: HistoryItem[];
  droppedCount: number;
  summary: ConversationSummary | null;
}

async function summarizeMiddle(
  ctx: ConversationServiceContext,
  userId: number,
  previousSummary: string | null,
  middle: readonly HistoryItem[],
  signal: AbortSignal,
): Promise<string> {
  const transcript = middle
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
    .join('\n');
  const prefix = previousSummary ? `【更早对话摘要】\n${previousSummary}\n\n` : '';
  const prompt = `${prefix}以下是对话的中段内容，请用不超过 200 字概括其要点（供后续继续对话使用）：\n\n${transcript}`;

  const target = await resolveDefaultProvider(ctx.gateway, userId);
  if (!target) return '（中段对话）';
  try {
    const result = await ctx.gateway.chat(
      {
        providerId: target.providerId,
        model: target.model,
        messages: [{ role: 'user', content: prompt }],
        params: { temperature: 0.3, topP: 1, maxTokens: SUMMARY_MAX_TOKENS },
        meta: { purpose: 'summary' },
        userId,
      },
      signal,
    );
    return (result.content ?? '').trim() || '（中段对话）';
  } catch {
    return '（中段对话）';
  }
}

async function trimHistory(
  ctx: ConversationServiceContext,
  conversation: Conversation,
  history: readonly MessageView[],
  budgetTokens: number,
  signal: AbortSignal,
): Promise<TrimResult> {
  const items: HistoryItem[] = history
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      seq: message.seq,
      role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user',
      content: message.content,
    }));

  const totalTokens = items.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  if (totalTokens <= budgetTokens || items.length <= CONTEXT_TRIM_KEEP_HEAD) {
    return { messages: items, droppedCount: 0, summary: null };
  }

  const head = items.slice(0, CONTEXT_TRIM_KEEP_HEAD);
  const tail = items.slice(-CONTEXT_TRIM_KEEP_TAIL);
  const middle = items.slice(CONTEXT_TRIM_KEEP_HEAD, items.length - CONTEXT_TRIM_KEEP_TAIL);

  let summary: ConversationSummary | null = null;
  if (middle.length > 0) {
    const text = await summarizeMiddle(ctx, conversation.userId, conversation.summary?.text ?? null, middle, signal);
    summary = { text, upToSeq: middle[middle.length - 1]?.seq ?? items[items.length - 1]?.seq ?? 0 };
  }

  let kept = [...head, ...tail];
  let droppedCount = items.length - kept.length;

  let keptTokens =
    kept.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
    estimateTokens(summary?.text ?? '');
  while (keptTokens > budgetTokens && kept.length > 1) {
    kept = kept.slice(1);
    droppedCount += 1;
    keptTokens =
      kept.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
      estimateTokens(summary?.text ?? '');
  }

  return { messages: kept, droppedCount, summary };
}

interface KnowledgeResult {
  section: string;
  citations: MessageCitation[];
}

async function buildKnowledge(
  ctx: ConversationServiceContext,
  conversation: Conversation,
  query: string,
  budgetTokens: number,
): Promise<KnowledgeResult> {
  const params = resolveRagParams(ctx, conversation.userId);
  const topN = params.topN;
  const finalK = Math.min(Math.max(1, params.finalK), topN);
  const scope = conversation.kbScope;
  const singleDocId = scope?.documentIds?.length === 1 ? scope.documentIds[0] : null;
  const searchResult = await search(ctx, {
    userId: conversation.userId,
    query,
    libraryId: scope?.libraryId ?? null,
    docId: singleDocId ?? null,
    mode: 'auto',
    topK: topN,
    finalK: topN,
  });

  if (searchResult.hits.length === 0) return { section: '', citations: [] };

  const assembled = await assembleRagContext(
    { rerank: ctx.rerank, getContextChunks, db: ctx.db, rerankEnabled: params.rerankEnabled },
    { userId: conversation.userId, query, hits: searchResult.hits, finalK },
  );
  const ordered = assembled.chunks;
  if (ordered.length === 0) return { section: '', citations: [] };

  const picked: RankedChunk[] = [];
  let used = 0;
  for (const chunk of ordered) {
    const cost = estimateTokens(chunk.content) + 20;
    if (picked.length > 0 && used + cost > budgetTokens) break;
    picked.push(chunk);
    used += cost;
  }
  if (picked.length === 0 && ordered.length > 0) picked.push(ordered[0] as RankedChunk);

  const section =
    '【参考资料】\n' +
    picked.map((chunk, index) => `[${index + 1}] 《${chunk.docTitle}》\n${chunk.content}`).join('\n\n');

  const citations: MessageCitation[] = picked.map((chunk) => {
    const hit = searchResult.hits.find((candidate) => candidate.chunkId === chunk.chunkId);
    return {
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      snippet: excerpt(chunk.content, 160),
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      score: hit?.score ?? 0,
      ...(chunk.sectionPath ? { sectionPath: chunk.sectionPath } : {}),
    };
  });

  return { section, citations };
}

async function assembleContext(
  ctx: ConversationServiceContext,
  conversation: Conversation,
  query: string,
  params: GenerationParams,
  signal: AbortSignal,
  historyBeforeSeq: number,
): Promise<AssembledContext> {
  const contextWindow =
    resolveModelContextWindow(conversation.model) ??
    DEFAULT_CONTEXT_WINDOW;
  const outputTokens = params.maxTokens;
  const systemPrompt = CHAT_SYSTEM_PROMPT + (conversation.kbEnabled ? RAG_SYSTEM_PROMPT : '');
  const systemTokens = estimateTokens(systemPrompt);
  const knowledgeBudget = Math.floor(contextWindow * KNOWLEDGE_BUDGET_RATIO);
  const safetyMargin = Math.floor(contextWindow * SAFETY_MARGIN_RATIO);
  const historyBudget = Math.max(0, contextWindow - outputTokens - systemTokens - knowledgeBudget - safetyMargin);

  let knowledgeSection = '';
  let citations: MessageCitation[] = [];
  if (conversation.kbEnabled) {
    const knowledge = await buildKnowledge(ctx, conversation, query, knowledgeBudget);
    knowledgeSection = knowledge.section;
    citations = knowledge.citations;
  }

  const history = messageRepo.listMessages(ctx.db, conversation.userId, conversation.id, {
    limit: MAX_HISTORY_MESSAGES,
    beforeSeq: historyBeforeSeq,
  });
  const trimmed = await trimHistory(ctx, conversation, history, historyBudget, signal);

  const messages: ChatRequestMessage[] = [{ role: 'system', content: systemPrompt }];
  if (trimmed.summary) {
    messages.push({ role: 'system', content: `【较早对话摘要】\n${trimmed.summary.text}` });
  }
  for (const item of trimmed.messages) {
    messages.push({ role: item.role, content: item.content });
  }
  messages.push({
    role: 'user',
    content: knowledgeSection ? `${knowledgeSection}\n\n【用户问题】\n${query}` : query,
  });

  return { messages, droppedCount: trimmed.droppedCount, citations, summary: trimmed.summary };
}

// ---------------------------------------------------------------------------
// 错误归一化
// ---------------------------------------------------------------------------
function errorInfoOf(error: unknown): { code: string; message: string } {
  if (error instanceof GatewayError) return normalizedToCode(error.normalized);
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
}

function normalizeStreamError(error: unknown): NormalizedError {
  if (error instanceof GatewayError) return error.normalized;
  return { kind: 'unknown', userMessage: error instanceof Error ? error.message : '生成失败', retryable: false };
}

// ---------------------------------------------------------------------------
// 目标供应商解析
// ---------------------------------------------------------------------------
async function resolveConversationTarget(ctx: ConversationServiceContext, conversation: Conversation): Promise<ResolvedTarget> {
  if (conversation.providerId) {
    try {
      return await ctx.gateway.resolve(conversation.userId, {
        kind: 'pinned',
        providerId: conversation.providerId as ProviderId,
        model: conversation.model,
      });
    } catch {
      /* 会话指定的供应商不可用则回退默认 */
    }
  }
  const target = await resolveDefaultProvider(ctx.gateway, conversation.userId);
  if (!target) throw new ApiError('LLM_NOT_CONFIGURED', '问答服务未配置', 404);
  return target;
}

// ---------------------------------------------------------------------------
// 多轮消息主流程
// ---------------------------------------------------------------------------
export interface SendMessageInput {
  userId: number;
  conversationId: number;
  content: string;
  mode?: ConversationMode;
}

export async function sendMessage(
  ctx: ConversationServiceContext,
  input: SendMessageInput,
  emit: (event: ConversationStreamEvent) => void,
): Promise<void> {
  const conversation = conversationRepo.getConversation(ctx.db, input.userId, input.conversationId);
  if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);

  if (isConversationStreaming(conversation.id)) {
    throw new ApiError('STREAM_IN_PROGRESS', '该会话已有消息正在生成中', 409);
  }

  const isAgent = (input.mode ?? conversation.mode) === 'agent';
  const controller = new AbortController();
  activeRuns.set(conversation.id, controller);

  try {
    if (isAgent) {
      await runAgent(ctx, conversation, input, controller, emit);
    } else {
      await runChat(ctx, conversation, input, controller, emit);
    }
  } catch (error) {
    const info = errorInfoOf(error);
    emit({ type: 'error', code: info.code, message: info.message });
  } finally {
    activeRuns.delete(conversation.id);
  }
}

async function runChat(
  ctx: ConversationServiceContext,
  conversation: Conversation,
  input: SendMessageInput,
  controller: AbortController,
  emit: (event: ConversationStreamEvent) => void,
): Promise<void> {
  const params = conversation.params;
  const startedAt = Date.now();
  let assistantId = 0;
  let content = '';
  let citations: MessageCitation[] = [];

  try {
    const target = await resolveConversationTarget(ctx, conversation);

    const userMessage = messageRepo.appendMessage(ctx.db, input.userId, {
      conversationId: conversation.id,
      role: 'user',
      content: input.content,
      status: 'done',
    });
    const assistant = messageRepo.appendMessage(ctx.db, input.userId, {
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    assistantId = assistant.id;
    emit({ type: 'start', conversation, userMessage, assistantMessageId: assistantId });

    const assembled = await assembleContext(ctx, conversation, input.content, params, controller.signal, userMessage.seq);
    citations = assembled.citations;
    if (assembled.droppedCount > 0) emit({ type: 'context_trimmed', droppedCount: assembled.droppedCount });
    if (assembled.summary) {
      conversationRepo.updateConversationSummary(ctx.db, input.userId, conversation.id, assembled.summary);
    }

    const request: GatewayRequest = {
      providerId: target.providerId,
      model: target.model,
      messages: assembled.messages,
      params: { temperature: params.temperature, topP: params.topP, maxTokens: params.maxTokens },
      meta: { purpose: 'chat', conversationId: conversation.id },
      userId: input.userId,
    };

    let tokenIn = 0;
    let tokenOut = 0;
    let finishReason: string | null = null;
    let streamError: NormalizedError | null = null;

    try {
      for await (const event of ctx.gateway.chatStream(request, controller.signal)) {
        if (event.type === 'content_delta') {
          content += event.text;
          emit({ type: 'content_delta', text: event.text });
        } else if (event.type === 'usage') {
          tokenIn = event.usage.inputTokens;
          tokenOut = event.usage.outputTokens;
        } else if (event.type === 'finish') {
          finishReason = event.finishReason;
        } else if (event.type === 'error') {
          streamError = event.error;
          break;
        }
      }
    } catch (error) {
      streamError = normalizeStreamError(error);
    }

    if (controller.signal.aborted || finishReason === 'aborted') {
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistantId, {
        content,
        status: 'aborted',
        citations,
        model: target.model,
        providerId: target.providerId,
        latencyMs: Date.now() - startedAt,
        error: { code: 'ABORTED', message: '已停止生成' },
      });
      emit({ type: 'error', code: 'ABORTED', message: '已停止生成' });
      return;
    }

    if (streamError) {
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistantId, {
        content,
        status: 'failed',
        citations,
        model: target.model,
        providerId: target.providerId,
        latencyMs: Date.now() - startedAt,
        error: { code: normalizedToCode(streamError).code, message: streamError.userMessage },
      });
      const code = normalizedToCode(streamError);
      emit({ type: 'error', code: code.code, message: code.message });
      return;
    }

    tokenIn = tokenIn || estimateMessagesTokens(assembled.messages);
    tokenOut = tokenOut || estimateTokens(content);
    const completed = messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistantId, {
      content,
      status: 'done',
      citations,
      model: target.model,
      providerId: target.providerId,
      tokenIn,
      tokenOut,
      latencyMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    });
    conversationRepo.addConversationUsage(ctx.db, input.userId, conversation.id, tokenIn, tokenOut);
    if (completed) emit({ type: 'done', message: completed });
  } catch (error) {
    if (assistantId) {
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistantId, {
        content,
        status: 'failed',
        citations,
        latencyMs: Date.now() - startedAt,
        error: errorInfoOf(error),
      });
    }
    const info = errorInfoOf(error);
    emit({ type: 'error', code: info.code, message: info.message });
  }
}

async function runAgent(
  ctx: ConversationServiceContext,
  conversation: Conversation,
  input: SendMessageInput,
  controller: AbortController,
  emit: (event: ConversationStreamEvent) => void,
): Promise<void> {
  const startedAt = Date.now();

  const userMessage = messageRepo.appendMessage(ctx.db, input.userId, {
    conversationId: conversation.id,
    role: 'user',
    content: input.content,
    status: 'done',
  });
  const assistant = messageRepo.appendMessage(ctx.db, input.userId, {
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
  });
  emit({ type: 'start', conversation, userMessage, assistantMessageId: assistant.id });

  const budget = buildBudget(conversation.params, ctx.config);
  const engine = createThinkingEngine({
    db: ctx.db,
    config: ctx.config,
    gateway: ctx.gateway,
    rerank: ctx.rerank,
    search: (searchInput) => search(ctx, searchInput),
    chatRepo: { getContextChunks },
    thinkingRepo,
    logger: null,
  });
  const request: ThinkingRequest = {
    conversationId: conversation.id,
    messageId: assistant.id,
    userId: input.userId,
    query: input.content,
    budget,
    kbScope: conversation.kbEnabled ? conversation.kbScope : null,
    temperature: conversation.params.temperature,
    maxTokens: conversation.params.maxTokens,
  };

  let finalContent = '';
  const outcome: {
    completedRun: ThinkingRun | null;
    abortedRun: { runId: number; completedRounds: number; resumable: boolean } | null;
  } = { completedRun: null, abortedRun: null };

  try {
    await engine.run(request, controller.signal, (event) => {
      if (event.type === 'final_delta') finalContent += event.text;
      if (event.type === 'run_completed') outcome.completedRun = event.run;
      if (event.type === 'run_aborted') outcome.abortedRun = event;
      emit(event);
    });

    if (outcome.abortedRun) {
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistant.id, {
        content: finalContent,
        status: 'aborted',
        thinkingRunId: outcome.abortedRun.runId,
        latencyMs: Date.now() - startedAt,
      });
    } else if (outcome.completedRun) {
      const completedRun = outcome.completedRun;
      const content = finalContent || completedRun.finalContent;
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistant.id, {
        content,
        status: completedRun.status === 'completed' ? 'done' : 'failed',
        thinkingRunId: completedRun.id,
        tokenIn: completedRun.consumedIn,
        tokenOut: completedRun.consumedOut,
        latencyMs: completedRun.consumedMs || Date.now() - startedAt,
        completedAt: new Date().toISOString(),
      });
      conversationRepo.addConversationUsage(ctx.db, input.userId, conversation.id, completedRun.consumedIn, completedRun.consumedOut);
    } else {
      messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistant.id, {
        content: finalContent,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    messageRepo.updateMessage(ctx.db, input.userId, conversation.id, assistant.id, {
      content: finalContent,
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      error: errorInfoOf(error),
    });
    const info = errorInfoOf(error);
    emit({ type: 'error', code: info.code, message: info.message });
  }
}
