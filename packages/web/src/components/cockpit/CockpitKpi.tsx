import { useEffect, useRef, useState } from 'react';
import { animate, motion } from 'framer-motion';

interface CockpitKpiProps {
  label: string;
  value: number;
  format: (n: number) => string;
  sub: string;
  alert?: 'warning' | 'danger';
}

/** 数字滚动：0 -> 目标值，format 始终取最新（ref 避免依赖抖动导致重放） */
function AnimatedNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const formatRef = useRef(format);
  formatRef.current = format;
  const [text, setText] = useState(() => format(0));
  useEffect(() => {
    const controls = animate(0, value, {
      duration: 0.8,
      ease: 'easeOut',
      onUpdate: (v) => setText(formatRef.current(v)),
    });
    return () => controls.stop();
  }, [value]);
  return <span>{text}</span>;
}

/**
 * 驾驶舱 KPI 卡：超大字号 + 数字滚动 + 告警脉冲（alert 时透明度循环）。
 * 强制深色（不随个人主题）。
 */
export default function CockpitKpi({ label, value, format, sub, alert }: CockpitKpiProps) {
  const valueColor =
    alert === 'danger' ? 'var(--chart-danger)' : alert === 'warning' ? 'var(--chart-warning)' : 'var(--cockpit-text)';

  return (
    <div className="flex h-full flex-col justify-between rounded-modal border border-[var(--cockpit-border)] bg-[var(--cockpit-panel)] p-6">
      <p className="text-[clamp(12px,1vw,16px)] text-[var(--cockpit-text-muted)]">{label}</p>
      <p className="mt-3 font-semibold leading-none text-[clamp(24px,2.2vw,40px)]" style={{ color: valueColor }}>
        {alert ? (
          <motion.span
            animate={{ opacity: [1, 0.55, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <AnimatedNumber value={value} format={format} />
          </motion.span>
        ) : (
          <AnimatedNumber value={value} format={format} />
        )}
      </p>
      <p className="mt-2 text-sm text-[var(--cockpit-text-muted)]">{sub}</p>
    </div>
  );
}
