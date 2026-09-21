/**
 * 元信息路由：健康检查 / 应用元信息。
 */
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import type { ModelGateway } from '../../llm/router.js';
import { resolveSearchMode } from '../../service/search.service.js';
import { listProviders } from '../../service/provider.service.js';
import { storageBytesOf } from '../../repo/usage.repo.js';
import { ok } from '../errors.js';

export interface MetaRouteContext {
  db: DbHandle;
  config: AppConfig;
  startedAt: number;
  embedding?: EmbeddingProvider | null;
  rerank?: RerankProvider | null;
  gateway?: ModelGateway | null;
}

export function createMetaRoutes(ctx: MetaRouteContext): FastifyPluginAsync {
  return async function metaRoutes(app) {
    /** GET /api/health —— 不鉴权，供探活 */
    app.get('/api/health', async () => {
      let dbUp: 'up' | 'down' = 'down';
      try {
        const row = ctx.db.driver.get<{ n: number }>('SELECT 1 AS n');
        dbUp = row?.n === 1 ? 'up' : 'down';
      } catch {
        dbUp = 'down';
      }
      return ok({
        status: dbUp === 'up' ? 'ok' : 'degraded',
        uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
        db: dbUp,
        vec: ctx.db.vecAvailable,
        version: ctx.config.version,
      });
    });

    /** GET /api/meta —— 前端据此显示检索模式横幅、LLM 可用性、供应商配置状态 */
    app.get('/api/meta', async (request) => {
      const provider = ctx.embedding ?? null;
      const rerank = ctx.rerank ?? null;
      const gateway = ctx.gateway ?? null;
      const searchMode = provider ? resolveSearchMode('auto', ctx.db, provider) : 'keyword';
      const userId = request.userId || 0;

      let configuredProviders: string[] = [];
      let conversationEnabled = false;
      if (gateway) {
        try {
          const providers = await listProviders({ db: ctx.db, config: ctx.config, gateway }, userId);
          configuredProviders = providers.filter((item) => item.configured).map((item) => item.id);
        } catch {
          configuredProviders = [];
        }
        // 全局 .env 回退也算「已启用」
        if (ctx.config.llm.provider !== 'none' && ctx.config.llm.apiKey) {
          if (!configuredProviders.includes(ctx.config.llm.provider)) {
            configuredProviders.push(ctx.config.llm.provider);
          }
        }
        conversationEnabled = configuredProviders.length > 0;
      }

      return ok({
        appName: ctx.config.appName,
        version: ctx.config.version,
        env: ctx.config.env,
        embeddingMode: searchMode,
        searchMode,
        embeddingProvider: provider?.kind ?? 'none',
        embeddingModel: provider?.model ?? 'none',
        rerankProvider: rerank?.kind ?? 'none',
        rerankModel: rerank?.model ?? 'none',
        rerankEnabled: rerank?.available ?? false,
        llmEnabled: conversationEnabled,
        llmProvider: configuredProviders[0] ?? 'none',
        llmModel: conversationEnabled ? 'auto' : 'none',
        vecAvailable: ctx.db.vecAvailable,
        allowRegister: ctx.config.auth.allowRegister,
        providers: configuredProviders,
        needsSetup: !conversationEnabled,
        conversationEnabled,
        storageBytes: storageBytesOf(ctx.db, userId),
        storageQuotaBytes: ctx.config.quota.maxTotalBytes,
        limits: {
          maxDocumentsPerUser: ctx.config.quota.maxDocumentsPerUser,
          maxUploadMb: ctx.config.quota.maxUploadMb,
          maxFilesPerUpload: ctx.config.quota.maxFilesPerUpload,
        },
      });
    });
  };
}
