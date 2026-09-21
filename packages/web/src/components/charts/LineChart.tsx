/**
 * 趋势折线图：检索 / 提问 / 入库 三条线。
 * 颜色读 CSS 变量（app 主题切换自动换色；cockpit 用 --chart-* 深色色板）。
 */
import { useMemo } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import type { StatsTrendPoint } from '@kb/shared';
import { chartPalette, EChartsBase, useThemeVersion, type ChartVariant } from './EChartsBase.js';

interface LineChartProps {
  data: StatsTrendPoint[];
  loading?: boolean;
  height?: number | string;
  variant?: ChartVariant;
}

export default function LineChart({ data, loading, height = 280, variant = 'app' }: LineChartProps) {
  const themeVersion = useThemeVersion();

  const option = useMemo<EChartsCoreOption>(
    () => {
      const p = chartPalette(variant);
      const labelFont = variant === 'cockpit' ? 13 : 12;
      return {
        tooltip: { trigger: 'axis' },
        legend: { data: ['检索', '提问', '入库'], top: 0, textStyle: { color: p.muted, fontSize: labelFont } },
        grid: { left: 40, right: 16, top: 40, bottom: 28, containLabel: true },
        xAxis: {
          type: 'category',
          data: data.map((d) => d.date.slice(5)),
          axisLine: { lineStyle: { color: p.line } },
          axisLabel: { color: p.muted, fontSize: labelFont },
        },
        yAxis: {
          type: 'value',
          minInterval: 1,
          splitLine: { lineStyle: { color: p.line } },
          axisLabel: { color: p.muted, fontSize: labelFont },
        },
        series: [
          { name: '检索', type: 'line', smooth: true, data: data.map((d) => d.search), itemStyle: { color: p.brand }, lineStyle: { color: p.brand } },
          { name: '提问', type: 'line', smooth: true, data: data.map((d) => d.chat), itemStyle: { color: p.success }, lineStyle: { color: p.success } },
          { name: '入库', type: 'line', smooth: true, data: data.map((d) => d.ingest), itemStyle: { color: p.warning }, lineStyle: { color: p.warning } },
        ],
      } as EChartsCoreOption;
    },
    // themeVersion 变化时重取语义色；eslint 不感知，但依赖数组显式声明
    [data, themeVersion, variant],
  );

  if (loading) {
    return <div className="animate-pulse rounded bg-secondary-100" style={{ height }} />;
  }
  return <EChartsBase option={option} height={height} />;
}
