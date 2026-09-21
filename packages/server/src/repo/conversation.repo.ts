/**
 * 会话数据访问层（三期 T02）。
 *
 * 隔离铁律：所有查询强制 WHERE user_id = ?，越权一律表现为「查不到」（undefined / 空列表）。
 * 所有 JSON 列（params_json / kb_scope_json / summary_json）在 repo 层统一序列化/反序列化，
 * 上层只与强类型对象打交道。
 */
import type { DbHandle } from '../db/connection.js';
import type {
  Conversation,
  ConversationMode,
  ConversationSummary,
  GenerationParams,
  KbScope,
} from '@kb/shared';
import { DEFAULT_GENERATION_PARAMS } from '@kb/shared';
import { escapeLike } from '../search/tokenize.js';

export interface ConversationRow {
  id: number;
  user_id: number;
  title: string;
  mode: string;
  provider_id: string;
  model: string;
  params_json: string;
  strategy: string;
  kb_enabled: number;
  kb_scope_json: string | null;
  summary_json: string | null;
  message_count: number;
  token_in: number;
  token_out: number;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
  last_message_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** 安全解析 JSON，失败回退 fallback（不因脏数据炸进程） */
function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 行 -> 强类型会话对象（下划线转驼峰 + JSON 展开 + 默认值合并） */
export function toConversation(row: ConversationRow): Conversation {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    title: row.title || '新对话',
    mode: (row.mode === 'agent' ? 'agent' : 'chat') as ConversationMode,
    providerId: row.provider_id ?? '',
    model: row.model ?? '',
    params: {
      ...DEFAULT_GENERATION_PARAMS,
      ...parseJson<Partial<GenerationParams>>(row.params_json, {}),
    },
    strategy: row.strategy ?? 'sequential',
    kbEnabled: Number(row.kb_enabled) === 1,
    kbScope: parseJson<KbScope | null>(row.kb_scope_json, null),
    summary: parseJson<ConversationSummary | null>(row.summary_json, null),
    messageCount: Number(row.message_count ?? 0),
    tokenIn: Number(row.token_in ?? 0),
    tokenOut: Number(row.token_out ?? 0),
    pinned: Number(row.pinned) === 1,
    archived: Number(row.archived) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

export interface CreateConversationInput {
  title?: string;
  mode?: ConversationMode;
  providerId?: string;
  model?: string;
  params?: GenerationParams;
  kbEnabled?: boolean;
  kbScope?: KbScope | null;
}

export function createConversation(
  db: DbHandle,
  userId: number,
  input: CreateConversationInput,
): Conversation {
  const params = { ...DEFAULT_GENERATION_PARAMS, ...(input.params ?? {}) };
  const row = db.driver.get<Pick<ConversationRow, 'id'>>(
    `INSERT INTO conversations
       (user_id, title, mode, provider_id, model, params_json, kb_enabled, kb_scope_json,
        created_at, updated_at, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW}, ${NOW}) RETURNING id`,
    [
      userId,
      input.title?.trim() || '新对话',
      input.mode ?? 'chat',
      input.providerId ?? '',
      input.model ?? '',
      JSON.stringify(params),
      input.kbEnabled ? 1 : 0,
      input.kbScope ? JSON.stringify(input.kbScope) : null,
    ],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error('创建会话失败：未返回主键');
  return getConversation(db, userId, id) as Conversation;
}

export function getConversation(db: DbHandle, userId: number, id: number): Conversation | undefined {
  const row = db.driver.get<ConversationRow>('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [
    id,
    userId,
  ]);
  return row ? toConversation(row) : undefined;
}

export interface ListConversationsQuery {
  page?: number;
  pageSize?: number;
  /** null = 不筛选 */
  archived?: boolean | null;
  pinned?: boolean | null;
  keyword?: string;
  from?: string;
  to?: string;
}

export function listConversations(
  db: DbHandle,
  userId: number,
  query: ListConversationsQuery = {},
): { items: Conversation[]; total: number } {
  const rawPage = Number(query.page ?? 1);
  const rawPageSize = Number(query.pageSize ?? 20);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.trunc(rawPage)) : 1;
  const pageSize = Number.isFinite(rawPageSize) ? Math.min(Math.max(1, Math.trunc(rawPageSize)), 200) : 20;

  const where: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];
  if (query.archived !== null && query.archived !== undefined) {
    where.push('archived = ?');
    params.push(query.archived ? 1 : 0);
  }
  if (query.pinned !== null && query.pinned !== undefined) {
    where.push('pinned = ?');
    params.push(query.pinned ? 1 : 0);
  }
  if (query.keyword) {
    where.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.keyword)}%`);
  }
  if (query.from) {
    where.push('last_message_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('last_message_at < ?');
    params.push(query.to);
  }

  const cond = where.join(' AND ');
  const total = Number(db.driver.get<{ c: number }>(`SELECT COUNT(*) AS c FROM conversations WHERE ${cond}`, params)?.c ?? 0);
  const rows = db.driver.all<ConversationRow>(
    `SELECT * FROM conversations WHERE ${cond}
     ORDER BY pinned DESC, last_message_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.map(toConversation), total };
}

export interface PatchConversationInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  params?: Partial<GenerationParams>;
  kbScope?: KbScope | null;
  kbEnabled?: boolean;
  providerId?: string;
  model?: string;
}

export function patchConversation(
  db: DbHandle,
  userId: number,
  id: number,
  patch: PatchConversationInput,
): Conversation | undefined {
  const existing = getConversation(db, userId, id);
  if (!existing) return undefined;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title.trim() || '新对话');
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (patch.archived !== undefined) {
    sets.push('archived = ?');
    params.push(patch.archived ? 1 : 0);
  }
  if (patch.kbEnabled !== undefined) {
    sets.push('kb_enabled = ?');
    params.push(patch.kbEnabled ? 1 : 0);
  }
  if (patch.providerId !== undefined) {
    sets.push('provider_id = ?');
    params.push(patch.providerId);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.params !== undefined) {
    sets.push('params_json = ?');
    params.push(JSON.stringify({ ...existing.params, ...patch.params }));
  }
  if (patch.kbScope !== undefined) {
    sets.push('kb_scope_json = ?');
    params.push(patch.kbScope ? JSON.stringify(patch.kbScope) : null);
  }

  if (sets.length === 0) return existing;
  sets.push(`updated_at = ${NOW}`);
  params.push(id, userId);
  db.driver.run(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  return getConversation(db, userId, id);
}

/** 级联删除会话（messages/thinking_runs 由外键 ON DELETE CASCADE 一并清理） */
export function deleteConversation(db: DbHandle, userId: number, id: number): boolean {
  const result = db.driver.run('DELETE FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

/** 累加会话 token 用量（assistant 消息完成后调用） */
export function addConversationUsage(
  db: DbHandle,
  userId: number,
  conversationId: number,
  tokenIn: number,
  tokenOut: number,
): void {
  db.driver.run(
    `UPDATE conversations
       SET token_in = token_in + ?, token_out = token_out + ?, updated_at = ${NOW}
     WHERE id = ? AND user_id = ?`,
    [Math.max(0, Math.trunc(tokenIn)), Math.max(0, Math.trunc(tokenOut)), conversationId, userId],
  );
}

/** 更新滚动摘要（上下文裁剪复用） */
export function updateConversationSummary(
  db: DbHandle,
  userId: number,
  conversationId: number,
  summary: ConversationSummary | null,
): void {
  db.driver.run(
    `UPDATE conversations SET summary_json = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ?`,
    [summary ? JSON.stringify(summary) : null, conversationId, userId],
  );
}
