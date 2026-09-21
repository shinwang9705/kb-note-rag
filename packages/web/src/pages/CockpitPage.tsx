import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { DocumentStats, StatsTrend, TopItem, UsageStats, User } from '@kb/shared';
import CockpitHeader from '../components/cockpit/CockpitHeader.js';
import CockpitKpi from '../components/cockpit/CockpitKpi.js';
import CockpitChartCard from '../components/cockpit/CockpitChartCard.js';
import LineChart from '../components/charts/LineChart.js';
import DonutChart from '../components/charts/DonutChart.js';
import BarList from '../components/charts/BarList.js';
import Gauge from '../components/charts/Gauge.js';

interface CockpitPageProps {
  user: User;
  onExit: () => void;
}

type Usage = UsageStats & { docQuota: number; storageQuotaBytes: number };

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
 * 数据驾驶舱（独立大屏页，AppShell 之外全屏渲染）。
 * 强制深色高对比（不随个人主题）；12 列栅格；60s 静默刷新（失败保持上一帧）。
 * Esc：全屏态先退全屏，非全屏态退出驾驶舱。
 */
export default function CockpitPage({ user, onExit }: CockpitPageProps) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [docStats, setDocStats] = useState<DocumentStats | null>(null);
  const [trend, setTrend] = useState<StatsTrend | null>(null);
  const [topQueries, setTopQueries] = useState<TopItem[]>([]);
  const [topDocs, setTopDocs] = useState<TopItem[]>([]);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [u, d, t, tq, td] = await Promise.all([
        api.statsUsage(),
        api.documentStats(),
        api.statsTrend(30),
        api.statsTop('query'),
        api.statsTop('doc'),
      ]);
      setUsage(u);
      setDocStats(d);
      setTrend(t);
      setTopQueries(tq.items);
      setTopDocs(td.items);
    } catch {
      /* 静默刷新失败：保持上一帧，不闪空态 */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // 同步浏览器全屏状态（供「全屏/退出全屏」按钮与 Esc 逻辑判断）
  useEffect(() => {
    const onChange = (): void => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Esc：全屏态先退浏览器全屏；非全屏态退出驾驶舱
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      } else {
        onExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  const docQuota = usage?.docQuota ?? 0;
  const storageQuota = usage?.storageQuotaBytes ?? 0;
  const docAlert: 'warning' | undefined =
    usage && docQuota > 0 && usage.docCount / docQuota >= 0.8 ? 'warning' : undefined;
  const storageAlert: 'danger' | undefined =
    usage && storageQuota > 0 && usage.storageBytes / storageQuota >= 0.8 ? 'danger' : undefined;
  const failAlert: 'warning' | undefined = docStats && docStats.docFailed > 0 ? 'warning' : undefined;

  const trendHeight = 'clamp(320px, 26vw, 460px)';
  const smallHeight = 'clamp(240px, 20vw, 360px)';

  return (
    <div className="h-screen w-screen overflow-y-auto bg-[var(--cockpit-bg)] text-[var(--cockpit-text)] lg:overflow-hidden">
      <CockpitHeader
        title={`数据驾驶舱 · ${user.username}`}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onExit={onExit}
      />

      <div className="grid grid-cols-12 gap-4 p-6">
        {/* 第 1 行：4 个 KPI（各 col-span-3，小屏纵向堆叠） */}
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitKpi
            label="文档数"
            value={usage?.docCount ?? 0}
            format={(n) => `${Math.round(n)} / ${docQuota}`}
            sub={docStats ? `就绪 ${docStats.docReady} · 失败 ${docStats.docFailed}` : '加载中…'}
            alert={docAlert}
          />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitKpi
            label="存储占用"
            value={usage?.storageBytes ?? 0}
            format={(n) => `${formatSize(n)} / ${formatSize(storageQuota)}`}
            sub="已用 / 配额"
            alert={storageAlert}
          />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitKpi
            label="近 7 日检索"
            value={usage?.searchCount7d ?? 0}
            format={(n) => String(Math.round(n))}
            sub="检索总次数"
          />
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitKpi
            label="入库成功率"
            value={(usage?.taskSuccessRate ?? 0) * 100}
            format={(n) => `${Math.round(n)}%`}
            sub={docStats ? `向量覆盖 ${(docStats.vecCoverage * 100).toFixed(0)}%` : '加载中…'}
            alert={failAlert}
          />
        </div>

        {/* 第 2 行：趋势折线 8 + 配额仪表盘 4 */}
        <div className="col-span-12 lg:col-span-8">
          <CockpitChartCard title="近 30 日趋势" subtitle="检索 / 提问 / 入库">
            <LineChart data={trend?.series ?? []} loading={trend === null} height={trendHeight} variant="cockpit" />
          </CockpitChartCard>
        </div>
        <div className="col-span-12 lg:col-span-4">
          <CockpitChartCard title="配额使用" subtitle="存储 / 文档">
            <Gauge
              data={[
                { label: '存储', value: usage?.storageBytes ?? 0, max: Math.max(1, storageQuota) },
                { label: '文档', value: usage?.docCount ?? 0, max: Math.max(1, docQuota) },
              ]}
              loading={usage === null}
              height={trendHeight}
              variant="cockpit"
            />
          </CockpitChartCard>
        </div>

        {/* 第 3 行：类型分布 / 状态分布 / 热门检索词 / 热门文档 各 col-span-3 */}
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitChartCard title="文档类型分布">
            <DonutChart data={docStats?.typeDist ?? []} loading={docStats === null} height={smallHeight} variant="cockpit" />
          </CockpitChartCard>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitChartCard title="文档状态分布">
            <DonutChart data={docStats?.statusDist ?? []} loading={docStats === null} height={smallHeight} variant="cockpit" />
          </CockpitChartCard>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitChartCard title="热门检索词">
            <BarList data={topQueries} loading={trend === null} height={smallHeight} variant="cockpit" />
          </CockpitChartCard>
        </div>
        <div className="col-span-12 sm:col-span-6 lg:col-span-3">
          <CockpitChartCard title="热门被引文档">
            <BarList data={topDocs} loading={trend === null} height={smallHeight} variant="cockpit" />
          </CockpitChartCard>
        </div>
      </div>
    </div>
  );
}
