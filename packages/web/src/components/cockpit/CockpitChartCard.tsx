interface CockpitChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

/**
 * 驾驶舱图表容器：深色面板 + 标题 + 副标题。
 * h-full 让同一栅格行内的卡片等高。
 */
export default function CockpitChartCard({ title, subtitle, children }: CockpitChartCardProps) {
  return (
    <div className="flex h-full flex-col rounded-modal border border-[var(--cockpit-border)] bg-[var(--cockpit-panel)] p-6">
      <h2 className="text-base font-medium text-[var(--cockpit-text)]">{title}</h2>
      {subtitle ? <p className="mt-1 text-xs text-[var(--cockpit-text-muted)]">{subtitle}</p> : null}
      <div className="mt-4 min-h-0 flex-1">{children}</div>
    </div>
  );
}
