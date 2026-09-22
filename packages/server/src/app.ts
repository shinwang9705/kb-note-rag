/**
 * Fastify 应用装配：插件 -> 钩子 -> 路由 -> 错误处理器。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { DbHandle } from './db/connection.js';
import type { EmbeddingProvider } from './embedding/types.js';
import { NoneEmbeddingProvider } from './embedding/none.js';
import type { RerankProvider } from './rerank/types.js';
import { NoneRerankProvider } from './rerank/none.js';
import type { ModelGateway } from './llm/router.js';
import { createModelGateway, type GatewayLogger } from './llm/gateway.js';
import { createErrorHandler } from './http/errors.js';
import { createOptionalAuthHook } from './http/hooks/auth.js';
import { createAuthRoutes } from './http/routes/auth.route.js';
import { createMetaRoutes } from './http/routes/meta.route.js';
import { createLibraryRoutes } from './http/routes/library.route.js';
import { createDocumentRoutes } from './http/routes/document.route.js';
import { createSearchRoutes } from './http/routes/search.route.js';
import { createChatRoutes } from './http/routes/chat.route.js';
import { createConversationRoutes } from './http/routes/conversation.route.js';
import { createThinkingRoutes } from './http/routes/thinking.route.js';
import { createProviderRoutes } from './http/routes/provider.route.js';
import { createSettingsRoutes } from './http/routes/settings.route.js';
import { createRagRoutes } from './http/routes/rag.route.js';
import { createHistoryRoutes } from './http/routes/history.route.js';
import { createAdminRoutes } from './http/routes/admin.route.js';
import { createStatsRoutes } from './http/routes/stats.route.js';
import { createShareRoutes } from './http/routes/share.route.js';
import { startBackgroundWorker } from './service/background-worker.js';
import { RagProviderResolver } from './service/rag-model.service.js';

export interface BuildAppOptions {
  config: AppConfig;
  logger: Logger;
  db: DbHandle;
  startedAt?: number;
  /** 未注入时自动降级为空实现，保证单测/内嵌场景可用 */
  embedding?: EmbeddingProvider | null;
  /** 未注入时自动降级为空实现（不重排），保证单测/内嵌场景可用 */
  rerank?: RerankProvider | null;
  /** 未注入时用 db+config 现场装配（无凭据 -> 所有 LLM 入口降级 LLM_NOT_CONFIGURED） */
  gateway?: ModelGateway | null;
}

/**
 * 构建 Fastify 实例（不监听端口，方便测试注入）。
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, logger, db } = options;
  const startedAt = options.startedAt ?? Date.now();

  // Fastify 5 中 logger 只接受配置对象，传入已创建的 pino 实例需使用 loggerInstance
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.server.trustProxy ?? false,
    bodyLimit: Math.max(1, config.quota.maxUploadMb) * 1024 * 1024 + 1024 * 1024,
    genReqId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  });

  await app.register(cors, {
    origin: config.allowedOrigins.includes('*') ? true : config.allowedOrigins,
    credentials: false, // 当前使用 Bearer token，不应允许跨域携带浏览器凭据。
  });

  // 请求级字段声明（避免 Fastify 警告未声明的装饰）
  app.decorateRequest('userId', 0);
  app.decorateRequest('userRole', '');
  app.decorateRequest('currentUser', null);
  app.decorateRequest('rawToken', null);

  const ctx = { db, config };
  const embedding: EmbeddingProvider = options.embedding ?? new NoneEmbeddingProvider(null);
  const rerank: RerankProvider = options.rerank ?? new NoneRerankProvider(null);
  const gatewayLogger: GatewayLogger = {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
    debug: (message: string) => logger.debug(message),
  };
  const gateway: ModelGateway = options.gateway ?? createModelGateway({ db, config, logger: gatewayLogger });
  const ragModels = new RagProviderResolver({ db, config, logger });

  // 全局可选鉴权：任何请求都尝试解析 token，业务路由再用 requireAuth 强制
  app.addHook('onRequest', createOptionalAuthHook(ctx));

  app.setErrorHandler(createErrorHandler(config.isProduction));
  app.setNotFoundHandler(async (request, reply) => {
    void reply.status(404).send({
      code: 'NOT_FOUND',
      message: `接口不存在：${request.method} ${request.url}`,
      request_id: request.id,
    });
  });

  await app.register(createMetaRoutes({ db, config, startedAt, embedding, rerank, gateway }));
  await app.register(createAuthRoutes(ctx));
  await app.register(createLibraryRoutes(ctx));
  await app.register(createDocumentRoutes({ db, config, embedding, ragModels }));
  await app.register(createSearchRoutes({ db, config, embedding, ragModels }));
  await app.register(createChatRoutes({ db, config, embedding, rerank, gateway, ragModels }));
  await app.register(createConversationRoutes({ db, config, embedding, rerank, gateway, ragModels }));
  await app.register(createThinkingRoutes({ db, config, embedding, rerank, gateway, ragModels }));
  await app.register(createProviderRoutes({ db, config, gateway }));
  await app.register(createSettingsRoutes({ db, config }));
  await app.register(createRagRoutes({ db, config, embedding, rerank, ragModels }));
  await app.register(createHistoryRoutes({ db, config }));
  await app.register(createAdminRoutes({ db, config }));
  await app.register(createStatsRoutes({ db, config }));
  await app.register(createShareRoutes({ db, config, embedding, ragModels }));

  if (config.env !== 'test') {
    const worker = startBackgroundWorker({ db, config, embedding, logger, ragModels });
    app.addHook('onClose', async () => { worker.stop(); });
  }

  // 实例的实际 logger 类型是 pino.Logger，此处收敛为 Fastify 默认类型
  return app as unknown as FastifyInstance;
}
