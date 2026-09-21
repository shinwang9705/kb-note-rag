import { useEffect, useState } from 'react';
import Icon from '../icons.js';

interface CockpitHeaderProps {
  title: string;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExit: () => void;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * 驾驶舱标题栏：标题 + 实时时钟 + 返回工作台 + 全屏切换。
 * 全屏状态由 CockpitPage 通过 fullscreenchange 同步下发（本组件只渲染）。
 */
export default function CockpitHeader({ title, isFullscreen, onToggleFullscreen, onExit }: CockpitHeaderProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--cockpit-border)] bg-[var(--cockpit-panel)] px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-[var(--chart-brand)]">
          <Icon name="cockpit" size={22} />
        </span>
        <h1 className="truncate text-xl font-semibold text-[var(--cockpit-text)]">{title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden font-mono text-sm tabular-nums text-[var(--cockpit-text-muted)] sm:block">
          {formatClock(now)}
        </span>
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="rounded-control border border-[var(--cockpit-border)] px-3 py-1.5 text-sm text-[var(--cockpit-text)] hover:bg-white/5"
        >
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="rounded-control border border-[var(--cockpit-border)] px-3 py-1.5 text-sm text-[var(--cockpit-text)] hover:bg-white/5"
        >
          ← 返回工作台
        </button>
      </div>
    </header>
  );
}
