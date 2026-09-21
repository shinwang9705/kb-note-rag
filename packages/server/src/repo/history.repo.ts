/**
 * 历史搜索数据访问层（三期 T04）。
 *
 * messages_fts（trigram）匹配 + 短词（<3 字）LIKE 兜底 + created_at 范围过滤；
 * JOIN conversations 取标题；强制 WHERE messages.user_id = ?；
 * snippet 高亮用偏移量（同 SearchHit 的 XSS 安全策略，不灌 HTML）。
 */
import type { DbHandle } from '../db/connection.js';
import { tokenizeQuery } from '../search/tokenize.js';
import { excerpt } from '../util/text.js';

export interface HistorySearchQuery {
  keyword: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface HistorySearchRow {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  role: string;
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
  createdAt: string;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 围绕首个命中词手工截取片段并返回高亮偏移（相对 snippet） */
function buildSnippet(content: string, terms: readonly string[]): { snippet: string; highlightStart: number; highlightEnd: number } {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (terms.length === 0 || flat.length === 0) {
    return { snippet: excerpt(flat, 120), highlightStart: -1, highlightEnd: -1 };
  }
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const lower = flat.toLowerCase();
  let index = -1;
  let matchedTerm = '';
  for (const term of sorted) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (index < 0 || found < index)) {
      index = found;
      matchedTerm = term;
    }
  }
  if (index < 0) return { snippet: excerpt(flat, 120), highlightStart: -1, highlightEnd: -1 };

  const start = Math.max(0, index - 40);
  const end = Math.min(flat.length, start + 120);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return {
    snippet: `${prefix}${flat.slice(start, end)}${suffix}`,
    highlightStart: prefix.length + (index - start),
    highlightEnd: prefix.length + (index - start) + matchedTerm.length,
  };
}

const BASE_SELECT =
  'm.id AS messageId, m.conversation_id AS conversationId, c.title AS conversationTitle, ' +
  'm.role AS role, m.content AS content, m.created_at AS createdAt';

function toRow(raw: { messageId: number; conversationId: number; conversationTitle: string; role: string; content: string; createdAt: string; score: number }, terms: readonly string[]): HistorySearchRow {
  const parts = buildSnippet(raw.content ?? '', terms);
  return {
    messageId: Number(raw.messageId),
    conversationId: Number(raw.conversationId),
    conversationTitle: raw.conversationTitle ?? '',
    role: raw.role,
    snippet: parts.snippet,
    highlightStart: parts.highlightStart,
    highlightEnd: parts.highlightEnd,
    createdAt: raw.createdAt,
    score: Number(raw.score ?? 0),
  };
}

export function searchMessages(
  db: DbHandle,
  userId: number,
  query: HistorySearchQuery,
): { items: HistorySearchRow[]; total: number } {
  const keyword = (query.keyword ?? '').trim();
  if (!keyword) return { items: [], total: 0 };

  const tokens = tokenizeQuery(keyword);
  const limit = Math.trunc(clamp(query.limit ?? 20, 1, 100));
  const offset = Math.trunc(clamp(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER));

  const timeWhere: string[] = [];
  const timeParams: string[] = [];
  if (query.from) {
    timeWhere.push('m.created_at >= ?');
    timeParams.push(query.from);
  }
  if (query.to) {
    timeWhere.push('m.created_at < ?');
    timeParams.push(query.to);
  }

  if (tokens.ftsPhrase) {
    // FTS5 trigram 通道（≥3 字符）
    const where = ['messages_fts MATCH ?', 'm.user_id = ?', ...timeWhere];
    const params: (string | number)[] = [tokens.ftsPhrase, userId, ...timeParams];
    const cond = where.join(' AND ');

    const rows = db.driver.all<{
      messageId: number; conversationId: number; conversationTitle: string; role: string; content: string; createdAt: string; score: number;
    }>(
      `SELECT ${BASE_SELECT}, -bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m    ON m.id = messages_fts.rowid
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${cond}
       ORDER BY bm25(messages_fts)
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const total = Number(
      db.driver.get<{ c: number }>(
        `SELECT COUNT(*) AS c
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE ${cond}`,
        params,
      )?.c ?? 0,
    );
    return { items: rows.map((row) => toRow(row, tokens.terms)), total };
  }

  // LIKE 兜底（短词 / trigram 无法覆盖）
  const ors = tokens.terms.map(() => "m.content LIKE ? ESCAPE '\\'");
  const where = ['m.user_id = ?', `(${ors.join(' OR ')})`, ...timeWhere];
  const likeParams: string[] = tokens.terms.map((term) => `%${term}%`);
  const params: (string | number)[] = [userId, ...likeParams, ...timeParams];
  const cond = where.join(' AND ');

  const rows = db.driver.all<{
    messageId: number; conversationId: number; conversationTitle: string; role: string; content: string; createdAt: string;
  }>(
    `SELECT ${BASE_SELECT}
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE ${cond}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = Number(
    db.driver.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${cond}`,
      params,
    )?.c ?? 0,
  );
  return {
    items: rows.map((row) => toRow({ ...row, score: 0 }, tokens.terms)),
    total,
  };
}
