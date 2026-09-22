/**
 * ECharts 通用 wrapper（自研，不引 echarts-for-react）。
 *
 * 职责：
 *   1. 按需注册 chart/component/renderer（tree-shaking）；
 *   2. useECharts：实例创建/销毁 + ResizeObserver 自适应 + 主题色注入；
 *   3. 主题切换自适应：监听 documentElement 的 data-theme/style 变化，强制组件重渲染重取色；
 *   4. 驾驶舱深色色板：variant='cockpit' 时读取 --chart-* 变量。
 */
import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

echarts.use([
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** 图表主题变体：app=随个人主题；cockpit=驾驶舱强制深色 */
export type ChartVariant = 'app' | 'cockpit';

/** 读取 CSS 变量语义色（主题切换后自动换色） */
export function cssVar(name: string, fallback = '#64748b'): string {
  if (typeof window === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 主题版本号：data-theme / 行内 style 变化时自增，触发图表组件重渲染重取色 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  return version;
}

/** 图表统一色板（app 读语义色；cockpit 读驾驶舱深色 --chart-* 变量） */
export interface ChartPalette {
  brand: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  accent: string;
  neutral: string;
  ext1: string;
  ext2: string;
  text: string;
  muted: string;
  line: string;
  surface: string;
  track: string;
}

export function chartPalette(variant: ChartVariant = 'app'): ChartPalette {
  if (variant === 'cockpit') {
    return {
      brand: cssVar('--chart-brand', '#38bdf8'),
      success: cssVar('--chart-success', '#34d399'),
      warning: cssVar('--chart-warning', '#fbbf24'),
      danger: cssVar('--chart-danger', '#f87171'),
      info: cssVar('--chart-info', '#38bdf8'),
      accent: cssVar('--chart-accent', '#a78bfa'),
      neutral: cssVar('--cockpit-text-muted', '#94a3b8'),
      ext1: cssVar('--chart-ext1', '#22d3ee'),
      ext2: cssVar('--chart-ext2', '#fb7185'),
      text: cssVar('--cockpit-text', '#e2e8f0'),
      muted: cssVar('--cockpit-text-muted', '#94a3b8'),
      line: cssVar('--cockpit-border', 'rgba(148,163,184,0.18)'),
      surface: cssVar('--cockpit-panel', '#111a2e'),
      track: 'rgba(148,163,184,0.15)',
    };
  }
  return {
    brand: cssVar('--color-brand-500', '#3b82f6'),
    success: cssVar('--color-success-500', '#10b981'),
    warning: cssVar('--color-warning-500', '#f59e0b'),
    danger: cssVar('--color-danger-500', '#ef4444'),
    info: cssVar('--color-info-500', '#0ea5e9'),
    accent: cssVar('--color-accent', '#8b5cf6'),
    neutral: cssVar('--color-secondary-500', '#64748b'),
    ext1: cssVar('--color-info-300', '#7dd3fc'),
    ext2: cssVar('--color-danger-300', '#fca5a5'),
    text: cssVar('--color-text', '#0f172a'),
    muted: cssVar('--color-text-muted', '#64748b'),
    line: cssVar('--color-border', '#e2e8f0'),
    surface: cssVar('--color-surface', '#ffffff'),
    track: cssVar('--color-secondary-100', '#f1f5f9'),
  };
}

interface EChartsBaseProps {
  option: EChartsCoreOption;
  height?: number | string;
  className?: string;
}

export function EChartsBase({ option, height = 280, className }: EChartsBaseProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} className={className} style={{ width: '100%', height }} />;
}
