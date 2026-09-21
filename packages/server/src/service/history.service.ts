/**
 * 历史搜索 + 导出（三期 T04）。
 *
 * 导出格式：MD（# title + 逐条 ## role + reasoning 折叠）/ JSON（结构化全量）/ TXT（纯文本流）。
 */
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { ApiError } from '../http/errors.js';
import * as conversationRepo from '../repo/conversation.repo.js';
import { searchMessages, type HistorySearchQuery, type HistorySearchRow } from '../repo/history.repo.js';

export interface HistoryServiceContext {
  db: DbHandle;
  config: AppConfig;
}

export type ExportFormat = 'md' | 'json' | 'txt';

export interface ExportResult {
  content: string;
  fileName: string;
  contentType: string;
}

interface ExportMessage {
  role: string;
  content: string;
  reasoning: string | null;
  createdAt: string;
}

function listMessagesFull(ctx: HistoryServiceContext, userId: number, conversationId: number): ExportMessage[] {
  const rows = ctx.db.driver.all<{ role: string; content: string; reasoning: string | null; created_at: string }>(
    'SELECT role, content, reasoning, created_at FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY seq ASC',
    [userId, conversationId],
  );
  return rows.map((row) => ({
    role: row.role,
    content: row.content ?? '',
    reasoning: row.reasoning ?? null,
    createdAt: row.created_at,
  }));
}

function metaOf(format: ExportFormat): { fileName: string; contentType: string } {
  if (format === 'md') return { fileName: 'export.md', contentType: 'text/markdown; charset=utf-8' };
  if (format === 'json') return { fileName: 'export.json', contentType: 'application/json; charset=utf-8' };
  return { fileName: 'export.txt', contentType: 'text/plain; charset=utf-8' };
}

function renderSection(title: string, messages: ExportMessage[], format: ExportFormat): string {
  if (format === 'md') {
    const lines: string[] = [`# ${title}`, ''];
    for (const message of messages) {
      lines.push(`## ${message.role}`, '');
      if (message.reasoning) {
        lines.push('<details><summary>思考过程</summary>', '', message.reasoning, '', '</details>', '');
      }
      lines.push(message.content, '');
    }
    return lines.join('\n');
  }
  if (format === 'json') {
    return JSON.stringify(
      { title, messages: messages.map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning, createdAt: m.createdAt })) },
      null,
      2,
    );
  }
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n\n');
}

export function searchHistory(ctx: HistoryServiceContext, userId: number, query: HistorySearchQuery): { items: HistorySearchRow[]; total: number } {
  const keyword = (query.keyword ?? '').trim();
  if (!keyword) throw ApiError.badRequest('搜索关键词不能为空');
  return searchMessages(ctx.db, userId, query);
}

export function exportConversation(
  ctx: HistoryServiceContext,
  userId: number,
  conversationId: number,
  format: ExportFormat,
): ExportResult {
  const conversation = conversationRepo.getConversation(ctx.db, userId, conversationId);
  if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
  const messages = listMessagesFull(ctx, userId, conversationId);
  const meta = metaOf(format);
  return { content: renderSection(conversation.title, messages, format), ...meta };
}

export function exportBatch(
  ctx: HistoryServiceContext,
  userId: number,
  conversationIds: number[],
  format: ExportFormat,
): ExportResult {
  const sections: Array<{ title: string; messages: ExportMessage[] }> = [];
  for (const conversationId of conversationIds) {
    const conversation = conversationRepo.getConversation(ctx.db, userId, conversationId);
    if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
    sections.push({ title: conversation.title, messages: listMessagesFull(ctx, userId, conversationId) });
  }

  if (format === 'json') {
    const payload = sections.map((section) => ({
      title: section.title,
      messages: section.messages.map((m) => ({ role: m.role, content: m.content, reasoning: m.reasoning, createdAt: m.createdAt })),
    }));
    return { content: JSON.stringify(payload, null, 2), ...metaOf(format) };
  }

  const body = sections.map((section) => renderSection(section.title, section.messages, format)).join('\n\n');
  return { content: body, ...metaOf(format) };
}
