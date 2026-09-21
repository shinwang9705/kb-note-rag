/**
 * 统一 API 客户端：解包 { code, message, data }，失败抛 ApiClientError。
 */
import {
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
  type AdminUsageStats,
  type AdminUserItem,
  type ApiResponse,
  type AskResult,
  type Chunk,
  type Conversation,
  type DocTag,
  type Document,
  type DocumentStats,
  type GenerationParams,
  type HistoryHit,
  type KbScope,
  type Library,
  type LlmStatus,
  type MessageView,
  type PatchSettingsInput,
  type ProviderInfo,
  type RagStatus,
  type RoundArtifact,
  type SearchHistoryItem,
  type SearchMode,
  type SearchResult,
  type Settings,
  type ShareDoc,
  type StatsTrend,
  type TopItem,
  type ThinkingEvent,
  type ThinkingRun,
  type UsageStats,
  type User,
} from '@kb/shared';

import { readEventStream } from './event-stream.js';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);
}

export function getCachedUser(): User | null {
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setCachedUser(user: User): void {
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  /** 是否带 Authorization（默认 true） */
  auth?: boolean;
  signal?: AbortSignal;
}

/** 解包统一响应信封：非 OK 或 HTTP 错误统一抛 ApiClientError */
async function unwrap<T>(response: Response): Promise<T> {
  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiClientError('BAD_RESPONSE', '服务端返回了非 JSON 内容', response.status);
  }

  if (!response.ok || payload.code !== 'OK') {
    throw new ApiClientError(
      payload.code || `HTTP_${response.status}`,
      payload.message || '请求失败',
      response.status,
      payload.request_id,
    );
  }
  return payload.data as T;
}

/**
 * 发起 JSON 请求并解包统一响应信封。
 * @throws ApiClientError 当 code !== 'OK'
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if ((options.auth ?? true) && token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  return unwrap<T>(response);
}

/**
 * 发起 multipart/form-data 请求（用于文件上传）。
 * 不手动设置 Content-Type，交给浏览器自动补 boundary。
 */
async function requestForm<T>(
  path: string,
  form: FormData,
  options: { signal?: AbortSignal; method?: 'POST' | 'PUT' } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: options.method ?? 'POST',
    headers,
    body: form,
    signal: options.signal,
  });

  return unwrap<T>(response);
}

/** 入库结果（与后端 IngestResult 对应） */
export interface IngestResult {
  documentId: number;
  taskId: number;
  title: string;
  status: string;
  charCount: number;
  chunkCount: number;
  vectorCount: number;
  fileExt: string | null;
  message: string | null;
}

export interface DocumentListQuery {
  libraryId?: number;
  status?: string;
  tagId?: number;
  favorite?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchModeInfo {
  mode: SearchMode;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingAvailable: boolean;
  vecAvailable: boolean;
  vectorReady: boolean;
}

export const api = {
  health: () => request<{ status: string; version: string; vec: boolean }>('/api/health', { auth: false }),
  meta: () =>
    request<{
      appName: string;
      version: string;
      env: string;
      embeddingMode: string;
      searchMode: string;
      embeddingProvider: string;
      embeddingModel: string;
      llmEnabled: boolean;
      llmProvider: string;
      llmModel: string;
      providers: string[];
      needsSetup: boolean;
      conversationEnabled: boolean;
      vecAvailable: boolean;
      allowRegister: boolean;
      storageBytes: number;
      storageQuotaBytes: number;
      limits: {
        maxDocumentsPerUser: number;
        maxUploadMb: number;
        maxFilesPerUpload: number;
      };
    }>('/api/meta'),
  register: (input: { username: string; password: string; email?: string }) =>
    request<{ user: User; token: string; expiresIn: number }>('/api/auth/register', {
      method: 'POST',
      body: input,
      auth: false,
    }),
  login: (input: { username: string; password: string }) =>
    request<{ user: User; token: string; expiresIn: number }>('/api/auth/login', {
      method: 'POST',
      body: input,
      auth: false,
    }),
  logout: () => request<{ revoked: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User; expiresIn: number }>('/api/auth/me'),
  changePassword: (input: { oldPassword: string; newPassword: string }) =>
    request<{ changed: boolean }>('/api/auth/password', { method: 'PATCH', body: input }),

  // ---- 管理员 ----
  adminUsers: (query: { page?: number; pageSize?: number; status?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    const qs = params.toString();
    return request<{ items: AdminUserItem[]; total: number }>(`/api/admin/users${qs ? `?${qs}` : ''}`);
  },
  adminCreateUser: (input: { username: string; password?: string; role?: 'admin' | 'user'; email?: string | null }) =>
    request<{ user: User; initialPassword?: string }>('/api/admin/users', {
      method: 'POST',
      body: input,
    }),
  adminSetStatus: (id: number, status: 'active' | 'disabled') =>
    request<{ user: User }>(`/api/admin/users/${id}/status`, { method: 'PATCH', body: { status } }),
  adminResetPassword: (id: number, password?: string) =>
    request<{ user: User; initialPassword?: string }>(`/api/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: password ? { password } : {},
    }),

  // ---- 知识库 ----
  libraries: () => request<{ items: Library[]; total: number }>('/api/libraries'),
  createLibrary: (input: { name: string; description?: string }) =>
    request<{ item: Library }>('/api/libraries', {
      method: 'POST',
      body: input,
    }),
  deleteLibrary: (id: number) =>
    request<{ id: number; removed: boolean }>(`/api/libraries/${id}`, { method: 'DELETE' }),

  // ---- 文档 ----
  documents: (query: DocumentListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.libraryId) params.set('libraryId', String(query.libraryId));
    if (query.status) params.set('status', query.status);
    if (query.tagId) params.set('tagId', String(query.tagId));
    if (query.favorite) params.set('favorite', 'true');
    if (query.limit) params.set('limit', String(query.limit));
    if (query.offset) params.set('offset', String(query.offset));
    const qs = params.toString();
    return request<{ items: Document[]; total: number }>(`/api/documents${qs ? `?${qs}` : ''}`);
  },
  document: (id: number) => request<{ item: Document }>(`/api/documents/${id}`),
  documentChunks: (id: number) =>
    request<{ items: Chunk[]; total: number }>(`/api/documents/${id}/chunks`),
  documentTags: () => request<{ items: DocTag[] }>('/api/documents/tags'),
  createDocumentTag: (name: string) =>
    request<{ item: DocTag }>('/api/documents/tags', { method: 'POST', body: { name } }),
  deleteDocumentTag: (id: number) =>
    request<{ id: number; removed: boolean }>(`/api/documents/tags/${id}`, { method: 'DELETE' }),
  setDocumentTags: (id: number, tagIds: number[]) =>
    request<{ tags: string[] }>(`/api/documents/${id}/tags`, { method: 'POST', body: { tagIds } }),
  setFavorite: (id: number, isFavorite: boolean) =>
    request<{ item: Document }>(`/api/documents/${id}/favorite`, {
      method: 'PATCH',
      body: { isFavorite },
    }),
  deleteDocument: (id: number) =>
    request<{ id: number; removed: boolean; chunkCount: number }>(`/api/documents/${id}`, {
      method: 'DELETE',
    }),
  uploadFiles: (input: { files: File[]; libraryId?: number }) => {
    const params = new URLSearchParams();
    if (input.libraryId) params.set('libraryId', String(input.libraryId));
    const qs = params.toString();
    const form = new FormData();
    for (const file of input.files) form.append('files', file, file.name);
    return requestForm<{
      accepted: Array<{ docId: number; title: string; status: string }>;
      rejected: Array<{ fileName: string; code: string; message: string }>;
    }>(`/api/documents/upload${qs ? `?${qs}` : ''}`, form);
  },
  replaceDocument: (id: number, file: File, title?: string) => {
    const params = new URLSearchParams();
    if (title) params.set('title', title);
    const qs = params.toString();
    const form = new FormData();
    form.append('file', file, file.name);
    return requestForm<{
      docId: number;
      status: string;
      charCount: number;
      chunkCount: number;
      vectorCount: number;
      fileExt: string | null;
    }>(`/api/documents/${id}/replace${qs ? `?${qs}` : ''}`, form, { method: 'PUT' });
  },
  createTextDocument: (input: { title: string; content: string; libraryId?: number | null }) =>
    request<{ item: Document | null; ingest: IngestResult }>('/api/documents/text', {
      method: 'POST',
      body: {
        title: input.title,
        content: input.content,
        libraryId: input.libraryId ?? null,
      },
    }),

  // ---- 检索 ----
  search: (input: {
    query: string;
    libraryId?: number | null;
    docId?: number | null;
    mode?: 'auto' | SearchMode;
    topK?: number;
    finalK?: number;
  }) =>
    request<SearchResult>('/api/search', {
      method: 'POST',
      body: input,
    }),
  searchMode: () => request<SearchModeInfo>('/api/search/mode'),
  searchHistory: () => request<{ items: SearchHistoryItem[] }>('/api/search/history'),
  clearSearchHistory: () => request<{ cleared: number }>('/api/search/history', { method: 'DELETE' }),
  reindex: (input: { libraryId?: number | null } = {}) =>
    request<{ docs: number; reindexed: number; failed: Array<{ docId: number; error: string }> }>(
      '/api/reindex',
      { method: 'POST', body: input },
    ),

  // ---- 统计 ----
  statsUsage: () =>
    request<UsageStats & { docQuota: number; storageQuotaBytes: number }>('/api/stats/usage'),
  adminStats: () => request<AdminUsageStats>('/api/admin/stats'),
  documentStats: (libraryId?: number) => {
    const params = libraryId ? new URLSearchParams({ libraryId: String(libraryId) }) : null;
    return request<DocumentStats>(`/api/documents/stats${params ? `?${params.toString()}` : ''}`);
  },
  statsTrend: (days = 30) => {
    const params = new URLSearchParams({ days: String(days) });
    return request<StatsTrend>(`/api/stats/trend?${params.toString()}`);
  },
  statsTop: (kind: 'query' | 'doc' = 'query') =>
    request<{ items: TopItem[] }>(`/api/stats/top?kind=${kind}`),

  // ---- 问答（RAG） ----
  chat: (input: { query: string; libraryId?: number | null; docId?: number | null; topK?: number }, signal?: AbortSignal) =>
    request<AskResult>('/api/chat', {
      method: 'POST',
      signal,
      body: input,
    }),
  /**
   * SSE 流式问答：读 response.body 逐帧解析，delta 累计、done 收尾、error 终止。
   * 不用 EventSource（它只支持 GET），这里用 fetch 读流。
   */
  chatStream: async (
    input: { query: string; libraryId?: number | null; docId?: number | null; topK?: number },
    handlers: {
      onDelta: (content: string) => void;
      onDone: (result: AskResult) => void;
      onError: (code: string, message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(input),
    });

    if (!response.ok || !response.body) {
      handlers.onError(`HTTP_${response.status}`, '流式问答请求失败');
      return;
    }

    for await (const event of readEventStream(response.body)) {
      const msg = event as { type: string; content?: string; code?: string; message?: string };
      if (msg.type === 'delta' && typeof msg.content === 'string') handlers.onDelta(msg.content);
      else if (msg.type === 'done') handlers.onDone(msg as unknown as AskResult);
      else if (msg.type === 'error') handlers.onError(msg.code ?? 'STREAM_ERROR', msg.message ?? '流式问答出错');
      }

  },
  chatStatus: () => request<LlmStatus>('/api/chat/status'),

  // ---- 多轮对话 ----
  conversations: (
    query: {
      page?: number;
      pageSize?: number;
      archived?: boolean;
      pinned?: boolean;
      keyword?: string;
      from?: string;
      to?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.archived !== undefined) params.set('archived', String(query.archived));
    if (query.pinned !== undefined) params.set('pinned', String(query.pinned));
    if (query.keyword) params.set('keyword', query.keyword);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    const qs = params.toString();
    return request<{ items: Conversation[]; total: number }>(`/api/conversations${qs ? `?${qs}` : ''}`);
  },
  createConversation: (input: {
    title?: string;
    mode?: 'chat' | 'agent';
    providerId?: string;
    model?: string;
    params?: Partial<GenerationParams>;
    kbEnabled?: boolean;
    kbScope?: KbScope | null;
  }) => request<{ item: Conversation }>('/api/conversations', { method: 'POST', body: input }),
  conversation: (id: number) => request<{ item: Conversation }>(`/api/conversations/${id}`),
  patchConversation: (
    id: number,
    patch: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      params?: Partial<GenerationParams>;
      kbScope?: KbScope | null;
      kbEnabled?: boolean;
      providerId?: string;
      model?: string;
    },
  ) => request<{ item: Conversation }>(`/api/conversations/${id}`, { method: 'PATCH', body: patch }),
  deleteConversation: (id: number) =>
    request<{ id: number; removed: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  conversationMessages: (id: number, query: { limit?: number; beforeSeq?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.limit) params.set('limit', String(query.limit));
    if (query.beforeSeq) params.set('beforeSeq', String(query.beforeSeq));
    const qs = params.toString();
    return request<{ items: MessageView[]; total: number }>(
      `/api/conversations/${id}/messages${qs ? `?${qs}` : ''}`,
    );
  },
  abortConversation: (id: number) =>
    request<{ aborted: boolean }>(`/api/conversations/${id}/abort`, { method: 'POST' }),
  /**
   * SSE 流式多轮消息：读 response.body 逐帧解析 start/content_delta/context_trimmed/done/error。
   * 不用 EventSource（只支持 GET），这里用 fetch 读流。
   */
  sendMessage: async (
    conversationId: number,
    input: { content: string; mode?: 'chat' | 'agent' },
    handlers: {
      onStart?: (payload: {
        conversation: Conversation;
        userMessage: MessageView;
        assistantMessageId: number;
      }) => void;
      onDelta: (content: string) => void;
      onTrimmed?: (droppedCount: number) => void;
      onDone: (message: MessageView) => void;
      onError: (code: string, message: string) => void;
      /** 深度思考（agent）事件：round_* / run_* / synthesis_* / final_delta / budget_warning */
      onThinkingEvent?: (event: ThinkingEvent) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify(input),
    });

    if (!response.ok || !response.body) {
      handlers.onError(`HTTP_${response.status}`, '发送失败');
      return;
    }

    for await (const event of readEventStream(response.body)) {
      const msg = event as {
          type: string;
          conversation?: Conversation;
          userMessage?: MessageView;
          assistantMessageId?: number;
          text?: string;
          droppedCount?: number;
          message?: MessageView | string;
          code?: string;
        };
      if (msg.type === 'start') {
        handlers.onStart?.({
          conversation: msg.conversation as Conversation,
          userMessage: msg.userMessage as MessageView,
          assistantMessageId: msg.assistantMessageId as number,
        });
      } else if (msg.type === 'content_delta' && typeof msg.text === 'string') {
        handlers.onDelta(msg.text);
      } else if (msg.type === 'context_trimmed') {
        handlers.onTrimmed?.(msg.droppedCount ?? 0);
      } else if (msg.type === 'done' && typeof msg.message !== 'string' && msg.message) {
        handlers.onDone(msg.message);
      } else if (msg.type === 'error') {
        handlers.onError(typeof msg.code === 'string' ? msg.code : 'STREAM_ERROR', typeof msg.message === 'string' ? msg.message : '生成出错');
      } else if (
        msg.type === 'run_started' ||
        msg.type === 'round_started' ||
        msg.type === 'round_reasoning_delta' ||
        msg.type === 'round_delta' ||
        msg.type === 'round_done' ||
        msg.type === 'round_failed' ||
        msg.type === 'synthesis_started' ||
        msg.type === 'final_delta' ||
        msg.type === 'budget_warning' ||
        msg.type === 'run_completed' ||
        msg.type === 'run_aborted'
      ) {
        handlers.onThinkingEvent?.(msg as unknown as ThinkingEvent);
      }
      }

  },
  thinkingRun: (id: number) =>
    request<{ run: ThinkingRun; rounds: RoundArtifact[] }>(`/api/thinking/runs/${id}`),
  resumeThinkingRun: async (
    id: number,
    handlers: {
      onThinkingEvent: (event: ThinkingEvent) => void;
      onError: (code: string, message: string) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`/api/thinking/runs/${id}/resume`, { method: 'POST', headers, signal });

    if (!response.ok || !response.body) {
      handlers.onError(`HTTP_${response.status}`, '续跑请求失败');
      return;
    }

    for await (const event of readEventStream(response.body)) {
      const msg = event as { type: string; code?: string; message?: string };
      if (msg.type === 'error') {
        handlers.onError(typeof msg.code === 'string' ? msg.code : 'RESUME_ERROR', typeof msg.message === 'string' ? msg.message : '续跑失败');
      } else {
        handlers.onThinkingEvent(msg as unknown as ThinkingEvent);
      }
      }

  },

  // ---- 共享（只读公开；share 系列不带 Authorization） ----
  createShare: (libraryId: number) =>
    request<{ token: string; url: string }>(`/api/libraries/${libraryId}/share`, { method: 'POST' }),
  revokeShare: (libraryId: number) =>
    request<{ id: number; revoked: boolean }>(`/api/libraries/${libraryId}/share`, { method: 'DELETE' }),
  shareMeta: (token: string) =>
    request<{ library: { name: string; description: string; docCount: number } }>(
      `/api/share/${encodeURIComponent(token)}`,
      { auth: false },
    ),
  shareDocuments: (token: string) =>
    request<{ items: ShareDoc[]; total: number }>(`/api/share/${encodeURIComponent(token)}/documents`, {
      auth: false,
    }),
  shareSearch: (token: string, input: { query: string; topK?: number; finalK?: number }) =>
    request<SearchResult>(`/api/share/${encodeURIComponent(token)}/search`, {
      method: 'POST',
      body: input,
      auth: false,
    }),

  // ---- 供应商 / 设置 / 历史 ----
  providers: () => request<{ items: ProviderInfo[] }>('/api/providers'),
  saveProviderCredentials: (id: string, input: { apiKey: string; baseUrlOverride?: string }) =>
    request<{ configured: boolean }>(`/api/providers/${id}/credentials`, { method: 'PUT', body: input }),
  deleteProviderCredentials: (id: string) =>
    request<{ configured: boolean }>(`/api/providers/${id}/credentials`, { method: 'DELETE' }),
  testProvider: (id: string, input: { apiKey?: string; baseUrlOverride?: string } = {}) =>
    request<{ ok: boolean; error?: { kind: string; userMessage: string; retryable: boolean } }>(
      `/api/providers/${id}/test`,
      { method: 'POST', body: input },
    ),
  settings: () => request<Settings>('/api/settings'),
  patchSettings: (patch: PatchSettingsInput) =>
    request<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: patch }),
  ragStatus: () => request<RagStatus>('/api/rag/status'),
  historySearch: (input: { keyword: string; from?: string; to?: string; limit?: number; offset?: number }) =>
    request<{ items: HistoryHit[]; total: number }>('/api/history/search', { method: 'POST', body: input }),
};

/** 触发浏览器下载（导出文件用） */
async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 导出单个会话（md/json/txt），触发浏览器下载 */
export async function exportConversation(id: number, format: 'md' | 'json' | 'txt'): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api/conversations/${id}/export?format=${format}`, { headers });
  if (!response.ok) throw new ApiClientError(`HTTP_${response.status}`, '导出失败', response.status);
  await downloadResponse(response, `conversation-${id}.${format}`);
}

/** 批量导出（md/json/txt），触发浏览器下载 */
export async function exportHistoryBatch(conversationIds: number[], format: 'md' | 'json' | 'txt'): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('/api/history/export', {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationIds, format }),
  });
  if (!response.ok) throw new ApiClientError(`HTTP_${response.status}`, '导出失败', response.status);
  await downloadResponse(response, `export.${format}`);
}
