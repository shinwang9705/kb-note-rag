import { useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { User } from '@kb/shared';

interface ProfilePageProps {
  user: User;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 个人中心：展示资料 + 修改密码（校验原密码）。
 */
export default function ProfilePage({ user }: ProfilePageProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!oldPassword || !newPassword) {
      setError('请填写原密码与新密码');
      return;
    }
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await api.changePassword({ oldPassword, newPassword });
      setNotice('密码修改成功');
      setOldPassword('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '修改密码失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">个人资料</h2>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">用户名</dt>
            <dd className="mt-1 text-ink">{user.username}</dd>
          </div>
          <div>
            <dt className="text-muted">角色</dt>
            <dd className="mt-1 text-ink">{user.role === 'admin' ? '管理员' : '普通用户'}</dd>
          </div>
          <div>
            <dt className="text-muted">邮箱</dt>
            <dd className="mt-1 text-ink">{user.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">注册时间</dt>
            <dd className="mt-1 text-ink">{formatTime(user.createdAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">修改密码</h2>
        <form onSubmit={(e) => void submit(e)} className="max-w-md space-y-3">
          <div>
            <label className="mb-1 block text-sm text-muted">原密码</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              disabled={submitting}
              autoComplete="current-password"
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500 disabled:bg-secondary-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted">新密码（至少 8 位）</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              autoComplete="new-password"
              className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500 disabled:bg-secondary-50"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !oldPassword || !newPassword}
            className="rounded-control bg-primary-600 px-5 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {submitting ? '提交中…' : '修改密码'}
          </button>
        </form>
        {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-success-600">{notice}</p> : null}
      </section>
    </div>
  );
}
