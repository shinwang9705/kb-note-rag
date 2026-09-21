/**
 * 配额仪表盘（存储 / 文档配额）。
 * 每个配额项一个 gauge；>=80% 黄、>=95% 红（语义色读 CSS 变量，cockpit 用 --chart-* 深色色板）。
 */
import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { chartPalette, EChartsBase, useThemeVersion, type ChartPalette, type ChartVariant } from './EChartsBase.js';

export interface GaugeItem {
  label: string;
  value: number;
  max: number;
}

interface GaugeProps {
  data: GaugeItem[];
  loading?: boolean;
  height?: number | string;
  variant?: ChartVariant;
}

function gaugeOption(item: GaugeItem, p: ChartPalette, cockpit: boolean): EChartsCoreOption {
  const pct = item.max > 0 ? Math.min(100, Math.round((item.value / item.max) * 100)) : 0;
  const color = pct >= 95 ? p.danger : pct >= 80 ? p.warning : p.brand;
  return {
    series: [
      {
        type: 'gauge',
        min: 0,
        max: 100,
        startAngle: 210,
        endAngle: -30,
        radius: '90%',
        center: ['50%', '60%'],
        progress: { show: true, width: 12, itemStyle: { color } },
        axisLine: { lineStyle: { width: 12, color: [[1, p.track]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        title: { show: true, offsetCenter: [0, '75%'], fontSize: cockpit ? 13 : 12, color: p.muted },
        detail: { valueAnimation: true, fontSize: cockpit ? 24 : 20, formatter: '{value}%', color: p.text },
        data: [{ value: pct, name: item.label }],
      },
    ],
  } as EChartsCoreOption;
}

export default function Gauge({ data, loading, height = 200, variant = 'app' }: GaugeProps) {
  const themeVersion = useThemeVersion();

  const options = useMemo(
    () => data.map((item) => gaugeOption(item, chartPalette(variant), variant === 'cockpit')),
    [data, themeVersion, variant],
  );

  if (loading) {
    return <div className="animate-pulse rounded bg-secondary-100" style={{ height }} />;
  }

  return (
    <div className="flex flex-wrap gap-4">
      {data.map((item, index) => (
        <div key={item.label} className="min-w-[160px] flex-1">
          <p className={`mb-1 text-center text-sm ${variant === 'cockpit' ? 'text-[var(--cockpit-text-muted)]' : 'text-muted'}`}>
            {item.label}
          </p>
          <EChartsBase option={options[index] as EChartsCoreOption} height={height} />
          <p className={`text-center text-xs ${variant === 'cockpit' ? 'text-[var(--cockpit-text-muted)]' : 'text-muted'}`}>
            {item.value} / {item.max}
          </p>
        </div>
      ))}
    </div>
  );
}
