/**
 * 驾驶舱聚合统计数据访问层（四期 T05）。
 * 全部查询强制 WHERE user_id=?（隔离铁律）；只做聚合，不产出任何文档正文。
 */
import type { DistItem, StatsTrend, StatsTrendPoint, TopItem } from '@kb/shared';
import type { DbHandle } from '../db/connection.js';

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  processing: '处理中',
  ready: '就绪',
  failed: '失败',
};

/** 最近 N 天的 UTC 日期串（YYYY-MM-DD，含今天，升序） */
function recentDates(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** 单表按日计数 -> Map<date, count> */
function dailyCounts(db: DbHandle, userId: number, minDate: string, kind: 'search' | 'chat' | 'ingest'): Map<string, number> {
  const map = new Map<string, number>();
  let sql = '';
  if (kind === 'search') {
    sql = `SELECT date(created_at) AS d, COUNT(*) AS c FROM search_history
           WHERE user_id = ? AND date(created_at) >= ? GROUP BY date(created_at)`;
  } else if (kind === 'chat') {
    sql = `SELECT date(created_at) AS d, COUNT(*) AS c FROM messages
           WHERE user_id = ? AND role = 'user' AND date(created_at) >= ? GROUP BY date(created_at)`;
  } else {
    sql = `SELECT date(created_at) AS d, COUNT(*) AS c FROM documents
           WHERE user_id = ? AND date(created_at) >= ? GROUP BY date(created_at)`;
  }
  const rows = db.driver.all<{ d: string; c: number }>(sql, [userId, minDate]);
  for (const row of rows) map.set(row.d, Number(row.c));
  return map;
}

/** 趋势聚合：检索/提问/入库 按日（缺日补 0） */
export function trend(db: DbHandle, userId: number, days: number): StatsTrend {
  const clamped = Math.min(Math.max(1, Math.trunc(days)), 90);
  const dates = recentDates(clamped);
  const minDate = dates[0] ?? '';
  const search = dailyCounts(db, userId, minDate, 'search');
  const chat = dailyCounts(db, userId, minDate, 'chat');
  const ingest = dailyCounts(db, userId, minDate, 'ingest');

  const series: StatsTrendPoint[] = dates.map((date) => ({
    date,
    search: search.get(date) ?? 0,
    chat: chat.get(date) ?? 0,
    ingest: ingest.get(date) ?? 0,
  }));
  return { days: clamped, series };
}

/** 热门检索词 TOP10（search_history GROUP BY query） */
export function topQueries(db: DbHandle, userId: number): TopItem[] {
  const rows = db.driver.all<{ query: string; c: number }>(
    `SELECT query, COUNT(*) AS c FROM search_history
     WHERE user_id = ? GROUP BY query ORDER BY c DESC, MAX(created_at) DESC LIMIT 10`,
    [userId],
  );
  return rows.map((row) => ({ key: row.query, title: row.query, count: Number(row.c) }));
}

/** 热门被引用文档 TOP10（最近 500 条 assistant 消息 citations_json 按 docId 计数，docTitle 兜底） */
export function topDocs(db: DbHandle, userId: number): TopItem[] {
  const rows = db.driver.all<{ citations_json: string | null }>(
    `SELECT citations_json FROM messages
     WHERE user_id = ? AND role = 'assistant' AND citations_json IS NOT NULL AND citations_json != ''
     ORDER BY created_at DESC, id DESC LIMIT 500`,
    [userId],
  );

  const counts = new Map<number, { count: number; title: string }>();
  for (const row of rows) {
    let citations: Array<{ docId?: number; docTitle?: string }> = [];
    try {
      citations = JSON.parse(row.citations_json ?? '[]') as Array<{ docId?: number; docTitle?: string }>;
    } catch {
      continue;
    }
    for (const citation of citations) {
      const docId = Number(citation?.docId);
      if (!Number.isInteger(docId) || docId <= 0) continue;
      const entry = counts.get(docId) ?? { count: 0, title: citation.docTitle ?? `文档${docId}` };
      entry.count += 1;
      if (!entry.title && citation.docTitle) entry.title = citation.docTitle;
      counts.set(docId, entry);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([docId, entry]) => ({ key: String(docId), title: entry.title, count: entry.count }));
}

/** 文档类型分布（GROUP BY file_ext） */
export function typeDist(db: DbHandle, userId: number): DistItem[] {
  const rows = db.driver.all<{ file_ext: string | null; c: number }>(
    `SELECT file_ext, COUNT(*) AS c FROM documents WHERE user_id = ? GROUP BY file_ext ORDER BY c DESC`,
    [userId],
  );
  return rows.map((row) => {
    const ext = row.file_ext ?? 'text';
    return { key: ext, label: row.file_ext ? ext.toUpperCase() : '纯文本', count: Number(row.c) };
  });
}

/** 知识库分布（documents JOIN libraries GROUP BY library_id；未分类 = 未分类） */
export function libraryDist(db: DbHandle, userId: number): DistItem[] {
  const rows = db.driver.all<{ library_id: number | null; name: string | null; c: number }>(
    `SELECT d.library_id AS library_id, l.name AS name, COUNT(*) AS c
     FROM documents d LEFT JOIN libraries l ON l.id = d.library_id
     WHERE d.user_id = ? GROUP BY d.library_id ORDER BY c DESC`,
    [userId],
  );
  return rows.map((row) => ({
    key: row.library_id === null ? 'none' : String(row.library_id),
    label: row.library_id === null ? '未分类' : (row.name ?? `知识库${row.library_id}`),
    count: Number(row.c),
  }));
}

/** 状态分布（GROUP BY status） */
export function statusDist(db: DbHandle, userId: number): DistItem[] {
  const rows = db.driver.all<{ status: string; c: number }>(
    `SELECT status, COUNT(*) AS c FROM documents WHERE user_id = ? GROUP BY status ORDER BY c DESC`,
    [userId],
  );
  return rows.map((row) => ({ key: row.status, label: STATUS_LABEL[row.status] ?? row.status, count: Number(row.c) }));
}
