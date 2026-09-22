import type { IconName } from './components/icons.js';

/**
 * 顶级导航 key（侧栏 + 移动底部 Tab 共用）。
 * 页面组件不得自行修改 activeView，一律通过 onNavigate 回调上抛到 App。
 */
export type NavKey =
  | 'dashboard'
  | 'libraries'
  | 'documents'
  | 'search'
  | 'chat'
  | 'usage'
  | 'cockpit'
  | 'profile'
  | 'settings'
  | 'admin';

export interface NavItem {
  key: NavKey;
  label: string;
  icon: IconName;
}

/** P0 工作区（对话为主 CTA） */
export const P0_NAV: NavItem[] = [
  { key: 'chat', label: '智能对话', icon: 'chat' },
  { key: 'dashboard', label: '工作台', icon: 'dashboard' },
  { key: 'libraries', label: '知识库', icon: 'libraries' },
  { key: 'documents', label: '文档', icon: 'documents' },
  { key: 'search', label: '检索', icon: 'search' },
];

/** P1 更多 */
export const P1_NAV: NavItem[] = [
  { key: 'usage', label: '用量', icon: 'usage' },
  { key: 'cockpit', label: '驾驶舱', icon: 'cockpit' },
];

/** P2 账号/系统（侧栏底部；admin 项由调用方按角色过滤） */
export const P2_NAV: NavItem[] = [
  { key: 'profile', label: '个人中心', icon: 'profile' },
  { key: 'settings', label: '设置', icon: 'settings' },
  { key: 'admin', label: '用户管理', icon: 'admin' },
];
