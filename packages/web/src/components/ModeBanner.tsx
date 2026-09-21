import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export interface ModeInfo {
  searchMode: string;
  embeddingProvider: string;
  vecAvailable: boolean;
}

interface ModeBannerProps {
  /** 受控模式信息（由 App 提供时不再自行拉取 meta） */
  info?: ModeInfo | null;
  /** 紧凑态：仅色点 + 短文案（用于顶栏） */
  compact?: boolean;
}

type Tone = 'primary' | 'warning' | 'info';

const TONE_STYLE: Record<Tone, string> = {
  primary: 'border-primary-100 bg-primary-50 text-primary-700',
  warning: 'border-warning-200 bg-warning-50 text-warning-700',
  info: 'border-info-200 bg-info-50 text-info-700',
};

const DOT_STYLE: Record<Tone, string> = {
  primary: 'bg-primary-500',
  warning: 'bg-warning-500',
  info: 'bg-info-500',
};

/**
 * 检索模式横幅：显示当前实际生效的检索模式（混合 / 仅关键词 / 降级）。
 * - 混合 hybrid → primary
 * - 仅关键词且向量可用（手动） → info
 * - 仅关键词且向量不可用/未装载（降级） → warning
 */
export default function ModeBanner({ info, compact = false }: ModeBannerProps) {
  const [fetched, setFetched] = useState<ModeInfo | null>(null);
  const [failed, setFailed] = useState(false);

  const controlled = info !== undefined;

  useEffect(() => {
    if (controlled) return;
    let cancelled = false;
    void api
      .meta()
      .then((meta) => {
        if (cancelled) return;
        setFetched({
          searchMode: meta.searchMode,
          embeddingProvider: meta.embeddingProvider,
          vecAvailable: meta.vecAvailable,
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [controlled]);

  if (!controlled && failed) return null;

  const data = controlled ? (info ?? null) : fetched;
  const hybrid = data?.searchMode === 'hybrid';
  const loading = data === null;
  const degraded =
    data?.searchMode === 'keyword' && (!data.vecAvailable || data.embeddingProvider === 'none');
  const tone: Tone = hybrid ? 'primary' : degraded ? 'warning' : 'info';

  const label = loading
    ? '加载中…'
    : hybrid
      ? '混合检索'
      : degraded
        ? '仅关键词 · 降级'
        : '仅关键词';

  const detail = loading
    ? '检索模式加载中…'
    : hybrid
      ? '当前为混合检索（关键词 + 语义向量）'
      : degraded
        ? '向量不可用，当前仅关键词检索，近义/模糊召回可能受限'
        : '当前仅关键词检索（语义向量可用，可在检索页切换）';

  if (compact) {
    return (
      <span
        title={detail}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${TONE_STYLE[tone]}`}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${DOT_STYLE[tone]}`} />
        {label}
      </span>
    );
  }

  return (
    <div className={`mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${TONE_STYLE[tone]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${DOT_STYLE[tone]}`} />
      {loading ? (
        <span>检索模式加载中…</span>
      ) : (
        <span>
          {hybrid ? (
            <span>
              当前为<b>混合检索</b>（关键词 + 语义向量），能按语义召回近义内容。
            </span>
          ) : (
            <span>
              当前为<b>仅关键词检索</b>
              {data && !data.vecAvailable
                ? '（未装载 sqlite-vec 向量扩展）'
                : data?.embeddingProvider === 'none'
                  ? '（已关闭向量化）'
                  : '（语义向量不可用）'}
              ，近义/模糊查询的召回可能受限。
            </span>
          )}
        </span>
      )}
    </div>
  );
}
