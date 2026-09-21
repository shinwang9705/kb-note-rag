/**
 * 深度思考路由（三期 T03）。
 *
 *   GET  /api/thinking/runs/:id         -> { run, rounds }
 *   POST /api/thinking/runs/:id/resume  -> SSE 续跑流（从 completed_rounds+1）
 *
 * 隔离铁律：userId 取自 request.userId，repo 层再强制 WHERE user_id = ?；越权 404。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import type { RerankProvider } from '../../rerank/types.js';
import type { ModelGateway } from '../../llm/router.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import * as thinkingRepo from '../../repo/thinking.repo.js';
import { getContextChunks } from '../../repo/chat.repo.js';
import { createThinkingEngine } from '../../thinking/engine.js';
import { search } from '../../service/search.service.js';

export interface ThinkingRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  rerank: RerankProvider;
  gateway: ModelGateway;
}

interface RunIdParams {
  id: string;
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export function createThinkingRoutes(ctx: ThinkingRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  const engine = createThinkingEngine({
    db: ctx.db,
    config: ctx.config,
    gateway: ctx.gateway,
    rerank: ctx.rerank,
    search: (input) => search({ db: ctx.db, config: ctx.config, embedding: ctx.embedding }, input),
    chatRepo: { getContextChunks },
    thinkingRepo,
    logger: null,
  });

  return async function thinkingRoutes(app) {
    /** GET /api/thinking/runs/:id —— run 详情 + 轮次产物 */
    app.get<{ Params: RunIdParams }>(
      '/api/thinking/runs/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: RunIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const run = thinkingRepo.getRun(ctx.db, request.userId, id);
        if (!run) throw new ApiError('RUN_NOT_FOUND', '深度思考运行不存在或无权访问', 404);
        const rounds = thinkingRepo.listRounds(ctx.db, request.userId, id);
        return ok({ run, rounds });
      },
    );

    /** POST /api/thinking/runs/:id/resume —— SSE 续跑流 */
    app.post<{ Params: RunIdParams }>(
      '/api/thinking/runs/:id/resume',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: RunIdParams }>, reply: FastifyReply) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');

        // 归属校验 + 可续跑校验（404 越权 / 409 不可续跑）
        const run = thinkingRepo.getRun(ctx.db, request.userId, id);
        if (!run) throw new ApiError('RUN_NOT_FOUND', '深度思考运行不存在或无权访问', 404);
        if (!thinkingRepo.getResumable(ctx.db, request.userId, id)) {
          throw new ApiError('NOT_RESUMABLE', '该运行不可续跑', 409);
        }

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

        // 客户端断连触发 abort，服务端不再产生 token
        const controller = new AbortController();
        const onClose = (): void => controller.abort();
        raw.on('close', onClose);

        try {
          await engine.resume(id, request.userId, controller.signal, (event) => send(event));
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
          const message = error instanceof ApiError ? error.message : '服务器内部错误';
          send({ type: 'error', code, message });
        } finally {
          raw.off('close', onClose);
          raw.end();
        }
      },
    );
  };
}
