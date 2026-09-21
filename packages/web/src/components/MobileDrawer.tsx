import type { User } from '@kb/shared';
import { P1_NAV, P2_NAV, type NavKey } from '../nav.js';
import Icon, { type IconName } from './icons.js';

interface MobileDrawerProps {
  activeView: NavKey;
  user: User;
  open: boolean;
  onNavigate: (view: NavKey) => void;
  onClose: () => void;
  onLogout: () => void;
}

/**
 * 移动端汉堡抽屉（更多 + 账号/系统），半屏遮罩，手写 translate-x 侧滑。
 * 仅 <768 使用。
 */
export default function MobileDrawer({ activeView, user, open, onNavigate, onClose, onLogout }: MobileDrawerProps) {
  const accountItems = P2_NAV.filter((item) => item.key !== 'admin' || user.role === 'admin');
  const initial = user.username.slice(0, 1).toUpperCase();
  // 关闭时卸载，避免屏幕阅读器和键盘访问屏幕外的菜单项。
  if (!open) return null;

  const navButton = (label: string, icon: IconName, key: NavKey): React.ReactNode => (
    <button
      key={key}
      type="button"
      onClick={() => onNavigate(key)}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm ${
        activeView === key ? 'bg-primary-50 font-medium text-primary-700' : 'text-ink hover:bg-secondary-100'
      }`}
    >
      <Icon name={icon} size={20} className="shrink-0" />
      {label}
    </button>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="导航菜单" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} className="fixed inset-0 z-50 sm:hidden">
      {/* 半屏遮罩 */}
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        aria-hidden="true"
      />
      {/* 抽屉面板 */}
      <div
        className={`absolute inset-y-0 left-0 flex w-72 flex-col bg-surface shadow-xl transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-100 text-sm font-medium text-primary-700">
              {initial}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink">{user.username}</span>
              <span className="text-xs text-muted">{user.role === 'admin' ? '管理员' : '普通用户'}</span>
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-secondary-100 hover:text-ink"
            aria-label="关闭菜单"
            autoFocus
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted">更多</p>
          <div className="space-y-1">
            {P1_NAV.map((item) => navButton(item.label, item.icon, item.key))}
          </div>

          <p className="mb-1 mt-4 px-3 text-[11px] font-medium uppercase tracking-wider text-muted">账号 / 系统</p>
          <div className="space-y-1">
            {accountItems.map((item) => navButton(item.label, item.icon, item.key))}
            <button
              type="button"
              onClick={onLogout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-danger-600 hover:bg-danger-50"
            >
              <Icon name="logout" size={20} className="shrink-0" />
              退出登录
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
