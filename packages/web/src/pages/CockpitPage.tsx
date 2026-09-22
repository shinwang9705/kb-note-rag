import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { ConversationQualityStats, DocumentStats, StatsTrend, TopItem, UsageStats, User } from '@kb/shared';
import CockpitHeader from '../components/cockpit/CockpitHeader.js';
import CockpitKpi from '../components/cockpit/CockpitKpi.js';
import CockpitChartCard from '../components/cockpit/CockpitChartCard.js';
import LineChart from '../components/charts/LineChart.js';

interface CockpitPageProps { user: User; onExit: () => void }
type Usage = UsageStats & { docQuota: number; storageQuotaBytes: number };
type Period = 7 | 30 | 90;
type JobInfo = { id: number; kind: string; status: string; progress: number; stage: string; message: string | null; created_at: string };
type IndexInfo = { fingerprint: string; generation: { id: number; status: string; fingerprint: string; activated_at: string | null } | null; readyDocuments: number; trackedDocuments: number; stale: boolean };

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function percent(value: number): string { return `${Math.round(value * 100)}%`; }

function Progress({ label, value, detail, tone = 'brand' }: { label: string; value: number; detail: string; tone?: 'brand' | 'warning' | 'danger' }) {
  const color = tone === 'danger' ? 'var(--chart-danger)' : tone === 'warning' ? 'var(--chart-warning)' : 'var(--chart-brand)';
  return <div><div className="mb-2 flex justify-between gap-3 text-xs"><span className="text-[var(--cockpit-text-muted)]">{label}</span><span className="text-[var(--cockpit-text)]">{detail}</span></div><div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: color }} /></div></div>;
}

function RankedList({ items, empty }: { items: TopItem[]; empty: string }) {
  if (items.length === 0) return <p className="py-8 text-center text-sm text-[var(--cockpit-text-muted)]">{empty}</p>;
  return <ol className="space-y-2">{items.slice(0, 6).map((item, index) => <li key={item.key} className="flex items-center gap-3 rounded-lg bg-white/[0.035] px-3 py-2"><span className="w-5 shrink-0 text-xs font-semibold text-[var(--chart-brand)]">{index + 1}</span><span className="min-w-0 flex-1 truncate text-sm text-[var(--cockpit-text)]" title={item.title}>{item.title}</span><span className="text-xs tabular-nums text-[var(--cockpit-text-muted)]">{item.count}</span></li>)}</ol>;
}

/** 面向行动的数据驾驶舱：优先呈现回答质量、知识缺口和索引健康。 */
export default function CockpitPage({ user, onExit }: CockpitPageProps) {
  const [period, setPeriod] = useState<Period>(30);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [docStats, setDocStats] = useState<DocumentStats | null>(null);
  const [trend, setTrend] = useState<StatsTrend | null>(null);
  const [quality, setQuality] = useState<ConversationQualityStats | null>(null);
  const [topDocs, setTopDocs] = useState<TopItem[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [indexInfo, setIndexInfo] = useState<IndexInfo | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [loadWarning, setLoadWarning] = useState('');

  const load = useCallback(async () => {
    const labels = ['用量', '文档健康', '趋势', '回答质量', '热门文档', '后台任务', '索引版本'];
    const results = await Promise.allSettled([api.statsUsage(), api.documentStats(), api.statsTrend(period), api.statsConversation(period), api.statsTop('doc'), api.jobs(), api.indexStatus()]);
    const [u, d, t, q, td, jobResult, indexResult] = results;
    if (u.status === 'fulfilled') setUsage(u.value);
    if (d.status === 'fulfilled') setDocStats(d.value);
    if (t.status === 'fulfilled') setTrend(t.value); else setTrend({ days: period, series: [] });
    if (q.status === 'fulfilled') setQuality(q.value);
    if (td.status === 'fulfilled') setTopDocs(td.value.items);
    if (jobResult.status === 'fulfilled') setJobs(jobResult.value.items);
    if (indexResult.status === 'fulfilled') setIndexInfo(indexResult.value);
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [labels[index] ?? '未知模块'] : []);
    setLoadWarning(failed.length > 0 ? `部分模块暂不可用：${failed.join('、')}。请重启后端服务后刷新。` : '');
  }, [period]);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { const change = () => setIsFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change); }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else onExit(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onExit]);
  const toggleFullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void document.documentElement.requestFullscreen().catch(() => {}); };
  const docQuotaUse = usage && usage.docQuota > 0 ? usage.docCount / usage.docQuota : 0;
  const storageQuotaUse = usage && usage.storageQuotaBytes > 0 ? usage.storageBytes / usage.storageQuotaBytes : 0;
  const latestJob = jobs[0] ?? null;

  return <div className="min-h-screen w-screen overflow-y-auto bg-[var(--cockpit-bg)] text-[var(--cockpit-text)]">
    <CockpitHeader title={`问答质量驾驶舱 · ${user.username}`} isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} onExit={onExit} />
    <main className="mx-auto max-w-[1800px] space-y-4 p-4 lg:p-5">
      {loadWarning ? <div role="alert" className="rounded-lg border border-[var(--chart-warning)]/40 bg-[var(--chart-warning)]/10 px-4 py-3 text-sm text-[var(--chart-warning)]">{loadWarning}</div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">今天需要关注什么</h2><p className="mt-1 text-xs text-[var(--cockpit-text-muted)]">从回答质量到知识缺口，再到索引健康</p></div><div className="flex rounded-lg border border-[var(--cockpit-border)] bg-[var(--cockpit-panel)] p-1">{([7, 30, 90] as Period[]).map((item) => <button key={item} type="button" onClick={() => setPeriod(item)} className={`rounded-md px-3 py-1.5 text-xs ${period === item ? 'bg-white/10 text-white' : 'text-[var(--cockpit-text-muted)] hover:text-white'}`}>{item} 天</button>)}</div></div>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <CockpitKpi label="提问量" value={quality?.questions ?? 0} format={(n) => String(Math.round(n))} sub={`近 ${period} 天`} />
        <CockpitKpi label="回答完成率" value={(quality?.completionRate ?? 0) * 100} format={(n) => `${Math.round(n)}%`} sub={`${quality?.failedAnswers ?? 0} 条失败或中止`} alert={quality && quality.completionRate < 0.9 ? 'warning' : undefined} />
        <CockpitKpi label="证据覆盖率" value={(quality?.citationRate ?? 0) * 100} format={(n) => `${Math.round(n)}%`} sub={`${quality?.citedAnswers ?? 0} 条有引用`} alert={quality && quality.citationRate < 0.6 ? 'warning' : undefined} />
        <CockpitKpi label="平均响应" value={quality?.averageLatencyMs ?? 0} format={(n) => n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`} sub="已完成回答" />
        <CockpitKpi label="索引覆盖" value={(docStats?.vecCoverage ?? 0) * 100} format={(n) => `${Math.round(n)}%`} sub={`${docStats?.docReady ?? 0} 文档就绪`} alert={docStats && (docStats.docFailed > 0 || docStats.vecCoverage < 0.9) ? 'danger' : undefined} />
      </section>
      <section className="grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-8"><CockpitChartCard title={`近 ${period} 日使用趋势`} subtitle="提问、检索与知识入库"><LineChart data={trend?.series ?? []} loading={trend === null} height="280px" variant="cockpit" /></CockpitChartCard></div>
        <div className="col-span-12 xl:col-span-4"><CockpitChartCard title="系统健康" subtitle="达到 80% 或出现失败时需要处理"><div className="space-y-5 py-3"><Progress label="文档配额" value={docQuotaUse} detail={`${usage?.docCount ?? 0} / ${usage?.docQuota ?? 0}`} tone={docQuotaUse >= .8 ? 'warning' : 'brand'} /><Progress label="存储配额" value={storageQuotaUse} detail={`${formatSize(usage?.storageBytes ?? 0)} / ${formatSize(usage?.storageQuotaBytes ?? 0)}`} tone={storageQuotaUse >= .8 ? 'warning' : 'brand'} /><Progress label="向量覆盖" value={docStats?.vecCoverage ?? 0} detail={percent(docStats?.vecCoverage ?? 0)} tone={(docStats?.vecCoverage ?? 0) < .9 ? 'danger' : 'brand'} /><div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border border-[var(--cockpit-border)] bg-white/[0.025] p-3"><span className="block text-[var(--cockpit-text-muted)]">索引版本</span><span className={indexInfo?.stale ? 'text-[var(--chart-warning)]' : 'text-[var(--cockpit-text)]'}>{indexInfo?.generation ? `#${indexInfo.generation.id} · ${indexInfo.stale ? '待更新' : '当前'}` : '尚未重建'}</span></div><div className="rounded-lg border border-[var(--cockpit-border)] bg-white/[0.025] p-3"><span className="block text-[var(--cockpit-text-muted)]">最近后台任务</span><span className="text-[var(--cockpit-text)]">{latestJob ? `#${latestJob.id} · ${latestJob.status}` : '暂无任务'}</span></div></div></div></CockpitChartCard></div>
      </section>
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2"><CockpitChartCard title="知识缺口" subtitle="回答完成但没有引用证据的问题，优先补充知识"><RankedList items={quality?.noEvidenceQuestions ?? []} empty="当前周期没有发现知识缺口" /></CockpitChartCard><CockpitChartCard title="高价值知识" subtitle="最常被回答引用的文档"><RankedList items={topDocs} empty="产生带引用的回答后会显示" /></CockpitChartCard></section>
    </main>
  </div>;
}
