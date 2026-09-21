/**
 * 统计路由：个人用量 / 管理员全局用量 / 文档索引健康。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAdminHook, createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { adminUsage, documentStats, usageOf } from '../../repo/usage.repo.js';
import {
  libraryDist,
  statusDist,
  topDocs,
  topQueries,
  trend,
  typeDist,
} from '../../repo/stats.repo.js';

export interface StatsRouteContext {
  db: DbHandle;
  config: AppConfig;
}

export function createStatsRoutes(ctx: StatsRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);
  const requireAdmin = createRequireAdminHook();

  return async function statsRoutes(app) {
    /** GET /api/stats/usage —— 本人用量 */
    app.get('/api/stats/usage', { onRequest: [requireAuth] }, async (request: FastifyRequest) => {
      const usage = usageOf(ctx.db, request.userId);
      return ok({
        ...usage,
        docQuota: ctx.config.quota.maxDocumentsPerUser,
        storageQuotaBytes: ctx.config.quota.maxTotalBytes,
      });
    });

    /** GET /api/admin/stats —— 管理员全局用量（不含任何文档内容） */
    app.get('/api/admin/stats', { onRequest: [requireAuth, requireAdmin] }, async () => {
      return ok(adminUsage(ctx.db));
    });

    /** GET /api/stats/trend?days=30 —— 检索/提问/入库 按日趋势 */
    app.get<{ Querystring: { days?: number } }>(
      '/api/stats/trend',
      {
        onRequest: [requireAuth],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: { days?: number } }>) => {
        const qs = request.query ?? {};
        return ok(trend(ctx.db, request.userId, qs.days ?? 30));
      },
    );

    /** GET /api/stats/top?kind=query|doc —— 热门检索词 / 被引用文档 TOP10 */
    app.get<{ Querystring: { kind?: string } }>(
      '/api/stats/top',
      {
        onRequest: [requireAuth],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['query', 'doc'], default: 'query' },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: { kind?: string } }>) => {
        const kind = (request.query ?? {}).kind ?? 'query';
        if (kind !== 'query' && kind !== 'doc') throw ApiError.badRequest('非法的 kind');
        return ok({ items: kind === 'doc' ? topDocs(ctx.db, request.userId) : topQueries(ctx.db, request.userId) });
      },
    );

    /** GET /api/documents/stats —— 文档/索引健康（追加类型/库/状态分布） */
    app.get<{ Querystring: { libraryId?: number } }>(
      '/api/documents/stats',
      {
        onRequest: [requireAuth],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              libraryId: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: { libraryId?: number } }>) => {
        const qs = request.query ?? {};
        const stats = documentStats(ctx.db, request.userId, qs.libraryId ?? null);
        return ok({
          ...stats,
          typeDist: typeDist(ctx.db, request.userId),
          libraryDist: libraryDist(ctx.db, request.userId),
          statusDist: statusDist(ctx.db, request.userId),
        });
      },
    );
  };
}
