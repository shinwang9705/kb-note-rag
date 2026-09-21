import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { Document, Library, SearchHit, SearchMode, SearchResult } from '@kb/shared';

interface SearchPageProps {
  /** 从"在本文档内检索"传入的文档范围 */
  docId?: number | '';
  /** 从全局检索/工作台传入的初始关键词：变化且非空时自动填词并检索一次 */
  initialKeyword?: string;
  onOpenDocument?: (docId: number, chunk: number) => void;
}

const MODE_OPTIONS: Array<{ value: 'auto' | SearchMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'keyword', label: '仅关键词' },
  { value: 'hybrid', label: '混合（关键词+语义）' },
  { value: 'vector', label: '仅语义' },
];

const SOURCE_LABEL: Record<SearchHit['source'], string> = {
  fts: '关键词',
  vec: '语义',
  both: '关键词+语义',
};

const SOURCE_STYLE: Record<SearchHit['source'], string> = {
  fts: 'bg-secondary-100 text-secondary-600',
  vec: 'bg-primary-50 text-primary-600',
  both: 'bg-success-100 text-success-700',
};

/** 用 highlightStart/highlightEnd 偏移做高亮（禁止 dangerouslySetInnerHTML） */
function HighlightedSnippet({ hit }: { hit: SearchHit }) {
  const { snippet, highlightStart, highlightEnd } = hit;
  const valid = highlightStart >= 0 && highlightEnd > highlightStart && highlightEnd <= snippet.length;
  if (!valid) return <span>{snippet}</span>;
  return (
    <span>
      {snippet.slice(0, highlightStart)}
      <mark className="rounded bg-warning-200 px-0.5 text-warning-700">{snippet.slice(highlightStart, highlightEnd)}</mark>
      {snippet.slice(highlightEnd)}
    </span>
  );
}

export default function SearchPage({ docId, initialKeyword, onOpenDocument }: SearchPageProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'auto' | SearchMode>('auto');
  const [libraryId, setLibraryId] = useState<number | ''>('');
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [scopedDocId, setScopedDocId] = useState<number | ''>(docId ?? '');

  const [history, setHistory] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  // 外部（在本文档内检索）传入的 docId 变化时同步
  useEffect(() => {
    setScopedDocId(docId ?? '');
  }, [docId]);

  // 外部传入的初始关键词：变化且非空时自动填词并触发一次检索（显式覆盖 docId，避免沿用旧范围）
  useEffect(() => {
    const kw = (initialKeyword ?? '').trim();
    if (!kw) return;
    setQuery(kw);
    void runSearch({ query: kw, docId: docId ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKeyword, docId]);

  useEffect(() => {
    void api.libraries().then((res) => setLibraries(res.items)).catch(() => {});
    void api.documents({ limit: 200 }).then((res) => setDocuments(res.items)).catch(() => {});
    void api.searchHistory().then((res) => setHistory(res.items.map((h) => h.query))).catch(() => {});
  }, []);

  const runSearch = useCallback(
    async (input?: { query?: string; mode?: 'auto' | SearchMode; libraryId?: number | ''; docId?: number | '' }): Promise<void> => {
      const q = (input?.query ?? query).trim();
      if (!q) {
        setError('请输入检索词');
        return;
      }
      setError('');
      setSearching(true);
      try {
        const res = await api.search({
          query: q,
          mode: input?.mode ?? mode,
          libraryId: (input?.libraryId ?? libraryId) === '' ? null : Number(input?.libraryId ?? libraryId),
          docId: (input?.docId ?? scopedDocId) === '' ? null : Number(input?.docId ?? scopedDocId),
          finalK: 10,
        });
        setResult(res);
        // 刷新历史下拉
        void api.searchHistory().then((h) => setHistory(h.items.map((x) => x.query))).catch(() => {});
      } catch (err) {
        setResult(null);
        setError(err instanceof ApiClientError ? err.message : '检索失败');
      } finally {
        setSearching(false);
      }
    },
    [query, mode, libraryId, scopedDocId],
  );

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void runSearch();
  };

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <form onSubmit={submit} className="space-y-3">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入检索词，例如：怎么防止数据丢失"
              list="search-history-options"
              className="flex-1 rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            />
            <datalist id="search-history-options">
              {history.map((h, i) => (
                <option key={`${h}-${i}`} value={h} />
              ))}
            </datalist>
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="rounded-control bg-primary-600 px-5 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {searching ? '检索中…' : '检索'}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <label className="mr-2 text-sm text-muted">模式</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'auto' | SearchMode)}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500"
              >
                {MODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mr-2 text-sm text-muted">知识库</label>
              <select
                value={libraryId}
                onChange={(e) => setLibraryId(e.target.value === '' ? '' : Number(e.target.value))}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500"
              >
                <option value="">全部</option>
                {libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mr-2 text-sm text-muted">限定文档</label>
              <select
                value={scopedDocId}
                onChange={(e) => setScopedDocId(e.target.value === '' ? '' : Number(e.target.value))}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500"
              >
                <option value="">全部文档</option>
                {documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.title}（#{doc.id}）
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>
        {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}
      </section>

      {result ? (
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span>
              命中 <b className="text-ink">{result.hits.length}</b> 条
            </span>
            <span>
              实际模式：<b className="text-ink">{result.mode}</b>
            </span>
            <span>耗时 {result.tookMs}ms</span>
            {result.fallbackLike ? <span className="text-warning-600">已启用 LIKE 兜底（短中文查询）</span> : null}
            <span className="text-xs">
              （FTS {result.stats.fts} / 向量 {result.stats.vec} / LIKE {result.stats.like}）
            </span>
          </div>

          {result.hits.length === 0 ? (
            <p className="text-sm text-muted">没有找到相关内容，试试更换关键词或切换模式。</p>
          ) : (
            <ul className="divide-y divide-line">
              {result.hits.map((hit) => (
                <li key={hit.chunkId} className="py-4">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{hit.docTitle}</span>
                    {hit.sectionPath ? <span className="text-xs text-muted">› {hit.sectionPath}</span> : null}
                    <span className={`inline-block rounded-pill px-2 py-0.5 text-xs ${SOURCE_STYLE[hit.source]}`}>
                      {SOURCE_LABEL[hit.source]}
                    </span>
                    <span className="text-xs text-muted">
                      原文定位：第 {hit.charStart}–{hit.charEnd} 字（片段 #{hit.seq}）
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenDocument?.(hit.docId, hit.seq)}
                      className="text-xs text-primary-600 hover:underline"
                    >
                      查看原文
                    </button>
                  </div>
                  <p className="text-sm leading-relaxed text-muted">
                    <HighlightedSnippet hit={hit} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
