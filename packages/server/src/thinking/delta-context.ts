/**
 * 增量上下文构造（核心成本创新）。
 *
 * 每轮请求 = Q(原问题) + R_{n-1}(上轮 draft 结论) + S_{n-1}(上轮 outline 摘要 ≤200tok) + I_n(本轮指令)
 * 不含历史轮次全文 -> 成本线性于 N。
 * 摘要直接复用结构化产物 outline 字段（零边际成本，不额外调模型）。
 */
import type { RoundArtifact } from '@kb/shared';
import { estimateTokens } from '../util/token.js';

/** 引擎维护的可续跑摘要态（resume 时由已落库轮次重建） */
export interface SummaryState {
  lastOutline: string[];
  lastDraft: string;
  completedRounds: number;
  totalUsage: { inputTokens: number; outputTokens: number };
}

export function createSummaryState(): SummaryState {
  return { lastOutline: [], lastDraft: '', completedRounds: 0, totalUsage: { inputTokens: 0, outputTokens: 0 } };
}

/** 每轮完成后推进 SummaryState（resume 从 completed_rounds+1 续跑的依据） */
export function applyRound(state: SummaryState, artifact: RoundArtifact): SummaryState {
  return {
    lastOutline: artifact.outline,
    lastDraft: artifact.draft,
    completedRounds: state.completedRounds + 1,
    totalUsage: {
      inputTokens: state.totalUsage.inputTokens + artifact.tokenIn,
      outputTokens: state.totalUsage.outputTokens + artifact.tokenOut,
    },
  };
}

/**
 * 由已落库轮次重建 SummaryState（resume 用）。
 *   - lastOutline/lastDraft 取最后一个 status='done' 的轮次；
 *   - totalUsage 累加所有轮次（含 failed 的消耗）；
 *   - completedRounds = 已落库轮次总数（done + failed）。
 */
export function rebuildSummaryState(rounds: readonly RoundArtifact[]): SummaryState {
  const state = createSummaryState();
  for (const round of rounds) {
    state.totalUsage.inputTokens += round.tokenIn;
    state.totalUsage.outputTokens += round.tokenOut;
    if (round.status === 'done') {
      state.lastOutline = round.outline;
      state.lastDraft = round.draft;
    }
  }
  state.completedRounds = rounds.length;
  return state;
}

const OUTLINE_MAX_TOKENS = 200;

/** outline -> 摘要文本（≤200 token，截断） */
export function summarizeOutline(outline: readonly string[]): string {
  const items = outline.map((item) => item.trim()).filter(Boolean);
  let out = '';
  for (const item of items) {
    const candidate = out ? `${out}\n- ${item}` : `- ${item}`;
    if (estimateTokens(candidate) > OUTLINE_MAX_TOKENS) break;
    out = candidate;
  }
  return out;
}

export interface RoundContextInput {
  query: string;
  instruction: string;
  state: SummaryState;
  /** 知识库参考资料（首轮注入） */
  kbSection?: string;
}

/** 构造单轮 user 消息 */
export function buildRoundContext(input: RoundContextInput): string {
  const parts: string[] = [];
  if (input.kbSection) parts.push(input.kbSection);
  parts.push(`【原始问题】\n${input.query}`);
  if (input.state.lastDraft) parts.push(`【上一轮结论】\n${input.state.lastDraft}`);
  if (input.state.lastOutline.length > 0) {
    parts.push(`【上一轮要点】\n${summarizeOutline(input.state.lastOutline)}`);
  }
  parts.push(`【本轮指令】\n${input.instruction}`);
  return parts.join('\n\n');
}
