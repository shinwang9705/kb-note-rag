import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { Library } from '@kb/shared';

/** 知识库页：创建 / 列表 / 删除 / 分享（多用户隔离由后端强制保证） */
export default function HomePage() {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [shareTarget, setShareTarget] = useState<Library | null>(null);
  const [shareLink, setShareLink] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareBusy, setShareBusy] = useState(false);

  const loadLibraries = useCallback(async (): Promise<void> => {
    try {
      const res = await api.libraries();
      setLibraries(res.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载知识库失败');
    }
  }, []);

  useEffect(() => {
    void loadLibraries();
  }, [loadLibraries]);

  const createLibrary = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    setError('');
    setNotice('');
    try {
      await api.createLibrary({ name: name.trim(), description: description.trim() || undefined });
      setName('');
      setDescription('');
      setNotice(`已创建知识库「${name.trim()}」`);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '创建失败');
    }
  };

  const deleteLibrary = async (item: Library): Promise<void> => {
    const confirmed = window.confirm(`确定删除知识库「${item.name}」吗？该库下的文档不会被删除，但会失去归属。`);
    if (!confirmed) return;
    setError('');
    setNotice('');
    try {
      await api.deleteLibrary(item.id);
      setNotice(`已删除知识库「${item.name}」`);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '删除失败');
    }
  };

  const openShare = async (item: Library): Promise<void> => {
    setShareTarget(item);
    setShareLink('');
    setShareError('');
    setShareBusy(true);
    try {
      const res = await api.createShare(item.id);
      setShareLink(res.url);
    } catch (err) {
      setShareError(err instanceof ApiClientError ? err.message : '生成分享链接失败');
    } finally {
      setShareBusy(false);
    }
  };

  const revokeShare = async (): Promise<void> => {
    if (!shareTarget) return;
    setShareBusy(true);
    try {
      await api.revokeShare(shareTarget.id);
      setNotice(`已撤销知识库「${shareTarget.name}」的分享`);
      setShareTarget(null);
      setShareLink('');
    } catch (err) {
      setShareError(err instanceof ApiClientError ? err.message : '撤销分享失败');
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareLink = async (): Promise<void> => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setNotice('分享链接已复制到剪贴板');
    } catch {
      setShareError('复制失败，请手动复制');
    }
  };

  return (
    <>
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-medium">我的知识库</h2>

        {error ? <p className="mb-3 text-sm text-danger-600">{error}</p> : null}
        {notice ? <p className="mb-3 text-sm text-success-600">{notice}</p> : null}

        {libraries.length === 0 ? (
          <p className="mb-4 text-sm text-muted">还没有知识库，下面创建一个，用于归类文档。</p>
        ) : (
          <ul className="mb-4 divide-y divide-line">
            {libraries.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <span className="font-medium">{item.name}</span>
                  <span className="ml-2 text-muted">#{item.id}</span>
                  {item.description ? (
                    <span className="ml-2 text-muted">{item.description}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openShare(item)}
                    className="rounded-control border border-primary-200 px-2.5 py-1 text-xs text-primary-600 hover:bg-primary-50"
                  >
                    分享
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteLibrary(item)}
                    className="rounded-control border border-danger-200 px-2.5 py-1 text-xs text-danger-600 hover:bg-danger-50"
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(e) => void createLibrary(e)} className="space-y-2">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              placeholder="知识库名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700"
            >
              新建
            </button>
          </div>
          <input
            className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
            placeholder="描述（可选）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </form>
      </section>

      {shareTarget ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-6">
          <div className="mt-10 w-full max-w-lg rounded-modal border border-line bg-surface p-6 shadow-modal">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">分享知识库「{shareTarget.name}」</h2>
              <button
                type="button"
                onClick={() => {
                  setShareTarget(null);
                  setShareLink('');
                  setShareError('');
                }}
                className="rounded-control border border-line px-2 py-1 text-sm text-muted hover:bg-secondary-100"
              >
                关闭
              </button>
            </div>

            {shareError ? <p className="mb-3 text-sm text-danger-600">{shareError}</p> : null}

            {shareBusy ? (
              <p className="text-sm text-muted">处理中…</p>
            ) : shareLink ? (
              <div className="space-y-3">
                <p className="text-sm text-muted">任何拿到链接的人都可以只读检索该知识库：</p>
                <input
                  readOnly
                  value={shareLink}
                  className="w-full rounded-control border border-line px-3 py-2 text-sm text-ink"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void copyShareLink()}
                    className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700"
                  >
                    复制链接
                  </button>
                  <button
                    type="button"
                    onClick={() => void revokeShare()}
                    className="rounded-control border border-danger-200 px-4 py-2 text-sm text-danger-600 hover:bg-danger-50"
                  >
                    撤销分享
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
