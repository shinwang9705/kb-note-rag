/**
 * 热门排行横向条形（检索词 / 被引用文档）。
 * 轻量 HTML + framer-motion 条宽动画（不引 echarts）。
 * variant='cockpit' 时走驾驶舱深色色板（读 --chart-* / --cockpit-* 变量）。
 */
import { motion } from 'framer-motion';
import type { TopItem } from '@kb/shared';
import type { ChartVariant } from './EChartsBase.js';

interface BarListProps {
  data: TopItem[];
  loading?: boolean;
  height?: number | string;
  variant?: ChartVariant;
}

export default function BarList({ data, loading, height = 280, variant = 'app' }: BarListProps) {
  const max = Math.max(1, ...data.map((item) => item.count));
  const cockpit = variant === 'cockpit';
  const muted = cockpit ? 'text-[var(--cockpit-text-muted)]' : 'text-muted';
  const ink = cockpit ? 'text-[var(--cockpit-text)]' : 'text-ink';
  // 条填充 / 轨道直接用 CSS 变量引用，app 主题切换自动变色、cockpit 固定深色
  const fillBg = cockpit ? 'var(--chart-brand)' : 'var(--color-brand-500)';
  const trackBg = cockpit ? 'rgba(148,163,184,0.15)' : 'var(--color-secondary-100)';

  if (loading) {
    return <div className="animate-pulse rounded bg-secondary-100" style={{ height }} />;
  }
  if (data.length === 0) {
    return (
      <div className={`flex items-center justify-center text-sm ${muted}`} style={{ height }}>
        暂无数据
      </div>
    );
  }

  return (
    <ul className="space-y-2 overflow-y-auto" style={{ maxHeight: height }}>
      {data.map((item, index) => (
        <li key={`${item.key}-${index}`} className="flex items-center gap-3 text-sm">
          <span className={`w-5 shrink-0 text-right text-xs ${muted}`}>{index + 1}</span>
          <span className={`w-0 flex-1 truncate ${ink}`} title={item.title}>
            {item.title}
          </span>
          <div className="relative h-4 w-24 shrink-0 rounded sm:w-32" style={{ background: trackBg }}>
            <motion.div
              initial={{ width: 0 }}
              whileInView={{ width: `${Math.max(4, (item.count / max) * 100)}%` }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: index * 0.05, ease: 'easeOut' }}
              className="absolute inset-y-0 left-0 rounded"
              style={{ background: fillBg }}
            />
          </div>
          <span className={`w-10 shrink-0 text-right text-xs ${muted}`}>{item.count}</span>
        </li>
      ))}
    </ul>
  );
}
