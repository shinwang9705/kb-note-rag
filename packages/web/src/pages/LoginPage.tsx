import { useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { User } from '@kb/shared';

interface LoginPageProps {
  onAuthed: (payload: { user: User; token: string }) => void;
  onGoRegister: () => void;
}

export default function LoginPage({ onAuthed, onGoRegister }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.login({ username, password });
      onAuthed(result);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
        <h1 className="mb-1 text-2xl font-semibold">kb-note</h1>
        <p className="mb-6 text-sm text-slate-500">登录后使用你的知识库</p>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-600" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-600" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error ? <p className="text-sm text-danger-600">{error}</p> : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          还没有账号？
          <button type="button" className="ml-1 text-brand-600 hover:underline" onClick={onGoRegister}>
            立即注册
          </button>
        </p>
      </div>
    </div>
  );
}
