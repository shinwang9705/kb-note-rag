/**
 * 供应商路由（三期 T04）：能力目录 / 凭据 / 连通性测试。
 * 隔离铁律：userId 取自 request.userId，凭据读写强制 WHERE user_id = ?。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { ModelGateway } from '../../llm/router.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import {
  deleteCredentials,
  listProviders,
  saveCredentials,
  testConnection,
  type ProviderServiceContext,
} from '../../service/provider.service.js';

export interface ProviderRouteContext {
  db: DbHandle;
  config: AppConfig;
  gateway: ModelGateway;
}

interface ProviderIdParams {
  id: string;
}

interface CredentialsBody {
  apiKey: string;
  baseUrlOverride?: string;
}

interface TestBody {
  apiKey?: string;
  baseUrlOverride?: string;
}

function svc(ctx: ProviderRouteContext): ProviderServiceContext {
  return { db: ctx.db, config: ctx.config, gateway: ctx.gateway };
}

export function createProviderRoutes(ctx: ProviderRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function providerRoutes(app) {
    /** GET /api/providers —— 能力目录 + 每用户配置/健康状态 */
    app.get('/api/providers', { onRequest: [requireAuth] }, async (request) => {
      const items = await listProviders(svc(ctx), request.userId);
      return ok({ items });
    });

    /** PUT /api/providers/:id/credentials —— 保存（加密落库） */
    app.put<{ Params: ProviderIdParams; Body: CredentialsBody }>(
      '/api/providers/:id/credentials',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['apiKey'],
            additionalProperties: false,
            properties: {
              apiKey: { type: 'string', minLength: 1, maxLength: 500 },
              baseUrlOverride: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: ProviderIdParams; Body: CredentialsBody }>) => {
        const body = request.body ?? ({} as CredentialsBody);
        return ok(saveCredentials(svc(ctx), request.userId, request.params.id, body.apiKey, body.baseUrlOverride));
      },
    );

    /** DELETE /api/providers/:id/credentials */
    app.delete<{ Params: ProviderIdParams }>(
      '/api/providers/:id/credentials',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ProviderIdParams }>) => {
        return ok(deleteCredentials(svc(ctx), request.userId, request.params.id));
      },
    );

    /** POST /api/providers/:id/test —— 连通性测试（≤16 token 极小请求） */
    app.post<{ Params: ProviderIdParams; Body: TestBody }>(
      '/api/providers/:id/test',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              apiKey: { type: 'string', maxLength: 500 },
              baseUrlOverride: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: ProviderIdParams; Body: TestBody }>) => {
        const body = request.body ?? ({} as TestBody);
        try {
          return ok(await testConnection(svc(ctx), request.userId, request.params.id, body.apiKey, body.baseUrlOverride));
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw ApiError.badRequest(error instanceof Error ? error.message : '连通性测试失败');
        }
      },
    );
  };
}
