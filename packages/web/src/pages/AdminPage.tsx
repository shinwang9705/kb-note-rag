import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { AdminUserItem } from '@kb/shared';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', user: '普通用户' };
const STATUS_LABEL: Record<string, string> = { active: '正常', disabled: '已禁用' };
const STATUS_STYLE: Record<string, string> = {
  active: 'bg-success-100 text-success-700',
  disabled: 'bg-danger-100 text-danger-700',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 管理员用户管理页（仅 admin 可见）。
 */
export default function AdminPage() {
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 过滤
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  // 新建用户
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [newEmail, setNewEmail] = useState('');
  const [creating, setCreating] = useState(false);

  // 一次性密码展示
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);

  const loadUsers = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.adminUsers({ page: 1, pageSize: 200, status: status || undefined, q: q || undefined });
      setUsers(res.items);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载用户失败');
    } finally {
      setLoading(false);
    }
  }, [q, status]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!newUsername.trim()) {
      setError('请输入用户名');
      return;
    }
    setError('');
    setNotice('');
    setCreating(true);
    try {
      const res = await api.adminCreateUser({
        username: newUsername.trim(),
        password: newPassword || undefined,
        role: newRole,
        email: newEmail.trim() || null,
      });
      setNewUsername('');
      setNewPassword('');
      setNewEmail('');
      if (res.initialPassword) {
        setOneTimePassword(res.initialPassword);
        setNotice(`已创建用户「${res.user.username}」，请复制下方一次性密码并妥善保管`);
      } else {
        setNotice(`已创建用户「${res.user.username}」`);
      }
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '创建用户失败');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleStatus = async (user: AdminUserItem): Promise<void> => {
    setError('');
    setNotice('');
    const next = user.status === 'active' ? 'disabled' : 'active';
    try {
      await api.adminSetStatus(user.id, next);
      await loadUsers();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '操作失败');
    }
  };

  const handleResetPassword = async (user: AdminUserItem): Promise<void> => {
    setError('');
    setNotice('');
    try {
      const res = await api.adminResetPassword(user.id);
      if (res.initialPassword) {
        setOneTimePassword(res.initialPassword);
        setNotice(`已重置「${user.username}」的密码，请复制下方一次性密码并妥善保管`);
      } else {
        setNotice(`已重置「${user.username}」的密码`);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '重置密码失败');
    }
  };

  return (
    <div className="space-y-6">
      {/* 新建用户 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">新建用户</h2>
        <form onSubmit={(e) => void handleCreate(e)} className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-muted">用户名</label>
            <input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="3-32 位字母/数字/下划线/连字符"
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">初始密码（留空自动生成）</label>
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="留空则生成一次性随机密码"
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">角色</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'user')}
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            >
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">邮箱（可选）</label>
            <input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            />
          </div>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={creating || !newUsername.trim()}
              className="rounded-control bg-primary-600 px-5 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {creating ? '创建中…' : '创建用户'}
            </button>
          </div>
        </form>
      </section>

      {/* 用户列表 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">用户列表（共 {total} 人）</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadUsers();
              }}
              placeholder="按用户名/邮箱搜索"
              className="rounded-control border border-line px-3 py-1.5 text-sm outline-none focus:border-primary-500"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500"
            >
              <option value="">全部状态</option>
              <option value="active">正常</option>
              <option value="disabled">已禁用</option>
            </select>
            <button
              type="button"
              onClick={() => void loadUsers()}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-secondary-100"
            >
              刷新
            </button>
          </div>
        </div>

        {error ? <p className="mb-3 text-sm text-danger-600">{error}</p> : null}
        {notice ? <p className="mb-3 text-sm text-success-600">{notice}</p> : null}
        {oneTimePassword ? (
          <div className="mb-4 rounded-control border border-warning-200 bg-warning-50 px-4 py-3">
            <p className="mb-1 text-sm text-warning-700">一次性初始密码（仅本次显示，请立即复制）：</p>
            <div className="flex items-center gap-2">
              <code className="rounded-control bg-secondary-100 px-2 py-1 text-sm text-ink">{oneTimePassword}</code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(oneTimePassword);
                }}
                className="rounded-control border border-warning-300 px-2 py-1 text-xs text-warning-700 hover:bg-warning-100"
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => setOneTimePassword(null)}
                className="rounded-control border border-line px-2 py-1 text-xs text-ink hover:bg-secondary-100"
              >
                关闭
              </button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted">加载中…</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted">没有符合条件的用户。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2 pr-4 font-medium">用户名</th>
                  <th className="py-2 pr-4 font-medium">邮箱</th>
                  <th className="py-2 pr-4 font-medium">角色</th>
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 pr-4 font-medium">文档数</th>
                  <th className="py-2 pr-4 font-medium">注册时间</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((user) => (
                  <tr key={user.id} className="text-ink">
                    <td className="py-2 pr-4 font-medium">{user.username}</td>
                    <td className="py-2 pr-4 text-muted">{user.email ?? '—'}</td>
                    <td className="py-2 pr-4">{ROLE_LABEL[user.role] ?? user.role}</td>
                    <td className="py-2 pr-4">
                      <span className={`inline-block rounded-pill px-2 py-0.5 text-xs ${STATUS_STYLE[user.status]}`}>
                        {STATUS_LABEL[user.status] ?? user.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-muted">{user.docCount}</td>
                    <td className="py-2 pr-4 text-muted">{formatTime(user.createdAt)}</td>
                    <td className="py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleToggleStatus(user)}
                          className={`rounded-control border px-2.5 py-1 text-xs ${
                            user.status === 'active'
                              ? 'border-danger-200 text-danger-600 hover:bg-danger-50'
                              : 'border-line text-ink hover:bg-secondary-100'
                          }`}
                        >
                          {user.status === 'active' ? '禁用' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleResetPassword(user)}
                          className="rounded-control border border-primary-200 px-2.5 py-1 text-xs text-primary-600 hover:bg-primary-50"
                        >
                          重置密码
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
