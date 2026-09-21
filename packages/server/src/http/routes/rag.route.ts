/**
 * RAG 状态路由（六期 T01）：GET /api/rag/status。
 * 返回能力状态快照（结构级 + 运行级 effective/resolved + structuralHint），供设置页渲染。
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ok } from '../errors.js';
import { ragStatus, type RagStatusContext } from '../../service/rag.service.js';

export interface RagRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
}

export function createRagRoutes(ctx: RagRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function ragRoutes(app) {
    app.get('/api/rag/status', { onRequest: [requireAuth] }, async (request) => {
      const statusCtx: RagStatusContext = {
        db: ctx.db,
        config: ctx.config,
        embedding: ctx.embedding,
        rerank: ctx.rerank,
      };
      return ok(ragStatus(statusCtx, request.userId));
    });
  };
}
