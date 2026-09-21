/**
 * 检索路由。
 *
 * 隔离铁律：userId 一律取自 request.userId（JWT），不信任请求体里的任何用户标识；
 * repository 层再强制 WHERE user_id = ? —— 双保险。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { isVectorReady, resolveSearchMode, search, type SearchContext } from '../../service/search.service.js';
import { findDocumentById } from '../../repo/document.repo.js';
import { clear as clearHistory, listRecent, record as recordHistory } from '../../repo/search-history.repo.js';

export interface SearchRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
}

interface SearchBody {
  query: string;
  libraryId?: number | null;
  docId?: number | null;
  mode?: 'auto' | 'hybrid' | 'keyword' | 'vector';
  topK?: number;
  finalK?: number;
}

const MODES = ['auto', 'hybrid', 'keyword', 'vector'] as const;

/** 路由层只负责校验与转译，检索逻辑全部在 service 层 */
function contextOf(ctx: SearchRouteContext): SearchContext {
  return { db: ctx.db, config: ctx.config, embedding: ctx.embedding };
}

/** docId 若指定需校验归属；越权/不存在一律 404 */
function assertDocOwned(ctx: SearchRouteContext, userId: number, docId: number | null | undefined): void {
  if (docId === undefined || docId === null) return;
  if (!findDocumentById(ctx.db, userId, docId)) {
    throw ApiError.notFound('文档不存在或无权访问');
  }
}

export function createSearchRoutes(ctx: SearchRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function searchRoutes(app) {
    /**
     * POST /api/search —— 主检索入口。
     * 用 POST 而不是 GET：查询串可能很长且含中文/标点，放 body 更省心，也便于后续扩展过滤条件。
     */
    app.post<{ Body: SearchBody }>(
      '/api/search',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 200 },
              libraryId: { type: ['integer', 'null'], minimum: 1, default: null },
              docId: { type: ['integer', 'null'], minimum: 1, default: null },
              mode: { type: 'string', enum: [...MODES], default: 'auto' },
              topK: { type: 'integer', minimum: 1, maximum: 100 },
              finalK: { type: 'integer', minimum: 1, maximum: 50 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: SearchBody }>) => {
        const body = request.body ?? ({} as SearchBody);
        const query = (body.query ?? '').trim();
        if (!query) throw ApiError.badRequest('查询词不能为空');
        assertDocOwned(ctx, request.userId, body.docId);

        const result = await search(contextOf(ctx), {
          userId: request.userId,
          query,
          libraryId: body.libraryId ?? null,
          docId: body.docId ?? null,
          mode: body.mode ?? 'auto',
          topK: body.topK,
          finalK: body.finalK,
        });

        // 异步 best-effort 记录检索历史，失败不阻断检索
        try {
          recordHistory(ctx.db, request.userId, {
            query,
            mode: result.mode,
            hitCount: result.hits.length,
          });
        } catch (error) {
          request.log.warn({ err: error }, '记录检索历史失败');
        }

        request.log.debug(
          {
            query,
            mode: result.mode,
            stats: result.stats,
            fallbackLike: result.fallbackLike,
            tookMs: result.tookMs,
          },
          'search',
        );

        return ok(result);
      },
    );

    /** GET /api/search —— 便捷入口（同 POST，便于浏览器直接调试与前端浅链接） */
    app.get<{ Querystring: { q?: string; libraryId?: number; docId?: number; mode?: string; finalK?: number } }>(
      '/api/search',
      {
        onRequest: [requireAuth],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              q: { type: 'string', minLength: 1, maxLength: 200 },
              libraryId: { type: 'integer', minimum: 1 },
              docId: { type: 'integer', minimum: 1 },
              mode: { type: 'string', enum: [...MODES] },
              finalK: { type: 'integer', minimum: 1, maximum: 50 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{
          Querystring: { q?: string; libraryId?: number; docId?: number; mode?: string; finalK?: number };
        }>,
      ) => {
        const qs = request.query ?? {};
        const query = (qs.q ?? '').trim();
        if (!query) throw ApiError.badRequest('缺少查询参数 q');
        assertDocOwned(ctx, request.userId, qs.docId);

        const result = await search(contextOf(ctx), {
          userId: request.userId,
          query,
          libraryId: qs.libraryId ?? null,
          docId: qs.docId ?? null,
          mode: (qs.mode as SearchBody['mode']) ?? 'auto',
          finalK: qs.finalK,
        });
        return ok(result);
      },
    );

    /** GET /api/search/history —— 最近 50 条检索历史 */
    app.get('/api/search/history', { onRequest: [requireAuth] }, async (request: FastifyRequest) => {
      return ok({ items: listRecent(ctx.db, request.userId, 50) });
    });

    /** DELETE /api/search/history —— 清空检索历史 */
    app.delete('/api/search/history', { onRequest: [requireAuth] }, async (request: FastifyRequest) => {
      const removed = clearHistory(ctx.db, request.userId);
      return ok({ cleared: removed });
    });

    /**
     * GET /api/search/mode —— 当前实际生效的检索模式。
     * 前端 ModeBanner 用它显示"混合检索 / 仅关键词"，不用猜。
     */
    app.get('/api/search/mode', { onRequest: [requireAuth] }, async () => {
      const mode = resolveSearchMode('auto', ctx.db, ctx.embedding);
      return ok({
        mode,
        embeddingProvider: ctx.embedding.kind,
        embeddingModel: ctx.embedding.model,
        embeddingAvailable: ctx.embedding.available,
        vecAvailable: ctx.db.vecAvailable,
        vectorReady: isVectorReady(ctx.db, ctx.embedding),
      });
    });
  };
}
