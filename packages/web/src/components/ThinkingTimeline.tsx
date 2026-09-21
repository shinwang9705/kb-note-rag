import type { ChangeType, RoundArtifact, SelfScore } from '@kb/shared';

/** 一轮在时间轴上的视图（由 ConversationPage 从 ThinkingEvent 聚合） */
export interface ThinkingRoundView {
  index: number;
  instruction: string;
  status: 'running' | 'done' | 'failed';
  /** running 轮的流式草稿 */
  liveDraft: string;
  artifact?: RoundArtifact;
  errorMessage?: string;
}

export interface ThinkingTimelineProps {
  totalRounds: number;
  rounds: ThinkingRoundView[];
  finalDraft: string;
  stopReason?: string | null;
  budgetWarning?: string | null;
  aborted?: { runId: number; completedRounds: number; resumable: boolean } | null;
  onResume?: () => void;
}

const CHANGE_META: Record<ChangeType, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'bg-success-50 text-success-700' },
  removed: { label: '移除', cls: 'bg-danger-50 text-danger-700' },
  reworded: { label: '改写', cls: 'bg-secondary-50 text-secondary-700' },
  restructured: { label: '重排', cls: 'bg-info-50 text-info-700' },
  evidence_added: { label: '补证', cls: 'bg-success-50 text-success-700' },
  conclusion_changed: { label: '结论变更', cls: 'bg-accent text-white' },
};

const STOP_REASON_LABEL: Record<string, string> = {
  completed: '完成',
  converged: '已收敛（提前停止）',
  budget_exhausted: '预算耗尽',
  max_failures: '连续失败降级',
  error: '失败',
  user_aborted: '已中断',
};

/** 停止原因文本上色：completed/converged→success、budget→warning、max_failures/error→danger、user_aborted→secondary */
const STOP_REASON_STYLE: Record<string, string> = {
  completed: 'text-success-600',
  converged: 'text-success-600',
  budget_exhausted: 'text-warning-600',
  max_failures: 'text-danger-600',
  error: 'text-danger-600',
  user_aborted: 'text-secondary-600',
};

function ScoreRow({ score }: { score: SelfScore }) {
  const items: Array<{ key: keyof SelfScore; label: string }> = [
    { key: 'clarity', label: '清晰' },
    { key: 'coverage', label: '覆盖' },
    { key: 'evidence', label: '论据' },
    { key: 'concision', label: '简洁' },
  ];
  return (
    <div className="grid grid-cols-4 gap-2">
      {items.map((item) => (
        <div key={item.key} className="text-xs">
          <div className="mb-0.5 text-muted">{item.label}</div>
          <div className="h-1.5 overflow-hidden rounded bg-secondary-100">
            <div
              className="h-full rounded bg-primary-500"
              style={{ width: `${Math.min(100, Math.max(0, score[item.key]) * 10)}%` }}
            />
          </div>
          <div className="mt-0.5 font-mono text-muted">{score[item.key]}</div>
        </div>
      ))}
    </div>
  );
}

export default function ThinkingTimeline({
  totalRounds,
  rounds,
  finalDraft,
  stopReason,
  budgetWarning,
  aborted,
  onResume,
}: ThinkingTimelineProps) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <h4 className="mb-3 text-sm font-medium text-ink">深度思考过程</h4>

      {budgetWarning ? (
        <div className="mb-3 rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
          {budgetWarning}
        </div>
      ) : null}

      <ol className="space-y-3">
        {rounds.map((round) => {
          const artifact = round.artifact;
          return (
            <li key={round.index} className="rounded-card border border-line p-3">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-xs font-medium text-ink">
                  第 {round.index}/{totalRounds} 轮
                </span>
                <span
                  className={`rounded-pill px-2 py-0.5 text-xs ${
                    round.status === 'done'
                      ? 'bg-success-50 text-success-700'
                      : round.status === 'failed'
                        ? 'bg-danger-50 text-danger-700'
                        : 'bg-info-100 text-info-700'
                  }`}
                >
                  {round.status === 'done' ? '完成' : round.status === 'failed' ? '失败' : '进行中'}
                </span>
                {artifact ? (
                  <span className="text-xs text-muted">
                    {artifact.latencyMs}ms · 入 {artifact.tokenIn}/出 {artifact.tokenOut} tok
                  </span>
                ) : null}
              </div>

              <p className="mb-2 text-xs text-muted">{round.instruction}</p>

              {round.errorMessage ? (
                <p className="text-xs text-danger-600">{round.errorMessage}</p>
              ) : null}

              {artifact ? (
                <details className="space-y-2 text-xs">
                  <summary className="cursor-pointer text-muted hover:text-ink">
                    展开要点 / 变更 / 评分 / 草稿
                  </summary>
                  {artifact.outline.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink">
                      {artifact.outline.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                  {artifact.changes.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {artifact.changes.map((change, i) => {
                        const meta = CHANGE_META[change.type];
                        return (
                          <li key={i} className="flex items-start gap-2">
                            <span className={`shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] ${meta.cls}`}>
                              {meta.label}
                            </span>
                            <span className="text-ink">
                              {change.target}
                              {change.detail ? <span className="text-muted"> — {change.detail}</span> : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {artifact.selfScore ? (
                    <div className="mt-2">
                      <ScoreRow score={artifact.selfScore} />
                    </div>
                  ) : null}
                  {artifact.draft ? (
                    <div className="mt-2 rounded-control bg-secondary-50 px-2 py-1.5">
                      <p className="whitespace-pre-wrap text-ink">{artifact.draft}</p>
                    </div>
                  ) : null}
                </details>
              ) : (
                <p className="whitespace-pre-wrap text-xs text-muted">
                  {round.liveDraft || (round.status === 'running' ? '生成中…' : '')}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {finalDraft ? (
        <div className="mt-3 rounded-control bg-primary-50 p-3">
          <div className="mb-1 text-xs font-medium text-primary-700">终稿</div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{finalDraft}</p>
        </div>
      ) : null}

      {stopReason ? (
        <div className={`mt-3 text-xs ${STOP_REASON_STYLE[stopReason] ?? 'text-muted'}`}>
          {STOP_REASON_LABEL[stopReason] ?? stopReason}
        </div>
      ) : null}

      {aborted && aborted.resumable ? (
        <button
          type="button"
          onClick={onResume}
          className="mt-3 rounded-control border border-primary-300 px-3 py-1.5 text-xs text-primary-700 hover:bg-primary-50"
        >
          从第 {aborted.completedRounds + 1} 轮继续
        </button>
      ) : null}
    </div>
  );
}
