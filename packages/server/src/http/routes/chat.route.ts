/**
 * 问答路由（单轮 RAG）。
 *
 * 隔离铁律：userId 一律取自 request.userId（JWT）。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import type { ModelGateway } from '../../llm/router.js';
import { resolveDefaultProvider } from '../../llm/index.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { ask, askStream, type ChatContext } from '../../service/chat.service.js';

export interface ChatRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
  gateway: ModelGateway;
}

interface ChatBody {
  query: string;
  libraryId?: number | null;
  docId?: number | null;
  topK?: number;
}

function contextOf(ctx: ChatRouteContext): ChatContext {
  return {
    db: ctx.db,
    config: ctx.config,
    embedding: ctx.embedding,
    rerank: ctx.rerank,
    gateway: ctx.gateway,
  };
}

export function createChatRoutes(ctx: ChatRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function chatRoutes(app) {
    app.post<{ Body: ChatBody }>(
      '/api/chat',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 2000 },
              libraryId: { type: ['integer', 'null'], minimum: 1, default: null },
              docId: { type: ['integer', 'null'], minimum: 1, default: null },
              topK: { type: 'integer', minimum: 1, maximum: 20 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: ChatBody }>, reply) => {
        const body = request.body ?? ({} as ChatBody);
        const query = (body.query ?? '').trim();
        if (!query) throw ApiError.badRequest('问题不能为空');

        const controller = new AbortController();
        const onClose = (): void => { if (!reply.raw.writableEnded) controller.abort(); };
        reply.raw.on('close', onClose);
        try {
        const result = await ask(contextOf(ctx), {
          userId: request.userId,
          query,
          libraryId: body.libraryId ?? null,
          docId: body.docId ?? null,
          topK: body.topK,
          signal: controller.signal,
        });
        return ok(result);
        } finally { reply.raw.off('close', onClose); }
      },
    );

    app.post<{ Body: ChatBody }>(
      '/api/chat/stream',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 2000 },
              libraryId: { type: ['integer', 'null'], minimum: 1, default: null },
              docId: { type: ['integer', 'null'], minimum: 1, default: null },
              topK: { type: 'integer', minimum: 1, maximum: 20 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: ChatBody }>, reply) => {
        const body = request.body ?? ({} as ChatBody);
        const query = (body.query ?? '').trim();
        if (!query) throw ApiError.badRequest('问题不能为空');

        reply.hijack();
        const raw = reply.raw;
        const controller = new AbortController();
        const onClose = (): void => controller.abort();
        raw.on('close', onClose);
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (payload: unknown): void => {
          if (!raw.destroyed && !raw.writableEnded) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        try {
          const result = await askStream(
            contextOf(ctx),
            { userId: request.userId, query, libraryId: body.libraryId ?? null, docId: body.docId ?? null, topK: body.topK, signal: controller.signal },
            (delta) => {
              if (delta !== null) send({ type: 'delta', content: delta });
            },
          );
          send({ type: 'done', ...result });
        } catch (error) {
          const mapped =
            error instanceof ApiError
              ? { code: error.code, message: error.message }
              : { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
          send({ type: 'error', code: mapped.code, message: mapped.message });
        } finally {
          raw.off('close', onClose);
          raw.end();
        }
      },
    );

    app.get('/api/chat/status', { onRequest: [requireAuth] }, async (request) => {
      const target = await resolveDefaultProvider(ctx.gateway, request.userId);
      return ok({
        enabled: target != null,
        provider: target?.providerId ?? 'none',
        model: target?.model ?? 'none',
      });
    });
  };
}
