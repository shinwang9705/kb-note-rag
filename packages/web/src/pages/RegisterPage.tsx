import { useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import { PASSWORD_MIN, USERNAME_MIN, type User } from '@kb/shared';

interface RegisterPageProps {
  onAuthed: (payload: { user: User; token: string }) => void;
  onBack: () => void;
}

export default function RegisterPage({ onAuthed, onBack }: RegisterPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await api.register({ username, password, email: email || undefined });
      onAuthed(result);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '注册失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
        <h1 className="mb-1 text-2xl font-semibold">注册</h1>
        <p className="mb-6 text-sm text-slate-500">
          用户名至少 {USERNAME_MIN} 位，密码至少 {PASSWORD_MIN} 位
        </p>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-600" htmlFor="reg-username">
              用户名
            </label>
            <input
              id="reg-username"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-600" htmlFor="reg-email">
              邮箱（选填）
            </label>
            <input
              id="reg-email"
              type="email"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-600" htmlFor="reg-password">
              密码
            </label>
            <input
              id="reg-password"
              type="password"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {error ? <p className="text-sm text-danger-600">{error}</p> : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? '注册中…' : '注册并登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-500">
          已有账号？
          <button type="button" className="ml-1 text-brand-600 hover:underline" onClick={onBack}>
            返回登录
          </button>
        </p>
      </div>
    </div>
  );
}
