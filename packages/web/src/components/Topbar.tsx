import type { User } from '@kb/shared';
import type { NavKey } from '../nav.js';
import GlobalSearchBox from './GlobalSearchBox.js';
import Icon from './icons.js';
import ModeBanner, { type ModeInfo } from './ModeBanner.js';
import UserMenu from './UserMenu.js';

interface TopbarProps {
  user: User;
  searchMode: ModeInfo | null;
  onSearch: (keyword: string) => void;
  onNavigate: (view: NavKey) => void;
  onOpenCockpit: () => void;
  onLogout: () => void;
  onToggleDrawer: () => void;
  userMenuOpen: boolean;
  onToggleUserMenu: () => void;
  onCloseUserMenu: () => void;
}

/**
 * 顶栏：Logo + 全局检索框 + 检索模式紧凑态 + 驾驶舱入口 + 用户头像（触发 UserMenu）+ 移动端汉堡按钮。
 */
export default function Topbar({
  user,
  searchMode,
  onSearch,
  onNavigate,
  onOpenCockpit,
  onLogout,
  onToggleDrawer,
  userMenuOpen,
  onToggleUserMenu,
  onCloseUserMenu,
}: TopbarProps) {
  const initial = user.username.slice(0, 1).toUpperCase();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-4">
      {/* 移动端汉堡按钮 */}
      <button
        type="button"
        onClick={onToggleDrawer}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-secondary-100 hover:text-ink sm:hidden"
        aria-label="打开菜单"
      >
        <Icon name="menu" size={20} />
      </button>

      {/* Logo（点击回工作台） */}
      <button
        type="button"
        onClick={() => onNavigate('dashboard')}
        className="flex shrink-0 items-center gap-2"
        aria-label="kb-note 首页"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-sm font-bold text-white">
          K
        </span>
        <span className="hidden text-lg font-semibold text-ink md:block">kb-note</span>
      </button>

      {/* 全局检索 */}
      <GlobalSearchBox onSearch={onSearch} />

      {/* 检索模式紧凑态（桌面起显示） */}
      <div className="hidden shrink-0 md:block">
        <ModeBanner info={searchMode} compact />
      </div>

      {/* 驾驶舱入口（可选 P2 增强：顶栏一键进入大屏） */}
      <button
        type="button"
        onClick={onOpenCockpit}
        title="打开数据驾驶舱"
        aria-label="打开数据驾驶舱"
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-secondary-100 hover:text-ink sm:flex"
      >
        <Icon name="cockpit" size={20} />
      </button>

      {/* 用户头像 + 下拉菜单 */}
      <div className="relative ml-auto shrink-0">
        <button
          type="button"
          onClick={onToggleUserMenu}
          className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium transition-colors ${
            userMenuOpen ? 'bg-primary-100 text-primary-700' : 'bg-secondary-100 text-secondary-700 hover:bg-secondary-200'
          }`}
          aria-label="用户菜单"
        >
          {initial}
        </button>
        <UserMenu
          user={user}
          open={userMenuOpen}
          onNavigate={onNavigate}
          onLogout={onLogout}
          onClose={onCloseUserMenu}
        />
      </div>
    </header>
  );
}
