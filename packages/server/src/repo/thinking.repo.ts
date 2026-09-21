/**
 * 深度思考数据访问层（三期 T03）。
 *
 * 隔离铁律：所有查询强制 WHERE user_id = ?。
 * 每轮产物 upsertRound 用 INSERT ... ON CONFLICT(run_id, round_index) DO UPDATE 幂等落库，
 * 支持「每轮立即落库 -> 中断续跑」。
 */
import type { DbHandle } from '../db/connection.js';
import type {
  ChangeItem,
  RoundArtifact,
  RoundStatus,
  SelfScore,
  StopReason,
  ThinkingBudget,
  ThinkingRun,
  ThinkingRunStatus,
} from '@kb/shared';
import { DEFAULT_THINKING_BUDGET } from '@kb/shared';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// thinking_runs
// ---------------------------------------------------------------------------
export interface ThinkingRunRow {
  id: number;
  user_id: number;
  conversation_id: number;
  message_id: number | null;
  question: string;
  strategy: string;
  requested_rounds: number;
  completed_rounds: number;
  status: string;
  budget_json: string;
  consumed_in: number;
  consumed_out: number;
  consumed_ms: number;
  stop_reason: string | null;
  final_content: string;
  summary_json: string | null;
  created_at: string;
  updated_at: string;
}

export function toThinkingRun(row: ThinkingRunRow): ThinkingRun {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    conversationId: Number(row.conversation_id),
    messageId: row.message_id == null ? null : Number(row.message_id),
    question: row.question ?? '',
    strategy: row.strategy ?? 'sequential',
    requestedRounds: Number(row.requested_rounds ?? 0),
    completedRounds: Number(row.completed_rounds ?? 0),
    status: row.status as ThinkingRunStatus,
    budget: { ...DEFAULT_THINKING_BUDGET, ...parseJson<Partial<ThinkingBudget>>(row.budget_json, {}) },
    consumedIn: Number(row.consumed_in ?? 0),
    consumedOut: Number(row.consumed_out ?? 0),
    consumedMs: Number(row.consumed_ms ?? 0),
    stopReason: (row.stop_reason as StopReason | null) ?? null,
    finalContent: row.final_content ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRunInput {
  conversationId: number;
  messageId?: number | null;
  question: string;
  strategy: string;
  requestedRounds: number;
  budget: ThinkingBudget;
}

export function createRun(db: DbHandle, userId: number, input: CreateRunInput): ThinkingRun {
  const row = db.driver.get<Pick<ThinkingRunRow, 'id'>>(
    `INSERT INTO thinking_runs
       (user_id, conversation_id, message_id, question, strategy, requested_rounds, status,
        budget_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ${NOW}, ${NOW}) RETURNING id`,
    [
      userId,
      input.conversationId,
      input.messageId ?? null,
      input.question,
      input.strategy,
      input.requestedRounds,
      JSON.stringify(input.budget),
    ],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建深度思考运行失败：未返回主键');
  return getRun(db, userId, id) as ThinkingRun;
}

export function getRun(db: DbHandle, userId: number, runId: number): ThinkingRun | undefined {
  const row = db.driver.get<ThinkingRunRow>('SELECT * FROM thinking_runs WHERE id = ? AND user_id = ?', [
    runId,
    userId,
  ]);
  return row ? toThinkingRun(row) : undefined;
}

export interface UpdateRunInput {
  status?: ThinkingRunStatus;
  completedRounds?: number;
  consumedIn?: number;
  consumedOut?: number;
  consumedMs?: number;
  stopReason?: StopReason | null;
  finalContent?: string;
  summaryJson?: string | null;
}

export function updateRun(
  db: DbHandle,
  userId: number,
  runId: number,
  patch: UpdateRunInput,
): ThinkingRun | undefined {
  const existing = getRun(db, userId, runId);
  if (!existing) return undefined;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.completedRounds !== undefined) {
    sets.push('completed_rounds = ?');
    params.push(Math.max(0, Math.trunc(patch.completedRounds)));
  }
  if (patch.consumedIn !== undefined) {
    sets.push('consumed_in = ?');
    params.push(Math.max(0, Math.trunc(patch.consumedIn)));
  }
  if (patch.consumedOut !== undefined) {
    sets.push('consumed_out = ?');
    params.push(Math.max(0, Math.trunc(patch.consumedOut)));
  }
  if (patch.consumedMs !== undefined) {
    sets.push('consumed_ms = ?');
    params.push(Math.max(0, Math.trunc(patch.consumedMs)));
  }
  if (patch.stopReason !== undefined) {
    sets.push('stop_reason = ?');
    params.push(patch.stopReason);
  }
  if (patch.finalContent !== undefined) {
    sets.push('final_content = ?');
    params.push(patch.finalContent);
  }
  if (patch.summaryJson !== undefined) {
    sets.push('summary_json = ?');
    params.push(patch.summaryJson);
  }

  if (sets.length === 0) return existing;
  sets.push(`updated_at = ${NOW}`);
  params.push(runId, userId);
  db.driver.run(`UPDATE thinking_runs SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  return getRun(db, userId, runId);
}

export function listRunsByConversation(
  db: DbHandle,
  userId: number,
  conversationId: number,
): ThinkingRun[] {
  const rows = db.driver.all<ThinkingRunRow>(
    'SELECT * FROM thinking_runs WHERE user_id = ? AND conversation_id = ? ORDER BY created_at DESC, id DESC',
    [userId, conversationId],
  );
  return rows.map(toThinkingRun);
}

// ---------------------------------------------------------------------------
// thinking_rounds
// ---------------------------------------------------------------------------
export interface ThinkingRoundRow {
  id: number;
  user_id: number;
  run_id: number;
  round_index: number;
  strategy: string;
  instruction: string;
  draft: string;
  reasoning: string | null;
  outline_json: string;
  changes_json: string;
  self_score_json: string | null;
  has_further_improvement: number | null;
  status: string;
  token_in: number;
  token_out: number;
  latency_ms: number;
  error_json: string | null;
  started_at: string;
  ended_at: string | null;
}

export function toRoundArtifact(row: ThinkingRoundRow): RoundArtifact {
  return {
    runId: Number(row.run_id),
    index: Number(row.round_index),
    strategy: row.strategy ?? 'sequential',
    instruction: row.instruction ?? '',
    draft: row.draft ?? '',
    reasoning: row.reasoning ?? undefined,
    outline: parseJson<string[]>(row.outline_json, []),
    changes: parseJson<ChangeItem[]>(row.changes_json, []),
    selfScore: parseJson<SelfScore | undefined>(row.self_score_json, undefined),
    hasFurtherImprovement: Number(row.has_further_improvement) === 1,
    status: row.status as RoundStatus,
    tokenIn: Number(row.token_in ?? 0),
    tokenOut: Number(row.token_out ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
  };
}

/** 按 run_id 列出已完成轮次（resume 时重建 SummaryState 用） */
export function listRounds(db: DbHandle, userId: number, runId: number): RoundArtifact[] {
  const rows = db.driver.all<ThinkingRoundRow>(
    'SELECT * FROM thinking_rounds WHERE user_id = ? AND run_id = ? ORDER BY round_index ASC',
    [userId, runId],
  );
  return rows.map(toRoundArtifact);
}

/** 幂等落库一轮产物（ON CONFLICT(run_id, round_index) DO UPDATE） */
export function upsertRound(db: DbHandle, userId: number, artifact: RoundArtifact): void {
  db.driver.run(
    `INSERT INTO thinking_rounds
       (user_id, run_id, round_index, strategy, instruction, draft, reasoning,
        outline_json, changes_json, self_score_json, has_further_improvement, status,
        token_in, token_out, latency_ms, error_json, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, round_index) DO UPDATE SET
       strategy = excluded.strategy,
       instruction = excluded.instruction,
       draft = excluded.draft,
       reasoning = excluded.reasoning,
       outline_json = excluded.outline_json,
       changes_json = excluded.changes_json,
       self_score_json = excluded.self_score_json,
       has_further_improvement = excluded.has_further_improvement,
       status = excluded.status,
       token_in = excluded.token_in,
       token_out = excluded.token_out,
       latency_ms = excluded.latency_ms,
       error_json = excluded.error_json,
       ended_at = excluded.ended_at`,
    [
      userId,
      artifact.runId,
      artifact.index,
      artifact.strategy,
      artifact.instruction,
      artifact.draft,
      artifact.reasoning ?? null,
      JSON.stringify(artifact.outline),
      JSON.stringify(artifact.changes),
      artifact.selfScore ? JSON.stringify(artifact.selfScore) : null,
      artifact.hasFurtherImprovement ? 1 : 0,
      artifact.status,
      artifact.tokenIn,
      artifact.tokenOut,
      artifact.latencyMs,
      null,
      artifact.startedAt,
      artifact.endedAt,
    ],
  );
}

export interface ResumableRun {
  run: ThinkingRun;
  rounds: RoundArtifact[];
}

/** 取可续跑运行（status in aborted/failed 且 completed_rounds < requested_rounds） */
export function getResumable(db: DbHandle, userId: number, runId: number): ResumableRun | undefined {
  const run = getRun(db, userId, runId);
  if (!run) return undefined;
  const resumable =
    (run.status === 'aborted' || run.status === 'failed') && run.completedRounds < run.requestedRounds;
  if (!resumable) return undefined;
  return { run, rounds: listRounds(db, userId, runId) };
}
