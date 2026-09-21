import type { ReactNode } from 'react';
import { useState } from 'react';
import type { User } from '@kb/shared';
import type { NavKey } from '../nav.js';
import BottomTab from './BottomTab.js';
import MobileDrawer from './MobileDrawer.js';
import type { ModeInfo } from './ModeBanner.js';
import Sidebar from './Sidebar.js';
import Topbar from './Topbar.js';

interface AppShellProps {
  user: User;
  activeView: NavKey;
  llmEnabled: boolean | null;
  searchMode: ModeInfo | null;
  onNavigate: (view: NavKey) => void;
  onSearch: (keyword: string) => void;
  onOpenCockpit: () => void;
  onLogout: () => void;
  children: ReactNode;
}

/**
 * 登录后的应用外壳：Topbar + Sidebar + 内容区 + BottomTab（移动）+ MobileDrawer（移动）。
 * 持有侧栏 rail 折叠 / 抽屉开合 / 头像菜单开合状态。
 */
export default function AppShell({
  user,
  activeView,
  llmEnabled,
  searchMode,
  onNavigate,
  onSearch,
  onOpenCockpit,
  onLogout,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // 导航时关闭抽屉与头像菜单
  const navigate = (view: NavKey): void => {
    setDrawerOpen(false);
    setUserMenuOpen(false);
    onNavigate(view);
  };

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-bg text-ink">
      <Sidebar
        activeView={activeView}
        collapsed={collapsed}
        user={user}
        onNavigate={navigate}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onLogout={onLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          searchMode={searchMode}
          onSearch={onSearch}
          onNavigate={navigate}
          onOpenCockpit={onOpenCockpit}
          onLogout={onLogout}
          onToggleDrawer={() => setDrawerOpen(true)}
          userMenuOpen={userMenuOpen}
          onToggleUserMenu={() => setUserMenuOpen((v) => !v)}
          onCloseUserMenu={() => setUserMenuOpen(false)}
        />

        <main className="min-h-0 flex-1 overflow-y-auto p-4 pb-20 sm:p-6 sm:pb-6 lg:p-8">
          <div className="mx-auto w-full md:max-w-[1200px] lg:max-w-[1440px]">{children}</div>
        </main>
      </div>

      <BottomTab activeView={activeView} onNavigate={navigate} />
      <MobileDrawer
        activeView={activeView}
        user={user}
        open={drawerOpen}
        onNavigate={navigate}
        onClose={() => setDrawerOpen(false)}
        onLogout={onLogout}
      />
    </div>
  );
}
