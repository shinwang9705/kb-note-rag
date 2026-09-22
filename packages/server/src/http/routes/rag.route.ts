/**
 * RAG 状态路由（六期 T01）：GET /api/rag/status。
 * 返回能力状态快照（结构级 + 运行级 effective/resolved + structuralHint），供设置页渲染。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { SaveRagModelConfigInput } from '@kb/shared';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ok } from '../errors.js';
import { ragStatus, type RagStatusContext } from '../../service/rag.service.js';
import { ragModelConfigs, resetRagModelConfig, saveRagModelConfig, testRagModelConfig, type RagModelServiceContext, type RagProviderResolver } from '../../service/rag-model.service.js';

export interface RagRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
  ragModels: RagProviderResolver;
}

export function createRagRoutes(ctx: RagRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function ragRoutes(app) {
    app.get('/api/rag/status', { onRequest: [requireAuth] }, async (request) => {
      const statusCtx: RagStatusContext = {
        db: ctx.db,
        config: ctx.config,
        embedding: ctx.ragModels.embeddingFor(request.userId, ctx.embedding),
        rerank: ctx.ragModels.rerankFor(request.userId, ctx.rerank),
      };
      return ok(ragStatus(statusCtx, request.userId));
    });

    const modelCtx: RagModelServiceContext = { db: ctx.db, config: ctx.config };
    app.get('/api/rag/models', { onRequest: [requireAuth] }, async (request) => ok({ items: ragModelConfigs(modelCtx, request.userId) }));
    app.put<{ Params: { capability: string }; Body: SaveRagModelConfigInput }>('/api/rag/models/:capability', {
      onRequest: [requireAuth],
      schema: { body: { type: 'object', required: ['enabled', 'apiBase', 'model', 'timeoutMs'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, apiBase: { type: 'string', minLength: 1, maxLength: 500 }, model: { type: 'string', minLength: 1, maxLength: 200 }, apiKey: { type: 'string', maxLength: 500 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, dim: { type: 'integer', minimum: 1, maximum: 4096 }, batchSize: { type: 'integer', minimum: 1, maximum: 128 } } } },
    }, async (request: FastifyRequest<{ Params: { capability: string }; Body: SaveRagModelConfigInput }>) => ok({ items: saveRagModelConfig(modelCtx, request.userId, request.params.capability, request.body) }));
    app.post<{ Params: { capability: string }; Body: Partial<SaveRagModelConfigInput> }>('/api/rag/models/:capability/test', { onRequest: [requireAuth] }, async (request: FastifyRequest<{ Params: { capability: string }; Body: Partial<SaveRagModelConfigInput> }>) => ok(await testRagModelConfig(modelCtx, request.userId, request.params.capability, request.body ?? {})));
    app.delete<{ Params: { capability: string } }>('/api/rag/models/:capability', { onRequest: [requireAuth] }, async (request: FastifyRequest<{ Params: { capability: string } }>) => ok({ items: resetRagModelConfig(modelCtx, request.userId, request.params.capability) }));
  };
}
