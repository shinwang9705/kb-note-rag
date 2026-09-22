/**
 * 会话路由（三期 T02）。
 *
 * REST：会话 CRUD + 消息列表；SSE：POST /:id/messages 流式多轮 + POST /:id/abort 停止。
 *
 * 隔离铁律：userId 一律取自 request.userId（JWT）；repo 层再强制 WHERE user_id = ?，
 * 越权一律表现为 404，不泄露资源是否存在。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import type { ModelGateway } from '../../llm/router.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import * as conversationRepo from '../../repo/conversation.repo.js';
import * as messageRepo from '../../repo/message.repo.js';
import {
  abortConversation,
  createConversation,
  isConversationStreaming,
  patchConversation,
  sendMessage,
  type ConversationServiceContext,
} from '../../service/conversation.service.js';
import type { ConversationMode, GenerationParams, KbScope } from '@kb/shared';
import type { RagProviderResolver } from '../../service/rag-model.service.js';

export interface ConversationRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
  gateway: ModelGateway;
  ragModels: RagProviderResolver;
}

interface ConvIdParams {
  id: string;
}

interface CreateConversationBody {
  title?: string;
  mode?: ConversationMode;
  providerId?: string;
  model?: string;
  params?: Partial<GenerationParams>;
  kbEnabled?: boolean;
  kbScope?: KbScope | null;
}

interface PatchConversationBody {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  params?: Partial<GenerationParams>;
  kbScope?: KbScope | null;
  kbEnabled?: boolean;
  providerId?: string;
  model?: string;
}

interface SendMessageBody {
  content: string;
  mode?: ConversationMode;
}

function serviceCtx(ctx: ConversationRouteContext, userId: number): ConversationServiceContext {
  return {
    db: ctx.db,
    config: ctx.config,
    embedding: ctx.ragModels.embeddingFor(userId, ctx.embedding),
    rerank: ctx.ragModels.rerankFor(userId, ctx.rerank),
    gateway: ctx.gateway,
  };
}

/** 把 FastifyRequest 上的 id 参数解析为正整数；非法返回 null */
function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '') return null;
  return raw === 'true' || raw === '1';
}

/** SSE error 帧内容映射 */
function conversationErrorOf(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '服务器内部错误' };
}

export function createConversationRoutes(ctx: ConversationRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function conversationRoutes(app) {
    /** POST /api/conversations —— 新建会话 */
    app.post<{ Body: CreateConversationBody }>(
      '/api/conversations',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 200 },
              mode: { type: 'string', enum: ['chat', 'agent'] },
              providerId: { type: 'string', maxLength: 50 },
              model: { type: 'string', maxLength: 100 },
              params: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  temperature: { type: 'number', minimum: 0, maximum: 2 },
                  topP: { type: 'number', minimum: 0, maximum: 1 },
                  maxTokens: { type: 'integer', minimum: 256, maximum: 8192 },
                  thinkingRounds: { type: 'integer', minimum: 1, maximum: 10 },
                },
              },
              kbEnabled: { type: 'boolean' },
              kbScope: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  libraryId: { type: ['integer', 'null'] },
                  documentIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
                },
              },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreateConversationBody }>) => {
        const body = request.body ?? {};
        const conversation = createConversation(serviceCtx(ctx, request.userId), {
          userId: request.userId,
          title: body.title,
          mode: body.mode,
          providerId: body.providerId,
          model: body.model,
          params: body.params,
          kbEnabled: body.kbEnabled,
          kbScope: body.kbScope,
        });
        return ok({ item: conversation });
      },
    );

    /** GET /api/conversations —— 列表（分页 + 筛选） */
    app.get('/api/conversations', { onRequest: [requireAuth] }, async (request) => {
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const result = conversationRepo.listConversations(ctx.db, request.userId, {
        page: query.page ? Number(query.page) : 1,
        pageSize: query.pageSize ? Number(query.pageSize) : 20,
        archived: parseBool(query.archived),
        pinned: parseBool(query.pinned),
        keyword: query.keyword,
        from: query.from,
        to: query.to,
      });
      return ok(result);
    });

    /** GET /api/conversations/:id */
    app.get<{ Params: ConvIdParams }>(
      '/api/conversations/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ConvIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const conversation = conversationRepo.getConversation(ctx.db, request.userId, id);
        if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
        return ok({ item: conversation });
      },
    );

    /** PATCH /api/conversations/:id */
    app.patch<{ Params: ConvIdParams; Body: PatchConversationBody }>(
      '/api/conversations/:id',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 200 },
              pinned: { type: 'boolean' },
              archived: { type: 'boolean' },
              kbEnabled: { type: 'boolean' },
              providerId: { type: 'string', maxLength: 50 },
              model: { type: 'string', maxLength: 100 },
              params: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  temperature: { type: 'number', minimum: 0, maximum: 2 },
                  topP: { type: 'number', minimum: 0, maximum: 1 },
                  maxTokens: { type: 'integer', minimum: 256, maximum: 8192 },
                  thinkingRounds: { type: 'integer', minimum: 1, maximum: 10 },
                },
              },
              kbScope: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  libraryId: { type: ['integer', 'null'] },
                  documentIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
                },
              },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: ConvIdParams; Body: PatchConversationBody }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const body = request.body ?? {};
        const conversation = patchConversation(serviceCtx(ctx, request.userId), {
          userId: request.userId,
          conversationId: id,
          title: body.title,
          pinned: body.pinned,
          archived: body.archived,
          params: body.params,
          kbScope: body.kbScope,
          kbEnabled: body.kbEnabled,
          providerId: body.providerId,
          model: body.model,
        });
        return ok({ item: conversation });
      },
    );

    /** DELETE /api/conversations/:id —— 级联删除消息/深度思考运行 */
    app.delete<{ Params: ConvIdParams }>(
      '/api/conversations/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ConvIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const removed = conversationRepo.deleteConversation(ctx.db, request.userId, id);
        if (!removed) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
        return ok({ id, removed });
      },
    );

    /** GET /api/conversations/:id/messages —— 消息列表（limit/beforeSeq） */
    app.get<{ Params: ConvIdParams }>(
      '/api/conversations/:id/messages',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ConvIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const conversation = conversationRepo.getConversation(ctx.db, request.userId, id);
        if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
        const query = (request.query ?? {}) as Record<string, string | undefined>;
        const items = messageRepo.listMessages(ctx.db, request.userId, id, {
          limit: query.limit ? Number(query.limit) : 100,
          beforeSeq: query.beforeSeq ? Number(query.beforeSeq) : undefined,
        });
        return ok({ items, total: items.length });
      },
    );

    /** POST /api/conversations/:id/messages —— SSE 流式多轮 */
    app.post<{ Params: ConvIdParams; Body: SendMessageBody }>(
      '/api/conversations/:id/messages',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['content'],
            additionalProperties: false,
            properties: {
              content: { type: 'string', minLength: 1, maxLength: 8000 },
              mode: { type: 'string', enum: ['chat', 'agent'] },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: ConvIdParams; Body: SendMessageBody }>, reply: FastifyReply) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const body = request.body ?? ({} as SendMessageBody);
        const content = (body.content ?? '').trim();
        if (!content) throw ApiError.badRequest('消息内容不能为空');

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const send = (payload: unknown): void => {
          raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        // 客户端断连同样触发 abort，避免服务端继续产生 token
        const onClose = (): void => {
          abortConversation(id);
        };
        raw.on('close', onClose);

        try {
          await sendMessage(
            serviceCtx(ctx, request.userId),
            { userId: request.userId, conversationId: id, content, mode: body.mode },
            (event) => send(event),
          );
        } catch (error) {
          const mapped = conversationErrorOf(error);
          request.log.warn({ code: mapped.code, conversationId: id }, 'conversation stream error');
          send({ type: 'error', code: mapped.code, message: mapped.message });
        } finally {
          raw.off('close', onClose);
          raw.end();
        }
      },
    );

    /** POST /api/conversations/:id/abort —— 停止进行中的生成 */
    app.post<{ Params: ConvIdParams }>(
      '/api/conversations/:id/abort',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: ConvIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const conversation = conversationRepo.getConversation(ctx.db, request.userId, id);
        if (!conversation) throw new ApiError('CONVERSATION_NOT_FOUND', '会话不存在或无权访问', 404);
        if (!isConversationStreaming(id)) {
          throw new ApiError('NOT_STREAMING', '该会话当前没有进行中的生成', 409);
        }
        const aborted = abortConversation(id);
        return ok({ aborted, runId: null, completedRounds: 0 });
      },
    );
  };
}
