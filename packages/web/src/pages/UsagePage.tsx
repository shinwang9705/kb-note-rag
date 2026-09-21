import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { AdminUsageStats, DocumentStats, UsageStats, User } from '@kb/shared';

interface UsagePageProps {
  user: User;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 用量看板（OPS-05）+ 索引健康面板（IDX-07）。
 * admin 额外看全局用量。
 */
export default function UsagePage({ user }: UsagePageProps) {
  const [usage, setUsage] = useState<(UsageStats & { docQuota: number; storageQuotaBytes: number }) | null>(null);
  const [docStats, setDocStats] = useState<DocumentStats | null>(null);
  const [adminStats, setAdminStats] = useState<AdminUsageStats | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const [u, d] = await Promise.all([api.statsUsage(), api.documentStats()]);
      setUsage(u);
      setDocStats(d);
      if (user.role === 'admin') {
        setAdminStats(await api.adminStats());
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载用量统计失败');
    }
  }, [user.role]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-danger-600">{error}</p> : null}

      {/* 本人用量 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">我的用量</h2>
        {usage ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="文档数" value={`${usage.docCount} / ${usage.docQuota}`} />
            <Stat label="存储占用" value={`${formatSize(usage.storageBytes)} / ${formatSize(usage.storageQuotaBytes)}`} />
            <Stat label="近 7 日检索" value={String(usage.searchCount7d)} />
            <Stat label="入库成功率" value={`${(usage.taskSuccessRate * 100).toFixed(0)}%`} />
          </div>
        ) : (
          <p className="text-sm text-muted">加载中…</p>
        )}
      </section>

      {/* 索引健康 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">索引健康</h2>
        {docStats ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="文档总数" value={String(docStats.docTotal)} />
            <Stat label="就绪 / 失败" value={`${docStats.docReady} / ${docStats.docFailed}`} />
            <Stat label="片段总数" value={String(docStats.chunkTotal)} />
            <Stat
              label="向量覆盖"
              value={`${docStats.vecCovered} 条（${(docStats.vecCoverage * 100).toFixed(1)}%）`}
            />
          </div>
        ) : (
          <p className="text-sm text-muted">加载中…</p>
        )}
        {docStats && docStats.chunkTotal > 0 && docStats.vecCoverage === 0 ? (
          <p className="mt-3 text-xs text-warning-600">
            当前无向量覆盖（向量化未启用或 sqlite-vec 未装载），检索仅关键词模式。
          </p>
        ) : null}
      </section>

      {/* 管理员全局用量 */}
      {user.role === 'admin' ? (
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <h2 className="mb-4 text-lg font-medium">全局用量（管理员）</h2>
          {adminStats ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="用户数" value={String(adminStats.userCount)} />
              <Stat label="文档总数" value={String(adminStats.docCount)} />
              <Stat label="存储占用" value={formatSize(adminStats.storageBytes)} />
              <Stat label="近 7 日检索" value={String(adminStats.searchCount7d)} />
            </div>
          ) : (
            <p className="text-sm text-muted">加载中…</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-secondary-50 px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-medium text-ink">{value}</p>
    </div>
  );
}
