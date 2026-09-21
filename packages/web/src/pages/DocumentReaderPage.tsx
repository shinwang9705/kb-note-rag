import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { Chunk } from '@kb/shared';

interface DocumentReaderPageProps {
  docId: number;
  /** 初始定位的片段 seq（来自检索结果"查看原文"） */
  initialChunk?: number;
  onBack: () => void;
  onSearchInDoc: (docId: number) => void;
}

/** 从 URL hash/search 解析目标 chunk（#chunk-3 或 ?chunk=3），供直接访问用 */
function chunkFromLocation(): number | null {
  const hash = /^#chunk-(\d+)$/.exec(window.location.hash);
  if (hash) return Number(hash[1]);
  const q = new URLSearchParams(window.location.search);
  const raw = q.get('chunk');
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * 原文阅读视图（DOC-04）：拉 chunks 渲染全文，支持锚点定位 + 高亮。
 */
export default function DocumentReaderPage({
  docId,
  initialChunk,
  onBack,
  onSearchInDoc,
}: DocumentReaderPageProps) {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const sectionRefs = useRef<Record<number, HTMLElement | null>>({});

  const scrollToChunk = useCallback((seq: number) => {
    const el = sectionRefs.current[seq];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setHighlightSeq(seq);
    window.setTimeout(() => setHighlightSeq((cur) => (cur === seq ? null : cur)), 3000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .documentChunks(docId)
      .then((res) => {
        if (cancelled) return;
        setChunks(res.items);
        setLoading(false);
        const target = initialChunk ?? chunkFromLocation();
        if (target !== null && target !== undefined) {
          // 等 section 挂载后再定位
          window.setTimeout(() => scrollToChunk(target), 0);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof ApiClientError ? err.message : '加载文档失败');
      });
    return () => {
      cancelled = true;
    };
  }, [docId, initialChunk, scrollToChunk]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-secondary-100"
        >
          ← 返回上一页
        </button>
        <button
          type="button"
          onClick={() => onSearchInDoc(docId)}
          className="rounded-control border border-primary-200 px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50"
        >
          在本文档内检索
        </button>
      </div>

      {error ? <p className="text-sm text-danger-600">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : (
        <div className="rounded-card border border-line bg-surface p-6 shadow-card">
          {chunks.length === 0 ? (
            <p className="text-sm text-muted">该文档没有可展示的正文。</p>
          ) : (
            <div className="space-y-6">
              {chunks.map((chunk) => (
                <section
                  key={chunk.seq}
                  id={`chunk-${chunk.seq}`}
                  ref={(el) => {
                    sectionRefs.current[chunk.seq] = el;
                  }}
                  className={`rounded-card border px-4 py-3 transition-colors ${
                    highlightSeq === chunk.seq ? 'border-warning-300 bg-warning-50' : 'border-line'
                  }`}
                >
                  <p className="mb-1 text-xs text-muted">
                    片段 #{chunk.seq}
                    {chunk.sectionPath ? <span className="ml-2 text-secondary-500">§ {chunk.sectionPath}</span> : null}
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{chunk.content}</p>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
