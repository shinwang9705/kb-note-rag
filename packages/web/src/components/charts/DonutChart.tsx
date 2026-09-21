/**
 * 环形图（文档类型 / 状态分布）。
 * 颜色读 CSS 变量（app 主题切换自动换色；cockpit 用 --chart-* 深色色板）。
 */
import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { DistItem } from '@kb/shared';
import { chartPalette, EChartsBase, useThemeVersion, type ChartVariant } from './EChartsBase.js';

interface DonutChartProps {
  data: DistItem[];
  loading?: boolean;
  height?: number | string;
  variant?: ChartVariant;
}

export default function DonutChart({ data, loading, height = 280, variant = 'app' }: DonutChartProps) {
  const themeVersion = useThemeVersion();

  const option = useMemo<EChartsCoreOption>(
    () => {
      const p = chartPalette(variant);
      const palette = [p.brand, p.success, p.warning, p.danger, p.info, p.accent, p.neutral, p.ext1, p.ext2];
      const labelFont = variant === 'cockpit' ? 13 : 12;
      return {
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        legend: { orient: 'vertical', right: 8, top: 'center', textStyle: { color: p.muted, fontSize: labelFont } },
        series: [
          {
            type: 'pie',
            radius: ['45%', '70%'],
            center: ['38%', '50%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: p.surface, borderWidth: 2 },
            label: { show: false },
            data: data.map((d, i) => ({ name: d.label, value: d.count, itemStyle: { color: palette[i % palette.length] } })),
          },
        ],
      } as EChartsCoreOption;
    },
    [data, themeVersion, variant],
  );

  if (loading) {
    return <div className="animate-pulse rounded bg-secondary-100" style={{ height }} />;
  }
  return <EChartsBase option={option} height={height} />;
}
