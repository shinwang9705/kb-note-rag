/**
 * 深度思考三维预算 + 每轮前预检。
 *
 * 三维预算（照搬 02 §2.5.4 / 设计 §3.2.3）：
 *   - maxRounds            = 用户 thinkingRounds（1–10，默认 3）
 *   - maxTotalOutputTokens = maxTokens × maxRounds × 1.2
 *   - maxTotalInputTokens  = 200000
 *   - maxWallClockMs       = 180000（3 分钟）
 *   - maxConsecutiveFailures = 2
 */
import type { AppConfig } from '../config.js';
import type { GenerationParams, ThinkingBudget } from '@kb/shared';
import { DEFAULT_THINKING_BUDGET } from '@kb/shared';
import { estimateTokens } from '../util/token.js';

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.trunc(Math.min(max, Math.max(min, value)));
}

/** 由 GenerationParams + 配置默认值装配预算 */
export function buildBudget(params: GenerationParams, config: AppConfig): ThinkingBudget {
  const maxRounds = clampInt(params.thinkingRounds, 1, 10);
  return {
    maxRounds,
    maxTotalOutputTokens: Math.ceil(params.maxTokens * maxRounds * 1.2),
    maxTotalInputTokens: config.thinking.maxTotalInputTokens,
    maxWallClockMs: config.thinking.maxWallClockMs,
    maxConsecutiveFailures: config.thinking.maxConsecutiveFailures,
    earlyStopOnConverge: true,
    diffConvergeThreshold: config.thinking.diffConvergeThreshold,
  };
}

/** 已消耗预算（引擎运行期间累加） */
export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
}

export function createUsage(): BudgetUsage {
  return { inputTokens: 0, outputTokens: 0, startedAt: Date.now() };
}

export interface BudgetCheckResult {
  ok: boolean;
  reason?: 'output_tokens' | 'input_tokens' | 'wall_clock';
  consumed: number;
  limit: number;
}

/**
 * 预检：再消耗 estimate 后是否仍落在预算内。
 * 三条任一超限即不可继续，用于 emit budget_warning 与停止判定。
 */
export function canContinue(
  usage: BudgetUsage,
  estimate: { inputTokens: number; outputTokens: number },
  budget: ThinkingBudget,
): BudgetCheckResult {
  const outputConsumed = usage.outputTokens + estimate.outputTokens;
  if (outputConsumed > budget.maxTotalOutputTokens) {
    return { ok: false, reason: 'output_tokens', consumed: outputConsumed, limit: budget.maxTotalOutputTokens };
  }
  const inputConsumed = usage.inputTokens + estimate.inputTokens;
  if (inputConsumed > budget.maxTotalInputTokens) {
    return { ok: false, reason: 'input_tokens', consumed: inputConsumed, limit: budget.maxTotalInputTokens };
  }
  const wallMs = Date.now() - usage.startedAt;
  if (wallMs > budget.maxWallClockMs) {
    return { ok: false, reason: 'wall_clock', consumed: wallMs, limit: budget.maxWallClockMs };
  }
  return { ok: true, consumed: 0, limit: 0 };
}

/** 估算单轮上下文（Q + R + S + I）与输出上限（保守取 maxTokens） */
export function estimateRound(input: {
  query: string;
  previousDraft: string;
  previousOutline: string;
  instruction: string;
  maxTokens: number;
}): { inputTokens: number; outputTokens: number } {
  const inputTokens =
    estimateTokens(input.query) +
    estimateTokens(input.previousDraft) +
    estimateTokens(input.previousOutline) +
    estimateTokens(input.instruction) +
    64; // 协议开销保守计入
  return { inputTokens, outputTokens: input.maxTokens };
}
