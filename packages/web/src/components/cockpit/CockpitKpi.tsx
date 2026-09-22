interface CockpitKpiProps {
  label: string;
  value: number;
  format: (n: number) => string;
  sub: string;
  alert?: 'warning' | 'danger';
}

/**
 * 驾驶舱 KPI 卡：超大字号 + 数字滚动 + 告警脉冲（alert 时透明度循环）。
 * 强制深色（不随个人主题）。
 */
export default function CockpitKpi({ label, value, format, sub, alert }: CockpitKpiProps) {
  const valueColor =
    alert === 'danger' ? 'var(--chart-danger)' : alert === 'warning' ? 'var(--chart-warning)' : 'var(--cockpit-text)';

  return (
    <div className="flex h-full min-h-32 flex-col justify-between rounded-modal border border-[var(--cockpit-border)] bg-[var(--cockpit-panel)] p-4">
      <p className="text-xs text-[var(--cockpit-text-muted)]">{label}</p>
      <p className="mt-3 text-3xl font-semibold leading-none tabular-nums" style={{ color: valueColor }}>{format(value)}</p>
      <p className="mt-2 text-sm text-[var(--cockpit-text-muted)]">{sub}</p>
    </div>
  );
}
