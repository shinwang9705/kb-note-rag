import { P0_NAV, type NavKey } from '../nav.js';
import Icon from './icons.js';

interface BottomTabProps {
  activeView: NavKey;
  onNavigate: (view: NavKey) => void;
}

/**
 * 移动端底部 5 个 P0 核心 Tab（工作台/知识库/文档/检索/对话）。
 * 仅 <768 显示；对话为主 CTA 用品牌色强调。
 */
export default function BottomTab({ activeView, onNavigate }: BottomTabProps) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface sm:hidden">
      {P0_NAV.map((item) => {
        const active = activeView === item.key;
        const emphasized = item.key === 'chat';
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigate(item.key)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
              active
                ? emphasized
                  ? 'font-medium text-primary-600'
                  : 'font-medium text-primary-600'
                : emphasized
                  ? 'text-primary-500'
                  : 'text-muted'
            }`}
          >
            <Icon name={item.icon} size={20} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
