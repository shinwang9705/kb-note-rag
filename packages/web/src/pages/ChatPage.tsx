import { useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { AskResult, ChatSource, ConfidenceLevel, Library } from '@kb/shared';

interface ChatPageProps {
  /** 点击"查看原文"时的回调 */
  onOpenDocument?: (docId: number) => void;
}

/** 置信度徽标样式：grounded->有据 / partial->部分有据 / ungrounded->无据 */
function confidenceBadge(level: ConfidenceLevel): { label: string; className: string } {
  if (level === 'grounded') return { label: '有据', className: 'bg-success-100 text-success-700' };
  if (level === 'partial') return { label: '部分有据', className: 'bg-warning-100 text-warning-700' };
  return { label: '无据', className: 'bg-secondary-100 text-muted' };
}

/**
 * RAG 问答页：提问 -> 展示答案（纯文本渲染，禁止 dangerouslySetInnerHTML）+ 引用来源列表。
 * 默认流式（SSE），失败可切非流式兜底；LLM 未配置时置灰提示。
 */
export default function ChatPage({ onOpenDocument }: ChatPageProps) {
  const [query, setQuery] = useState('');
  const [libraryId, setLibraryId] = useState<number | ''>('');
  const [libraries, setLibraries] = useState<Library[]>([]);

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [result, setResult] = useState<AskResult | null>(null);
  const [liveAnswer, setLiveAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .chatStatus()
      .then((status) => {
        if (!cancelled) setEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    void api
      .libraries()
      .then((res) => {
        if (!cancelled) setLibraries(res.items);
      })
      .catch(() => {
        /* 知识库加载失败不阻塞问答 */
      });
    return () => {
      cancelled = true;
      controller.current?.abort();
    };
  }, []);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting.current) return;
    const q = query.trim();
    if (!q) {
      setError('请输入问题');
      return;
    }
    setError('');
    setResult(null);
    setLiveAnswer('');
    setAsking(true);
    submitting.current = true;
    controller.current = new AbortController();
    try {
      const payload = { query: q, libraryId: libraryId === '' ? null : libraryId };
      if (streaming) {
        await api.chatStream(payload, {
          onDelta: (content) => setLiveAnswer((prev) => prev + content),
          onDone: (res) => setResult(res),
          onError: (code, message) => setError(message || code),
        }, controller.current.signal);
      } else {
        const res = await api.chat(payload, controller.current.signal);
        setResult(res);
      }
    } catch (err) {
      setError(controller.current?.signal.aborted ? '已停止生成，已保留收到的内容。' : err instanceof Error ? err.message : '问答失败');
    } finally {
      setAsking(false);
      submitting.current = false;
    }
  };

  const noEvidence = result !== null && (!result.grounded || result.sources.length === 0);
  const displayAnswer = result ? (noEvidence ? '未在你的知识库中找到依据' : result.answer) : liveAnswer;

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">知识库问答</h2>

        {enabled === false ? (
          <div className="rounded-control border border-line bg-secondary-50 px-4 py-3 text-sm text-muted">
            问答未启用（未配置 LLM）。请在服务端配置 <code className="text-muted">LLM_PROVIDER</code> 与{' '}
            <code className="text-muted">LLM_API_KEY</code>。
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="space-y-3">
            <div>
              <textarea
                aria-label="知识库问题"
                maxLength={2000}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={3}
                placeholder="输入你的问题，例如：怎么防止数据丢失？"
                disabled={asking}
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500 disabled:bg-secondary-50"
              />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <label className="mr-2 text-sm text-muted">知识库</label>
                <select
                  value={libraryId}
                  onChange={(e) => setLibraryId(e.target.value === '' ? '' : Number(e.target.value))}
                  disabled={asking}
                  className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500 disabled:bg-secondary-50"
                >
                  <option value="">全部</option>
                  {libraries.map((lib) => (
                    <option key={lib.id} value={lib.id}>
                      {lib.name}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-1 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={streaming}
                  onChange={(e) => setStreaming(e.target.checked)}
                  disabled={asking}
                  className="accent-primary-600"
                />
                流式输出
              </label>
              <button
                type="submit"
                disabled={asking || !query.trim()}
                className="rounded-control bg-primary-600 px-5 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {asking ? '回答中…' : '提问'}
              </button>
              {asking ? <button type="button" onClick={() => controller.current?.abort()} className="rounded-control border border-danger-300 px-4 py-2 text-sm text-danger-600">停止</button> : null}
            </div>
          </form>
        )}
        {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}
      </section>

      {result || asking || liveAnswer ? (
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          {result ? (
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <span>
                依据 <b className="text-ink">{result.sources.length}</b> 条
              </span>
              <span>
                模式：<b className="text-ink">{result.mode}</b>
              </span>
              {result.model ? <span>模型：{result.model}</span> : null}
              <span>耗时 {result.tookMs}ms</span>
            </div>
          ) : (
            <p className="mb-4 text-sm text-muted">回答生成中…</p>
          )}

          {result && result.confidence ? (
            <div className="mb-3">
              <span
                className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-medium ${confidenceBadge(result.confidence).className}`}
              >
                {confidenceBadge(result.confidence).label}
              </span>
            </div>
          ) : null}

          <div className="rounded-control bg-secondary-50 px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {displayAnswer || (asking ? '' : '')}
            </p>
          </div>

          {result && result.citationWarnings && result.citationWarnings.length > 0 ? (
            <div className="mt-3 rounded-control border border-warning-200 bg-warning-50 px-4 py-2 text-sm text-warning-700">
              检测到越界引用 [{result.citationWarnings.join('][')}]（仅 {result.sources.length} 条来源），
              可能为模型误标，请以来源列表为准。
            </div>
          ) : null}

          {result && result.crossDoc?.conflict ? (
            <div className="mt-3 rounded-control border border-warning-200 bg-warning-100 px-4 py-3 text-sm text-warning-700">
              <p className="font-medium">⚠️ 不同文档存在表述差异</p>
              {result.crossDoc.conflictSources && result.crossDoc.conflictSources.length > 0 ? (
                <ul className="mt-1 list-inside list-disc">
                  {result.crossDoc.conflictSources.map((source, index) => (
                    <li key={`${source.docId}-${index}`}>{source.docTitle}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {result && !noEvidence && result.sources.length > 0 ? (
            <>
              <h3 className="mb-2 mt-6 text-sm font-medium text-ink">引用来源</h3>
              <ul className="divide-y divide-line">
                {result.sources.map((source: ChatSource, index: number) => (
                  <li key={`${source.chunkId}-${index}`} className="py-3">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="inline-block min-w-[1.5rem] rounded-control bg-primary-50 px-1.5 py-0.5 text-center text-xs font-medium text-primary-600">
                        {index + 1}
                      </span>
                      <span className="font-medium text-ink">{source.docTitle}</span>
                      {source.sectionPath ? <span className="text-xs text-muted">› {source.sectionPath}</span> : null}
                      <span className="text-xs text-muted">
                        原文定位：第 {source.charStart}–{source.charEnd} 字
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenDocument?.(source.docId)}
                        className="text-xs text-primary-600 hover:underline"
                      >
                        查看原文
                      </button>
                    </div>
                    <p className="text-sm leading-relaxed text-muted">{source.snippet}</p>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
