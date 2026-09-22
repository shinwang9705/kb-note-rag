import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import { ALLOWED_EXTENSIONS, type DocTag, type Document, type Library } from '@kb/shared';

const ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

interface DocumentsPageProps {
  onOpenDocument?: (docId: number) => void;
}

/** 状态徽标配色（语义色） */
const STATUS_STYLE: Record<Document['status'], string> = {
  pending: 'bg-secondary-100 text-secondary-600',
  processing: 'bg-info-50 text-info-600',
  ready: 'bg-success-100 text-success-700',
  failed: 'bg-danger-100 text-danger-700',
};

const STATUS_LABEL: Record<Document['status'], string> = {
  pending: '等待中',
  processing: '处理中',
  ready: '就绪',
  failed: '失败',
};

/** 字节数格式化为易读单位 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 时间戳转本地短格式 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default function DocumentsPage({ onOpenDocument }: DocumentsPageProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reindexing, setReindexing] = useState(false);

  // 配额
  const [quota, setQuota] = useState<{
    maxDocumentsPerUser: number;
    storageBytes: number;
    storageQuotaBytes: number;
  } | null>(null);

  // 批量上传表单
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadLibraryId, setUploadLibraryId] = useState<number | ''>('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 替换
  const [replacingDocId, setReplacingDocId] = useState<number | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  // 纯文本入库表单
  const [textTitle, setTextTitle] = useState('');
  const [textContent, setTextContent] = useState('');
  const [textLibraryId, setTextLibraryId] = useState<number | ''>('');
  const [submittingText, setSubmittingText] = useState(false);

  // 标签 / 收藏筛选与编辑
  const [tags, setTags] = useState<DocTag[]>([]);
  const [tagFilter, setTagFilter] = useState<number | ''>('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [tagEditorDocId, setTagEditorDocId] = useState<number | null>(null);

  const loadDocuments = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.documents({
        limit: 200,
        tagId: tagFilter === '' ? undefined : tagFilter,
        favorite: favoriteOnly,
      });
      setDocuments(res.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载文档失败');
    } finally {
      setLoading(false);
    }
  }, [tagFilter, favoriteOnly]);

  const loadLibraries = useCallback(async (): Promise<void> => {
    try {
      const res = await api.libraries();
      setLibraries(res.items);
    } catch {
      // 知识库加载失败不阻塞文档列表
    }
  }, []);

  const loadTags = useCallback(async (): Promise<void> => {
    try {
      const res = await api.documentTags();
      setTags(res.items);
    } catch {
      // 标签加载失败不阻塞文档列表
    }
  }, []);

  const loadQuota = useCallback(async (): Promise<void> => {
    try {
      const meta = await api.meta();
      setQuota({
        maxDocumentsPerUser: meta.limits.maxDocumentsPerUser,
        storageBytes: meta.storageBytes,
        storageQuotaBytes: meta.storageQuotaBytes,
      });
    } catch {
      // 配额加载失败不阻塞
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
    void loadLibraries();
    void loadTags();
    void loadQuota();
  }, [loadDocuments, loadLibraries, loadTags, loadQuota]);

  const refresh = async (message: string): Promise<void> => {
    setNotice(message);
    await loadDocuments();
    await loadQuota();
  };

  const handleReindex = async (): Promise<void> => {
    if (reindexing) return;
    setReindexing(true); setError(''); setNotice('');
    try {
      const result = await api.reindex();
      setNotice(typeof result.jobId === 'number' ? `索引重建任务 #${result.jobId} 已进入后台队列，可在驾驶舱查看状态。` : '索引重建完成。');
    } catch (err) { setError(err instanceof ApiClientError ? err.message : '索引重建任务创建失败'); }
    finally { setReindexing(false); }
  };

  const handleUpload = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (uploadFiles.length === 0) {
      setError('请先选择要上传的文件');
      return;
    }
    setError('');
    setNotice('');
    setUploading(true);
    try {
      const result = await api.uploadFiles({
        files: uploadFiles,
        libraryId: uploadLibraryId === '' ? undefined : uploadLibraryId,
      });
      const parts: string[] = [];
      if (result.accepted.length > 0) parts.push(`成功 ${result.accepted.length} 个`);
      if (result.rejected.length > 0) {
        parts.push(`失败 ${result.rejected.length} 个：${result.rejected.map((r) => r.fileName).join('、')}`);
      }
      await refresh(`批量上传完成（${parts.join('；')}）`);
      setUploadFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleTextSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!textTitle.trim() || !textContent.trim()) {
      setError('标题与内容均不能为空');
      return;
    }
    setError('');
    setNotice('');
    setSubmittingText(true);
    try {
      const result = await api.createTextDocument({
        title: textTitle.trim(),
        content: textContent,
        libraryId: textLibraryId === '' ? null : textLibraryId,
      });
      const doc = result.item;
      await refresh(`已录入「${doc?.title ?? result.ingest.title}」（${doc?.chunkCount ?? result.ingest.chunkCount} 个片段）`);
      setTextTitle('');
      setTextContent('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '纯文本入库失败');
    } finally {
      setSubmittingText(false);
    }
  };

  const handleDelete = async (doc: Document): Promise<void> => {
    const confirmed = window.confirm(`确定删除「${doc.title}」吗？其片段、向量与原始文件将一并删除，此操作不可撤销。`);
    if (!confirmed) return;
    setError('');
    setNotice('');
    try {
      await api.deleteDocument(doc.id);
      await refresh(`已删除「${doc.title}」`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '删除失败');
    }
  };

  const toggleFavorite = async (doc: Document): Promise<void> => {
    setError('');
    try {
      await api.setFavorite(doc.id, !doc.isFavorite);
      await loadDocuments();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '收藏操作失败');
    }
  };

  const startReplace = (doc: Document): void => {
    setReplacingDocId(doc.id);
    replaceInputRef.current?.click();
  };

  const handleReplaceSelected = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    const docId = replacingDocId;
    if (!file || docId === null) return;
    setError('');
    setNotice('');
    try {
      const res = await api.replaceDocument(docId, file);
      await refresh(`已替换文档 #${res.docId}（${res.chunkCount} 个片段，状态：${res.status}）`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '替换失败');
    } finally {
      setReplacingDocId(null);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6">
      {/* 配额展示 */}
      {quota ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line bg-secondary-50 px-4 py-2 text-sm text-muted">
          <span>文档 {documents.length}/{quota.maxDocumentsPerUser} · 存储 {formatSize(quota.storageBytes)}/{formatSize(quota.storageQuotaBytes)}</span>
          <button type="button" onClick={() => void handleReindex()} disabled={reindexing} className="rounded-control border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:border-primary-300 hover:text-primary-700 disabled:opacity-50">{reindexing ? '正在提交…' : '后台重建索引'}</button>
        </div>
      ) : null}

      {/* 批量上传 + 纯文本入库 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <h2 className="mb-4 text-lg font-medium">批量上传文件</h2>
          <form onSubmit={(e) => void handleUpload(e)} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted">选择文件（可多选）</label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                onChange={(e) => setUploadFiles(Array.from(e.target.files ?? []))}
                className="block w-full text-sm text-muted file:mr-3 file:rounded-control file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-700 hover:file:bg-primary-100"
              />
              <p className="mt-1 text-xs text-muted">
                支持 {ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(' / ')}，单次最多 10 个
              </p>
              {uploadFiles.length > 0 ? (
                <p className="mt-1 text-xs text-muted">已选 {uploadFiles.length} 个：{uploadFiles.map((f) => f.name).join('、')}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">归属知识库（可选）</label>
              <select
                value={uploadLibraryId}
                onChange={(e) => setUploadLibraryId(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              >
                <option value="">不挂库（默认）</option>
                {libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={uploading || uploadFiles.length === 0}
              className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {uploading ? '上传中…' : '批量上传'}
            </button>
          </form>
        </section>

        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <h2 className="mb-4 text-lg font-medium">粘贴文本入库</h2>
          <form onSubmit={(e) => void handleTextSubmit(e)} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted">标题</label>
              <input
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="例如：会议纪要 2026-09-08"
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">内容</label>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                rows={5}
                placeholder="粘贴要入库的纯文本内容…"
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">归属知识库（可选）</label>
              <select
                value={textLibraryId}
                onChange={(e) => setTextLibraryId(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              >
                <option value="">不挂库（默认）</option>
                {libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={submittingText}
              className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {submittingText ? '入库中…' : '保存文本'}
            </button>
          </form>
        </section>
      </div>

      {/* 隐藏的替换文件输入 */}
      <input
        ref={replaceInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => void handleReplaceSelected(e)}
      />

      {/* 列表 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium">文档列表</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value === '' ? '' : Number(e.target.value))}
              className="rounded-control border border-line px-2 py-1.5 text-sm outline-none focus:border-primary-500"
            >
              <option value="">全部标签</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-sm text-muted">
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(e) => setFavoriteOnly(e.target.checked)}
                className="accent-primary-600"
              />
              仅收藏
            </label>
            <button
              type="button"
              onClick={() => void loadDocuments()}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink hover:bg-secondary-100"
            >
              刷新
            </button>
          </div>
        </div>

        {error ? <p className="mb-3 text-sm text-danger-600">{error}</p> : null}
        {notice ? <p className="mb-3 text-sm text-success-600">{notice}</p> : null}

        {loading ? (
          <p className="text-sm text-muted">加载中…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted">还没有文档，上传一个文件或粘贴一段文本试试。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2 pr-4 font-medium">标题</th>
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 pr-4 font-medium">大小</th>
                  <th className="py-2 pr-4 font-medium">分块</th>
                  <th className="py-2 pr-4 font-medium">入库时间</th>
                  <th className="py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {documents.map((doc) => (
                  <Fragment key={doc.id}>
                    <tr className="text-ink">
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void toggleFavorite(doc)}
                            title={doc.isFavorite ? '取消收藏' : '收藏'}
                            className={`shrink-0 text-base leading-none ${
                              doc.isFavorite ? 'text-warning-500' : 'text-muted hover:text-warning-500'
                            }`}
                          >
                            {doc.isFavorite ? '★' : '☆'}
                          </button>
                          <span className="font-medium">{doc.title}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                          <span>{doc.sourceType === 'upload' ? (doc.fileName ?? '文件') : '文本'} · #{doc.id}</span>
                          {doc.tags.map((tag) => (
                            <span key={tag} className="rounded-pill bg-secondary-100 px-1.5 py-0.5 text-secondary-600">
                              {tag}
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() => setTagEditorDocId(tagEditorDocId === doc.id ? null : doc.id)}
                            className="text-primary-600 hover:underline"
                          >
                            标签
                          </button>
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`inline-block rounded-pill px-2 py-0.5 text-xs ${STATUS_STYLE[doc.status]}`}>
                          {STATUS_LABEL[doc.status]}
                        </span>
                        {doc.errorMessage ? (
                          <div className="mt-1 max-w-[16rem] truncate text-xs text-danger-500" title={doc.errorMessage}>
                            {doc.errorMessage}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-muted">{formatSize(doc.fileSize)}</td>
                      <td className="py-2 pr-4 text-muted">{doc.chunkCount}</td>
                      <td className="py-2 pr-4 text-muted">{formatTime(doc.createdAt)}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenDocument?.(doc.id)}
                            className="rounded-control border border-line px-2.5 py-1 text-xs text-ink hover:bg-secondary-100"
                          >
                            查看
                          </button>
                          <button
                            type="button"
                            onClick={() => startReplace(doc)}
                            disabled={doc.status !== 'ready'}
                            className="rounded-control border border-primary-200 px-2.5 py-1 text-xs text-primary-600 hover:bg-primary-50 disabled:opacity-40"
                          >
                            替换
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(doc)}
                            className="rounded-control border border-danger-200 px-2.5 py-1 text-xs text-danger-600 hover:bg-danger-50"
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                    {tagEditorDocId === doc.id ? (
                      <tr>
                        <td colSpan={6} className="py-2">
                          <TagEditor
                            doc={doc}
                            tags={tags}
                            onReloadTags={() => void loadTags()}
                            onSaved={() => {
                              setTagEditorDocId(null);
                              void loadDocuments();
                            }}
                            onClose={() => setTagEditorDocId(null)}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** 行内标签编辑器：选标签弹层（覆盖式 set）+ 新建标签 */
function TagEditor({
  doc,
  tags,
  onReloadTags,
  onSaved,
  onClose,
}: {
  doc: Document;
  tags: DocTag[];
  onReloadTags: () => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draftIds, setDraftIds] = useState<number[]>(() =>
    tags.filter((tag) => doc.tags.includes(tag.name)).map((tag) => tag.id),
  );
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (id: number): void => {
    setDraftIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addNew = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await api.createDocumentTag(name);
      if (res.item && !draftIds.includes(res.item.id)) {
        setDraftIds((prev) => [...prev, res.item.id]);
      }
      setNewName('');
      onReloadTags();
    } catch {
      /* 创建失败由父级 loadDocuments 的 error 提示 */
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setDocumentTags(doc.id, draftIds);
      onSaved();
    } catch {
      /* 保存失败由父级 loadDocuments 的 error 提示 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-control border border-line bg-secondary-50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? (
          <span className="text-xs text-muted">还没有标签，在下方输入创建。</span>
        ) : (
          tags.map((tag) => {
            const active = draftIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() => toggle(tag.id)}
                className={`rounded-pill px-2 py-0.5 text-xs ${
                  active ? 'bg-primary-600 text-white' : 'bg-secondary-100 text-secondary-600 hover:bg-secondary-200'
                }`}
              >
                {tag.name}
              </button>
            );
          })
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addNew();
            }
          }}
          placeholder="新标签名"
          className="w-40 rounded-control border border-line px-2 py-1 text-sm outline-none focus:border-primary-500"
        />
        <button
          type="button"
          onClick={() => void addNew()}
          disabled={busy || !newName.trim()}
          className="rounded-control border border-line px-2.5 py-1 text-xs text-ink hover:bg-secondary-100 disabled:opacity-50"
        >
          添加
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-control bg-primary-600 px-3 py-1 text-xs text-white hover:bg-primary-700 disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-control border border-line px-3 py-1 text-xs text-ink hover:bg-secondary-100"
        >
          取消
        </button>
      </div>
    </div>
  );
}
