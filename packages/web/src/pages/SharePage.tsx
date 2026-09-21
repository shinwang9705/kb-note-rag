import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { SearchHit, SearchResult } from '@kb/shared';

interface ShareLibraryMeta {
  name: string;
  description: string;
  docCount: number;
}

/** 从 #/share/<token> 提取 token */
function readShareToken(): string | null {
  const match = /^#\/share\/([^/?#]+)/.exec(window.location.hash);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

/** 命中来源标签 */
function sourceLabel(source: SearchHit['source']): string {
  if (source === 'both') return '关键词+语义';
  if (source === 'vec') return '语义';
  return '关键词';
}

/**
 * 公开落地页（无登录）：读 hash 里的 share token -> 展示库名 -> 只读检索。
 * 无写操作、无历史记录、无「查看原文」跨库越权。
 */
export default function SharePage() {
  const token = readShareToken();
  const [library, setLibrary] = useState<ShareLibraryMeta | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('分享链接无效');
      return;
    }
    let cancelled = false;
    void api
      .shareMeta(token)
      .then((res) => {
        if (!cancelled) setLibrary(res.library);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiClientError ? err.message : '分享链接已失效');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token || !query.trim()) return;
    setError('');
    setLoading(true);
    try {
      const res = await api.shareSearch(token, { query: query.trim() });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-danger-600">分享链接无效</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <section className="rounded-lg bg-white p-6 shadow">
        {error ? <p className="mb-3 text-sm text-danger-600">{error}</p> : null}
        {library ? (
          <div>
            <h1 className="text-xl font-semibold">{library.name}</h1>
            {library.description ? <p className="mt-1 text-sm text-slate-500">{library.description}</p> : null}
            <p className="mt-2 text-sm text-slate-400">共 {library.docCount} 篇文档 · 只读检索</p>
          </div>
        ) : (
          <p className="text-sm text-slate-400">加载中…</p>
        )}
      </section>

      {library ? (
        <section className="rounded-lg bg-white p-6 shadow">
          <form onSubmit={(e) => void submit(e)} className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在该知识库内检索…"
              disabled={loading}
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 disabled:bg-slate-50"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="rounded bg-brand-600 px-5 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? '检索中…' : '检索'}
            </button>
          </form>

          {result ? (
            <div className="mt-4">
              <p className="mb-2 text-sm text-slate-500">
                命中 <b className="text-slate-700">{result.hits.length}</b> 条 · 模式 {result.mode}
              </p>
              {result.hits.length === 0 ? (
                <p className="text-sm text-slate-500">未找到相关内容</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {result.hits.map((hit, index) => (
                    <li key={`${hit.chunkId}-${index}`} className="py-3">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="inline-block min-w-[1.5rem] rounded bg-brand-50 px-1.5 py-0.5 text-center text-xs font-medium text-brand-600">
                          {index + 1}
                        </span>
                        <span className="font-medium text-slate-800">{hit.docTitle}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          {sourceLabel(hit.source)}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed text-slate-600">{hit.snippet}</p>
                      <p className="mt-1 text-xs text-slate-400">登录后可查看原文</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
