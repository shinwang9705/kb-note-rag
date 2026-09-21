import { useState } from 'react';
import { api, ApiClientError, exportConversation, exportHistoryBatch } from '../api/client.js';
import type { HistoryHit } from '@kb/shared';

interface HistoryPageProps {
  onOpenConversation?: (conversationId: number) => void;
}

type Preset = 'all' | 'today' | '7d' | '30d' | 'custom';

function presetRange(preset: Preset, customFrom: string, customTo: string): { from?: string; to?: string } {
  const now = new Date();
  if (preset === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { from: start.toISOString() };
  }
  if (preset === '7d') return { from: new Date(now.getTime() - 7 * 86400000).toISOString() };
  if (preset === '30d') return { from: new Date(now.getTime() - 30 * 86400000).toISOString() };
  if (preset === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
  return {};
}

function HighlightedSnippet({ snippet, highlightStart, highlightEnd }: { snippet: string; highlightStart: number; highlightEnd: number }) {
  if (highlightStart < 0 || highlightEnd <= highlightStart) return <span>{snippet}</span>;
  return (
    <span>
      {snippet.slice(0, highlightStart)}
      <mark className="rounded bg-warning-100 px-0.5 text-inherit">{snippet.slice(highlightStart, highlightEnd)}</mark>
      {snippet.slice(highlightEnd)}
    </span>
  );
}

export default function HistoryPage({ onOpenConversation }: HistoryPageProps) {
  const [keyword, setKeyword] = useState('');
  const [preset, setPreset] = useState<Preset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [format, setFormat] = useState<'md' | 'json' | 'txt'>('md');
  const [items, setItems] = useState<HistoryHit[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  const runSearch = async (): Promise<void> => {
    const q = keyword.trim();
    if (!q) {
      setError('请输入搜索关键词');
      return;
    }
    setError('');
    setSearching(true);
    try {
      const range = presetRange(preset, customFrom, customTo);
      const res = await api.historySearch({ keyword: q, from: range.from, to: range.to, limit: 50, offset: 0 });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '搜索失败');
      setItems([]);
      setTotal(0);
    } finally {
      setSearching(false);
    }
  };

  const conversationIds = [...new Set(items.map((item) => item.conversationId))];

  return (
    <div className="space-y-4">
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">历史搜索</h2>
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
            placeholder="搜索历史消息…"
            className="min-w-[240px] flex-1 rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
          />
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            className="rounded-control border border-line px-2 py-2 text-sm outline-none focus:border-primary-500"
          >
            <option value="all">全部时间</option>
            <option value="today">今天</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="custom">自定义</option>
          </select>
          {preset === 'custom' ? (
            <>
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value ? new Date(e.target.value).toISOString() : '')}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none"
              />
              <span className="text-sm text-muted">至</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value ? new Date(e.target.value).toISOString() : '')}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none"
              />
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={searching}
            className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
        {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}
      </section>

      {total > 0 ? (
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">
              命中 <b className="text-ink">{total}</b> 条消息
            </h3>
            <div className="flex items-center gap-2">
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as 'md' | 'json' | 'txt')}
                className="rounded-control border border-line px-2 py-1.5 text-sm outline-none"
              >
                <option value="md">MD</option>
                <option value="json">JSON</option>
                <option value="txt">TXT</option>
              </select>
              <button
                type="button"
                onClick={() => void exportHistoryBatch(conversationIds, format)}
                className="rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-secondary-100"
              >
                导出命中会话
              </button>
            </div>
          </div>

          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.messageId} className="py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{item.conversationTitle}</span>
                  <span
                    className={`rounded-pill px-2 py-0.5 text-xs ${
                      item.role === 'user' ? 'bg-primary-50 text-primary-700' : 'bg-secondary-100 text-secondary-600'
                    }`}
                  >
                    {item.role === 'user' ? '我' : '助手'}
                  </span>
                  <span className="text-xs text-muted">{new Date(item.createdAt).toLocaleString()}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => onOpenConversation?.(item.conversationId)}
                    className="text-xs text-primary-600 hover:underline"
                  >
                    打开对话
                  </button>
                  <button
                    type="button"
                    onClick={() => void exportConversation(item.conversationId, format)}
                    className="text-xs text-muted hover:underline"
                  >
                    导出
                  </button>
                </div>
                <p className="text-sm leading-relaxed text-ink">
                  <HighlightedSnippet
                    snippet={item.snippet}
                    highlightStart={item.highlightStart}
                    highlightEnd={item.highlightEnd}
                  />
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
