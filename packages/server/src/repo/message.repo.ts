/**
 * 消息数据访问层（三期 T02）。
 *
 * 隔离铁律：所有查询强制 WHERE user_id = ?。
 * seq 分配在 append 事务内完成（MAX(seq)+1），保证同一会话内单调递增且并发安全。
 * 写消息同时维护 conversations 的 message_count / last_message_at。
 */
import type { DbHandle } from '../db/connection.js';
import type { MessageCitation, MessageRole, MessageStatus, MessageView } from '@kb/shared';

export interface MessageRow {
  id: number;
  user_id: number;
  conversation_id: number;
  seq: number;
  role: string;
  content: string;
  reasoning: string | null;
  parent_id: number | null;
  branch_index: number;
  status: string;
  thinking_run_id: number | null;
  citations_json: string | null;
  model: string | null;
  provider_id: string | null;
  token_in: number;
  token_out: number;
  latency_ms: number;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 行 -> 强类型消息对象 */
export function toMessageView(row: MessageRow): MessageView {
  const error = parseJson<{ code?: string; message?: string } | null>(row.error_json, null);
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    seq: Number(row.seq),
    role: row.role as MessageRole,
    content: row.content ?? '',
    reasoning: row.reasoning ?? null,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    branchIndex: Number(row.branch_index ?? 0),
    status: row.status as MessageStatus,
    thinkingRunId: row.thinking_run_id == null ? null : Number(row.thinking_run_id),
    citations: parseJson<MessageCitation[]>(row.citations_json, []),
    model: row.model ?? null,
    providerId: row.provider_id ?? null,
    tokenIn: Number(row.token_in ?? 0),
    tokenOut: Number(row.token_out ?? 0),
    latencyMs: Number(row.latency_ms ?? 0),
    error: error?.message ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
  };
}

export interface AppendMessageInput {
  conversationId: number;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  reasoning?: string | null;
  parentId?: number | null;
  branchIndex?: number;
  thinkingRunId?: number | null;
  citations?: MessageCitation[];
  model?: string | null;
  providerId?: string | null;
}

/**
 * 追加一条消息并在事务内分配 seq，同时维护会话计数与时间戳。
 * @returns 新写入的消息（含分配的 seq）
 */
export function appendMessage(db: DbHandle, userId: number, input: AppendMessageInput): MessageView {
  return db.driver.transaction(() => {
    const seqRow = db.driver.get<{ m: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS m FROM messages WHERE conversation_id = ? AND user_id = ?',
      [input.conversationId, userId],
    );
    const seq = Number(seqRow?.m ?? 1);

    const row = db.driver.get<Pick<MessageRow, 'id'>>(
      `INSERT INTO messages
         (user_id, conversation_id, seq, role, content, reasoning, parent_id, branch_index,
          status, thinking_run_id, citations_json, model, provider_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}) RETURNING id`,
      [
        userId,
        input.conversationId,
        seq,
        input.role,
        input.content,
        input.reasoning ?? null,
        input.parentId ?? null,
        input.branchIndex ?? 0,
        input.status ?? 'done',
        input.thinkingRunId ?? null,
        input.citations && input.citations.length > 0 ? JSON.stringify(input.citations) : null,
        input.model ?? null,
        input.providerId ?? null,
      ],
    );
    const id = Number(row?.id ?? 0);
    if (!id) throw new Error('写入消息失败：未返回主键');

    db.driver.run(
      `UPDATE conversations
         SET message_count = message_count + 1, updated_at = ${NOW}, last_message_at = ${NOW}
       WHERE id = ? AND user_id = ?`,
      [input.conversationId, userId],
    );

    return getMessage(db, userId, id) as MessageView;
  });
}

export function getMessage(db: DbHandle, userId: number, id: number): MessageView | undefined {
  const row = db.driver.get<MessageRow>('SELECT * FROM messages WHERE id = ? AND user_id = ?', [id, userId]);
  return row ? toMessageView(row) : undefined;
}

export interface UpdateMessageInput {
  content?: string;
  status?: MessageStatus;
  reasoning?: string | null;
  citations?: MessageCitation[];
  model?: string | null;
  providerId?: string | null;
  tokenIn?: number;
  tokenOut?: number;
  latencyMs?: number;
  error?: { code: string; message: string } | null;
  completedAt?: string | null;
  thinkingRunId?: number | null;
}

/** 更新消息（强制 user_id + conversation_id，越权返回 undefined） */
export function updateMessage(
  db: DbHandle,
  userId: number,
  conversationId: number,
  messageId: number,
  patch: UpdateMessageInput,
): MessageView | undefined {
  const existing = getMessage(db, userId, messageId);
  if (!existing || existing.conversationId !== conversationId) return undefined;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.content !== undefined) {
    sets.push('content = ?');
    params.push(patch.content);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.reasoning !== undefined) {
    sets.push('reasoning = ?');
    params.push(patch.reasoning);
  }
  if (patch.citations !== undefined) {
    sets.push('citations_json = ?');
    params.push(patch.citations.length > 0 ? JSON.stringify(patch.citations) : null);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.providerId !== undefined) {
    sets.push('provider_id = ?');
    params.push(patch.providerId);
  }
  if (patch.tokenIn !== undefined) {
    sets.push('token_in = ?');
    params.push(Math.max(0, Math.trunc(patch.tokenIn)));
  }
  if (patch.tokenOut !== undefined) {
    sets.push('token_out = ?');
    params.push(Math.max(0, Math.trunc(patch.tokenOut)));
  }
  if (patch.latencyMs !== undefined) {
    sets.push('latency_ms = ?');
    params.push(Math.max(0, Math.trunc(patch.latencyMs)));
  }
  if (patch.error !== undefined) {
    sets.push('error_json = ?');
    params.push(patch.error ? JSON.stringify(patch.error) : null);
  }
  if (patch.completedAt !== undefined) {
    sets.push('completed_at = ?');
    params.push(patch.completedAt);
  }
  if (patch.thinkingRunId !== undefined) {
    sets.push('thinking_run_id = ?');
    params.push(patch.thinkingRunId);
  }

  if (sets.length === 0) return existing;
  params.push(messageId, userId);
  db.driver.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, params);
  return getMessage(db, userId, messageId);
}

export interface ListMessagesOptions {
  limit?: number;
  /** 仅返回 seq < beforeSeq 的消息（排除当前轮及之后） */
  beforeSeq?: number;
}

/** 按 seq 升序列出会话消息（强制 user_id） */
export function listMessages(
  db: DbHandle,
  userId: number,
  conversationId: number,
  options: ListMessagesOptions = {},
): MessageView[] {
  const rawLimit = Number(options.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), 500) : 100;
  const where: string[] = ['conversation_id = ?', 'user_id = ?'];
  const params: (string | number)[] = [conversationId, userId];
  const beforeSeq = Number(options.beforeSeq);
  if (options.beforeSeq !== undefined && Number.isFinite(beforeSeq)) {
    where.push('seq < ?');
    params.push(beforeSeq);
  }
  const rows = db.driver.all<MessageRow>(
    `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
    [...params, limit],
  );
  return rows.map(toMessageView);
}
