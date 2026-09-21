/**
 * 深度思考引擎编排（三期 T03/T04）。
 *
 * 职责：驱动状态机、每轮构造增量上下文 → ModelGateway.chatStream → 解析产物 →
 * 立即 upsertRound + updateRun（可续跑）→ 早停判定 → 合成终稿。
 */
import type {
  NormalizedError,
  ProviderId,
  RoundArtifact,
  StopReason,
  ThinkingBudget,
  ThinkingEvent,
} from '@kb/shared';
import type { ChatRequestMessage } from '../llm/catalog.js';
import { resolveDefaultProvider } from '../llm/index.js';
import type { GatewayRequest, ResolvedTarget } from '../llm/router.js';
import { GatewayError } from '../llm/errors.js';
import { ApiError } from '../http/errors.js';
import { estimateTokens } from '../util/token.js';
import { parseArtifact } from './artifact-parse.js';
import { canContinue, createUsage, estimateRound, type BudgetUsage } from './budget.js';
import {
  applyRound,
  buildRoundContext,
  createSummaryState,
  rebuildSummaryState,
  summarizeOutline,
  type SummaryState,
} from './delta-context.js';
import { jaccardSimilarity } from './diff.js';
import { createThinkingMachine } from './machine.js';
import { instructionForRound, THINKING_SYSTEM_PROMPT } from './prompts.js';
import { assembleContext } from '../service/rag-pipeline.js';
import { resolveRagParams } from '../service/rag.service.js';
import type { ThinkingEngine, ThinkingEngineDeps, ThinkingRequest } from './types.js';

const ROUND_DELTA_THROTTLE_MS = 30;

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof GatewayError) return error.normalized;
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'aborted', userMessage: '请求已中止', retryable: false };
  }
  return {
    kind: 'unknown',
    userMessage: error instanceof Error ? error.message : '模型调用失败',
    retryable: false,
  };
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

interface StreamedRound {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/** 流式一轮，round_delta 做 30ms 节流 */
async function streamRound(
  deps: ThinkingEngineDeps,
  request: GatewayRequest,
  options: { index: number; signal: AbortSignal },
  emit: (event: ThinkingEvent) => void,
): Promise<StreamedRound> {
  let content = '';
  let pending = '';
  let lastFlush = 0;
  let timer: NodeJS.Timeout | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const flush = (): void => {
    if (pending) {
      emit({ type: 'round_delta', index: options.index, text: pending });
      pending = '';
      lastFlush = Date.now();
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  for await (const event of deps.gateway.chatStream(request, options.signal)) {
    if (event.type === 'content_delta') {
      content += event.text;
      pending += event.text;
      const now = Date.now();
      if (now - lastFlush >= ROUND_DELTA_THROTTLE_MS) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, ROUND_DELTA_THROTTLE_MS);
      }
    } else if (event.type === 'usage') {
      inputTokens = event.usage.inputTokens;
      outputTokens = event.usage.outputTokens;
    } else if (event.type === 'error') {
      flush();
      throw new GatewayError(event.error);
    }
  }
  flush();

  return {
    content,
    inputTokens: inputTokens || request.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
    outputTokens: outputTokens || estimateTokens(content),
  };
}

async function buildKbSection(deps: ThinkingEngineDeps, req: ThinkingRequest): Promise<string | undefined> {
  if (!req.kbScope) return undefined;
  try {
    const params = resolveRagParams(deps, req.userId);
    const topN = params.topN;
    const finalK = Math.min(Math.max(1, params.finalK), topN);
    const result = await deps.search({
      userId: req.userId,
      query: req.query,
      libraryId: req.kbScope.libraryId ?? null,
      docId: req.kbScope.documentIds && req.kbScope.documentIds.length === 1 ? req.kbScope.documentIds[0] : null,
      topK: topN,
      finalK: topN,
      mode: 'auto',
    });
    if (result.hits.length === 0) return undefined;

    const assembled = await assembleContext(
      {
        rerank: deps.rerank,
        getContextChunks: deps.chatRepo.getContextChunks,
        db: deps.db,
        rerankEnabled: params.rerankEnabled,
      },
      { userId: req.userId, query: req.query, hits: result.hits, finalK },
    );
    if (assembled.chunks.length === 0) return undefined;

    return '【参考资料】\n' + assembled.chunks
      .map((chunk, index) => `[${index + 1}] 《${chunk.docTitle}》\n${chunk.content}`)
      .join('\n\n');
  } catch {
    return undefined;
  }
}

async function resolveEngineTarget(deps: ThinkingEngineDeps, req: ThinkingRequest): Promise<ResolvedTarget> {
  if (req.providerId) {
    try {
      return await deps.gateway.resolve(req.userId, {
        kind: 'pinned',
        providerId: req.providerId as ProviderId,
        model: req.model ?? '',
      });
    } catch {
      /* 会话指定供应商不可用则回退默认 */
    }
  }
  const target = await resolveDefaultProvider(deps.gateway, req.userId);
  if (!target) throw new ApiError('LLM_NOT_CONFIGURED', '问答服务未配置', 404);
  return target;
}

function decideEarlyStop(
  budget: ThinkingBudget,
  artifact: RoundArtifact,
  previousOutline: readonly string[],
): { stop: boolean } {
  if (artifact.hasFurtherImprovement === false) return { stop: true };
  if (budget.earlyStopOnConverge && previousOutline.length > 0) {
    const similarity = jaccardSimilarity(previousOutline, artifact.outline);
    if (similarity >= budget.diffConvergeThreshold && artifact.changes.length <= 1) {
      return { stop: true };
    }
  }
  return { stop: false };
}

function synthesize(
  deps: ThinkingEngineDeps,
  userId: number,
  runId: number,
  usage: BudgetUsage,
  summary: SummaryState,
  finalContent: string,
  stopReason: StopReason,
  status: 'completed' | 'failed',
  emit: (event: ThinkingEvent) => void,
): void {
  emit({ type: 'synthesis_started' });
  if (finalContent) emit({ type: 'final_delta', text: finalContent });

  deps.thinkingRepo.updateRun(deps.db, userId, runId, {
    status,
    stopReason,
    finalContent,
    completedRounds: summary.completedRounds,
    consumedIn: usage.inputTokens,
    consumedOut: usage.outputTokens,
    consumedMs: Date.now() - usage.startedAt,
    summaryJson: JSON.stringify(summary),
  });
  const run = deps.thinkingRepo.getRun(deps.db, userId, runId);
  if (run) emit({ type: 'run_completed', run, stopReason });
}

interface RoundLoopContext {
  userId: number;
  runId: number;
  query: string;
  budget: ThinkingBudget;
  maxTokens: number;
  temperature: number;
  strategy: string;
  providerId: ProviderId;
  model: string;
  kbSection?: string;
  startSummary: SummaryState;
  startIndex: number;
}

async function runRounds(
  deps: ThinkingEngineDeps,
  ctx: RoundLoopContext,
  signal: AbortSignal,
  emit: (event: ThinkingEvent) => void,
): Promise<void> {
  const machine = createThinkingMachine('RoundRunning');
  const usage = createUsage();
  let summary = ctx.startSummary;
  let consecutiveFailures = 0;

  for (let index = ctx.startIndex; index <= ctx.budget.maxRounds; index += 1) {
    if (signal.aborted) break;

    const instruction = instructionForRound(index, ctx.budget.maxRounds);
    const estimate = estimateRound({
      query: ctx.query,
      previousDraft: summary.lastDraft,
      previousOutline: summarizeOutline(summary.lastOutline),
      instruction,
      maxTokens: ctx.maxTokens,
    });
    const check = canContinue(usage, estimate, ctx.budget);
    if (!check.ok) {
      emit({ type: 'budget_warning', consumed: check.consumed, limit: check.limit });
      synthesize(deps, ctx.userId, ctx.runId, usage, summary, summary.lastDraft, 'budget_exhausted', 'completed', emit);
      return;
    }

    machine.forceState('RoundRunning');
    emit({ type: 'round_started', index, totalRounds: ctx.budget.maxRounds, instruction });

    const context = buildRoundContext({
      query: ctx.query,
      instruction,
      state: summary,
      kbSection: index === 1 ? ctx.kbSection : undefined,
    });
    const messages: ChatRequestMessage[] = [
      { role: 'system', content: THINKING_SYSTEM_PROMPT },
      { role: 'user', content: context },
    ];
    const request: GatewayRequest = {
      providerId: ctx.providerId,
      model: ctx.model,
      messages,
      params: { temperature: ctx.temperature, topP: 1, maxTokens: ctx.maxTokens },
      meta: { purpose: 'thinking', conversationId: undefined },
      userId: ctx.userId,
    };

    const roundStartedAt = Date.now();
    const startedAtIso = new Date(roundStartedAt).toISOString();

    let streamed: StreamedRound | null = null;
    let roundError: NormalizedError | null = null;
    let attempt = 0;
    for (;;) {
      if (signal.aborted) break;
      try {
        streamed = await streamRound(deps, request, { index, signal }, emit);
        roundError = null;
        break;
      } catch (error) {
        if (isAbortError(error, signal)) break;
        roundError = normalizeError(error);
        if (attempt === 0 && roundError.retryable) {
          emit({ type: 'round_failed', index, error: roundError, willRetry: true });
          attempt += 1;
          continue;
        }
        break;
      }
    }

    if (signal.aborted) break;

    if (roundError || !streamed) {
      consecutiveFailures += 1;
      const failedArtifact: RoundArtifact = {
        runId: ctx.runId,
        index,
        strategy: ctx.strategy,
        instruction,
        draft: '',
        outline: [],
        changes: [],
        hasFurtherImprovement: true,
        status: 'failed',
        tokenIn: 0,
        tokenOut: 0,
        latencyMs: Date.now() - roundStartedAt,
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
      };
      deps.thinkingRepo.upsertRound(deps.db, ctx.userId, failedArtifact);
      emit({
        type: 'round_failed',
        index,
        error: roundError ?? { kind: 'unknown', userMessage: '模型调用失败', retryable: false },
        willRetry: false,
      });

      summary.completedRounds = index;
      summary.totalUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      deps.thinkingRepo.updateRun(deps.db, ctx.userId, ctx.runId, {
        completedRounds: index,
        consumedIn: usage.inputTokens,
        consumedOut: usage.outputTokens,
        consumedMs: Date.now() - usage.startedAt,
        summaryJson: JSON.stringify(summary),
      });

      if (consecutiveFailures >= ctx.budget.maxConsecutiveFailures) {
        if (summary.lastDraft) {
          synthesize(deps, ctx.userId, ctx.runId, usage, summary, summary.lastDraft, 'max_failures', 'completed', emit);
        } else {
          synthesize(deps, ctx.userId, ctx.runId, usage, summary, '', 'error', 'failed', emit);
        }
        return;
      }
      continue;
    }

    const previousOutline = summary.lastOutline;
    const artifact = parseArtifact(streamed.content, {
      runId: ctx.runId,
      index,
      strategy: ctx.strategy,
      instruction,
      tokenIn: streamed.inputTokens,
      tokenOut: streamed.outputTokens,
      latencyMs: Date.now() - roundStartedAt,
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
      previousOutline,
    });
    usage.inputTokens += streamed.inputTokens;
    usage.outputTokens += streamed.outputTokens;

    deps.thinkingRepo.upsertRound(deps.db, ctx.userId, artifact);
    summary = applyRound(summary, artifact);
    deps.thinkingRepo.updateRun(deps.db, ctx.userId, ctx.runId, {
      completedRounds: index,
      consumedIn: usage.inputTokens,
      consumedOut: usage.outputTokens,
      consumedMs: Date.now() - usage.startedAt,
      summaryJson: JSON.stringify(summary),
    });
    emit({ type: 'round_done', index, artifact });

    if (decideEarlyStop(ctx.budget, artifact, previousOutline).stop) {
      synthesize(deps, ctx.userId, ctx.runId, usage, summary, artifact.draft, 'converged', 'completed', emit);
      return;
    }
  }

  if (signal.aborted) {
    deps.thinkingRepo.updateRun(deps.db, ctx.userId, ctx.runId, {
      status: 'aborted',
      completedRounds: summary.completedRounds,
      consumedIn: usage.inputTokens,
      consumedOut: usage.outputTokens,
      consumedMs: Date.now() - usage.startedAt,
      summaryJson: JSON.stringify(summary),
    });
    emit({
      type: 'run_aborted',
      runId: ctx.runId,
      completedRounds: summary.completedRounds,
      resumable: summary.completedRounds < ctx.budget.maxRounds,
    });
  } else {
    synthesize(deps, ctx.userId, ctx.runId, usage, summary, summary.lastDraft, 'completed', 'completed', emit);
  }
}

export function createThinkingEngine(deps: ThinkingEngineDeps): ThinkingEngine {
  async function run(req: ThinkingRequest, signal: AbortSignal, emit: (event: ThinkingEvent) => void): Promise<void> {
    const budget = req.budget;
    const target = await resolveEngineTarget(deps, req);
    const maxTokens =
      req.maxTokens ?? Math.max(1, Math.ceil(budget.maxTotalOutputTokens / Math.max(1, budget.maxRounds * 1.2)));
    const temperature = req.temperature ?? deps.config.generation.temperature;
    const strategy = 'sequential';

    const machine = createThinkingMachine('Idle');
    machine.dispatch('submit');
    const run = deps.thinkingRepo.createRun(deps.db, req.userId, {
      conversationId: req.conversationId,
      messageId: req.messageId ?? null,
      question: req.query,
      strategy,
      requestedRounds: budget.maxRounds,
      budget,
    });
    emit({ type: 'run_started', runId: run.id, totalRounds: budget.maxRounds, budget });

    machine.dispatch('planReady');
    const kbSection = await buildKbSection(deps, req);

    await runRounds(
      deps,
      {
        userId: req.userId,
        runId: run.id,
        query: req.query,
        budget,
        maxTokens,
        temperature,
        strategy,
        providerId: target.providerId,
        model: target.model,
        kbSection,
        startSummary: createSummaryState(),
        startIndex: 1,
      },
      signal,
      emit,
    );
  }

  async function resume(runId: number, userId: number, signal: AbortSignal, emit: (event: ThinkingEvent) => void): Promise<void> {
    const resumable = deps.thinkingRepo.getResumable(deps.db, userId, runId);
    if (!resumable) throw new ApiError('NOT_RESUMABLE', '该运行不可续跑', 409);

    const run = resumable.run;
    const summary = rebuildSummaryState(resumable.rounds);
    const target = await resolveDefaultProvider(deps.gateway, userId);
    if (!target) throw new ApiError('LLM_NOT_CONFIGURED', '问答服务未配置', 404);
    const maxTokens = Math.max(1, Math.ceil(run.budget.maxTotalOutputTokens / Math.max(1, run.budget.maxRounds * 1.2)));

    emit({ type: 'run_started', runId: run.id, totalRounds: run.requestedRounds, budget: run.budget });
    deps.thinkingRepo.updateRun(deps.db, userId, runId, { status: 'running', stopReason: null });

    await runRounds(
      deps,
      {
        userId,
        runId: run.id,
        query: run.question,
        budget: run.budget,
        maxTokens,
        temperature: deps.config.generation.temperature,
        strategy: run.strategy,
        providerId: target.providerId,
        model: target.model,
        startSummary: summary,
        startIndex: summary.completedRounds + 1,
      },
      signal,
      emit,
    );
  }

  async function estimate(req: ThinkingRequest): Promise<{ maxInputTokens: number; maxOutputTokens: number }> {
    return { maxInputTokens: req.budget.maxTotalInputTokens, maxOutputTokens: req.budget.maxTotalOutputTokens };
  }

  return { run, resume, estimate };
}
