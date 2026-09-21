import type { User } from '@kb/shared';
import type { NavKey } from '../nav.js';
import Icon from './icons.js';

interface UserMenuProps {
  user: User;
  open: boolean;
  onNavigate: (view: NavKey) => void;
  onLogout: () => void;
  onClose: () => void;
}

/**
 * 头像下拉菜单：个人中心 / 设置 / 用户管理(仅 admin) / 退出登录。
 * 点击外部遮罩关闭。
 */
export default function UserMenu({ user, open, onNavigate, onLogout, onClose }: UserMenuProps) {
  if (!open) return null;

  const items: Array<{ key: NavKey; label: string; icon: 'profile' | 'settings' | 'admin' }> = [
    { key: 'profile', label: '个人中心', icon: 'profile' },
    { key: 'settings', label: '设置', icon: 'settings' },
    ...(user.role === 'admin' ? [{ key: 'admin' as NavKey, label: '用户管理', icon: 'admin' as const }] : []),
  ];

  return (
    <>
      {/* 点击外部关闭的透明遮罩 */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div className="absolute right-0 top-full z-50 mt-2 w-52 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg">
        <div className="border-b border-line px-4 py-2.5">
          <p className="truncate text-sm font-medium text-ink">{user.username}</p>
          <p className="mt-0.5 text-xs text-muted">{user.role === 'admin' ? '管理员' : '普通用户'}</p>
        </div>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              onNavigate(item.key);
              onClose();
            }}
            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-ink hover:bg-secondary-100"
          >
            <span className="text-muted">
              <Icon name={item.icon} size={18} />
            </span>
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            onLogout();
            onClose();
          }}
          className="flex w-full items-center gap-3 border-t border-line px-4 py-2 text-left text-sm text-danger-600 hover:bg-danger-50"
        >
          <span className="text-danger-500">
            <Icon name="logout" size={18} />
          </span>
          退出登录
        </button>
      </div>
    </>
  );
}
