/**
 * 知识库路由（本阶段最小实现）。
 * 存在的意义：证明「所有查询强制带 user_id」—— 用 B 的 token 只能读到 B 的数据。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import {
  createLibrary,
  deleteLibrary,
  findLibraryById,
  listLibraries,
  type LibraryRow,
} from '../../repo/library.repo.js';

export interface LibraryRouteContext {
  db: DbHandle;
  config: AppConfig;
}

interface CreateLibraryBody {
  name: string;
  description?: string;
}

interface LibraryIdParams {
  id: string;
}

function toDto(row: LibraryRow) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createLibraryRoutes(ctx: LibraryRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function libraryRoutes(app) {
    /** GET /api/libraries —— 只返回当前用户自己的 */
    app.get('/api/libraries', { onRequest: [requireAuth] }, async (request: FastifyRequest) => {
      const rows = listLibraries(ctx.db, request.userId);
      return ok({ items: rows.map(toDto), total: rows.length });
    });

    /** POST /api/libraries */
    app.post<{ Body: CreateLibraryBody }>(
      '/api/libraries',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 80 },
              description: { type: 'string', maxLength: 500, default: '' },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreateLibraryBody }>) => {
        try {
          const row = createLibrary(
            ctx.db,
            request.userId,
            request.body.name,
            request.body.description ?? '',
          );
          return ok({ item: toDto(row) });
        } catch {
          throw ApiError.conflict('同名知识库已存在');
        }
      },
    );

    /** GET /api/libraries/:id —— 越权访问返回 404，不泄露资源是否存在 */
    app.get<{ Params: LibraryIdParams }>(
      '/api/libraries/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: LibraryIdParams }>) => {
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('非法的 id');
        const row = findLibraryById(ctx.db, request.userId, id);
        if (!row) throw ApiError.notFound('知识库不存在或无权访问');
        return ok({ item: toDto(row) });
      },
    );

    /** DELETE /api/libraries/:id */
    app.delete<{ Params: LibraryIdParams }>(
      '/api/libraries/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: LibraryIdParams }>) => {
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('非法的 id');
        const removed = deleteLibrary(ctx.db, request.userId, id);
        if (!removed) throw ApiError.notFound('知识库不存在或无权访问');
        return ok({ id, removed });
      },
    );
  };
}
