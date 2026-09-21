import type { User } from '@kb/shared';
import { P0_NAV, P1_NAV, P2_NAV, type NavItem, type NavKey } from '../nav.js';
import Icon from './icons.js';

interface SidebarProps {
  activeView: NavKey;
  collapsed: boolean;
  user: User;
  onNavigate: (view: NavKey) => void;
  onToggleCollapse: () => void;
  onLogout: () => void;
}

/** 单个导航项：选中高亮 + 左侧 3px 指示条；折叠态只显图标 */
function NavButton({
  item,
  active,
  collapsed,
  emphasized,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  emphasized: boolean;
  onClick: () => void;
}) {
  const layout = collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2';
  const tone = active
    ? emphasized
      ? 'bg-primary-600 font-medium text-white'
      : 'bg-primary-50 font-medium text-primary-700'
    : emphasized
      ? 'text-primary-600 hover:bg-primary-50'
      : 'text-ink hover:bg-secondary-100';

  return (
    <button
      type="button"
      title={collapsed ? item.label : undefined}
      onClick={onClick}
      className={`relative flex w-full items-center gap-3 rounded-md text-sm transition-colors ${layout} ${tone}`}
    >
      {active ? (
        <span className="absolute -left-2 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary-600" />
      ) : null}
      <Icon name={item.icon} size={20} className="shrink-0" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </button>
  );
}

function SectionLabel({ collapsed, text }: { collapsed: boolean; text: string }) {
  if (collapsed) return <div className="mx-2 my-2 border-t border-line" />;
  return (
    <p className="mb-1 mt-4 px-3 text-[11px] font-medium uppercase tracking-wider text-muted first:mt-0">
      {text}
    </p>
  );
}

/**
 * 左侧导航：P0 工作区（工作台/知识库/文档/检索/对话=主 CTA）+ P1 更多（用量）+ P2 账号区（底部）。
 */
export default function Sidebar({ activeView, collapsed, user, onNavigate, onToggleCollapse, onLogout }: SidebarProps) {
  const accountItems = P2_NAV.filter((item) => item.key !== 'admin' || user.role === 'admin');
  const initial = user.username.slice(0, 1).toUpperCase();

  return (
    <aside
      className={`hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 sm:flex ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <SectionLabel collapsed={collapsed} text="工作区" />
        <div className="space-y-1">
          {P0_NAV.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={activeView === item.key}
              collapsed={collapsed}
              emphasized={item.key === 'chat'}
              onClick={() => onNavigate(item.key)}
            />
          ))}
        </div>

        <SectionLabel collapsed={collapsed} text="更多" />
        <div className="space-y-1">
          {P1_NAV.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={activeView === item.key}
              collapsed={collapsed}
              emphasized={false}
              onClick={() => onNavigate(item.key)}
            />
          ))}
        </div>
      </nav>

      {/* P2 账号/系统区（底部） */}
      <div className="border-t border-line px-2 py-3">
        <button
          type="button"
          onClick={() => onNavigate('profile')}
          className={`flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-secondary-100 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-sm font-medium text-primary-700">
            {initial}
          </span>
          {!collapsed ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{user.username}</span>
              <span className="mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                user.role === 'admin' ? 'bg-accent text-white' : 'bg-secondary-100 text-secondary-600'
              }">
                {user.role === 'admin' ? '管理员' : '用户'}
              </span>
            </span>
          ) : null}
        </button>

        <div className="mt-2 space-y-1">
          {accountItems.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={activeView === item.key}
              collapsed={collapsed}
              emphasized={false}
              onClick={() => onNavigate(item.key)}
            />
          ))}
          <button
            type="button"
            title={collapsed ? '退出登录' : undefined}
            onClick={onLogout}
            className={`flex w-full items-center gap-3 rounded-md py-2 text-sm text-danger-600 hover:bg-danger-50 ${
              collapsed ? 'justify-center px-0' : 'px-3'
            }`}
          >
            <Icon name="logout" size={20} className="shrink-0" />
            {!collapsed ? '退出登录' : null}
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
          className="mt-2 flex w-full items-center gap-3 rounded-md py-2 text-sm text-muted hover:bg-secondary-100 hover:text-ink"
        >
          <span className={`flex flex-1 ${collapsed ? 'justify-center' : 'justify-start px-3'}`}>
            <Icon name={collapsed ? 'collapse-right' : 'collapse-left'} size={18} />
          </span>
        </button>
      </div>
    </aside>
  );
}
