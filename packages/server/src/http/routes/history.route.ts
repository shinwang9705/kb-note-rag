/**
 * 历史路由（三期 T04）：搜索 + 导出（MD/JSON/TXT）。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import {
  exportBatch,
  exportConversation,
  searchHistory,
  type ExportFormat,
  type HistoryServiceContext,
} from '../../service/history.service.js';

export interface HistoryRouteContext {
  db: DbHandle;
  config: AppConfig;
}

interface ConversationIdParams {
  id: string;
}

interface SearchBody {
  keyword: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

interface BatchExportBody {
  conversationIds: number[];
  format: ExportFormat;
}

function svc(ctx: HistoryRouteContext): HistoryServiceContext {
  return { db: ctx.db, config: ctx.config };
}

function parseFormat(raw: string | undefined): ExportFormat {
  if (raw === 'md' || raw === 'json' || raw === 'txt') return raw;
  throw new ApiError('BAD_FORMAT', '不支持的导出格式（支持 md/json/txt）', 400);
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function sendFile(reply: FastifyReply, content: string, contentType: string, fileName: string): FastifyReply {
  return reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    .send(content);
}

export function createHistoryRoutes(ctx: HistoryRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function historyRoutes(app) {
    /** POST /api/history/search */
    app.post<{ Body: SearchBody }>(
      '/api/history/search',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['keyword'],
            additionalProperties: false,
            properties: {
              keyword: { type: 'string', minLength: 1, maxLength: 200 },
              from: { type: 'string' },
              to: { type: 'string' },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              offset: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: SearchBody }>) => {
        const body = request.body ?? ({} as SearchBody);
        const result = searchHistory(svc(ctx), request.userId, {
          keyword: body.keyword,
          from: body.from,
          to: body.to,
          limit: body.limit,
          offset: body.offset,
        });
        return ok(result);
      },
    );

    /** GET /api/conversations/:id/export?format= */
    app.get<{ Params: ConversationIdParams }>(
      '/api/conversations/:id/export',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ConversationIdParams }>, reply: FastifyReply) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const query = (request.query ?? {}) as Record<string, string | undefined>;
        const format = parseFormat(query.format);
        const result = exportConversation(svc(ctx), request.userId, id, format);
        return sendFile(reply, result.content, result.contentType, result.fileName);
      },
    );

    /** POST /api/history/export —— 批量合并导出 */
    app.post<{ Body: BatchExportBody }>(
      '/api/history/export',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['conversationIds', 'format'],
            additionalProperties: false,
            properties: {
              conversationIds: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1 },
              format: { type: 'string', enum: ['md', 'json', 'txt'] },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: BatchExportBody }>, reply: FastifyReply) => {
        const body = request.body ?? ({} as BatchExportBody);
        const result = exportBatch(svc(ctx), request.userId, body.conversationIds, body.format);
        return sendFile(reply, result.content, result.contentType, result.fileName);
      },
    );
  };
}
