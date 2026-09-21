/**
 * 管理员路由：用户列表 / 建号 / 启禁用 / 重置密码。
 * 全部 onRequest: [requireAuth, requireAdmin]，非管理员统一 403。
 * 返回体不含任何文档内容，仅文档数聚合。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, USERNAME_MAX, USERNAME_MIN } from '@kb/shared';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAdminHook, createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { toPublicUser } from '../../repo/user.repo.js';
import {
  createUserByAdmin,
  listUsersPage,
  resetUserPassword,
  setUserStatus,
} from '../../service/user-admin.js';

export interface AdminRouteContext {
  db: DbHandle;
  config: AppConfig;
}

interface AdminListQuery {
  page?: number;
  pageSize?: number;
  status?: 'active' | 'disabled';
  q?: string;
}

interface AdminCreateBody {
  username: string;
  password?: string;
  role?: 'admin' | 'user';
  email?: string | null;
}

interface AdminStatusBody {
  status: 'active' | 'disabled';
}

interface AdminResetBody {
  password?: string;
}

interface IdParams {
  id: string;
}

/** 把 :id 参数解析为正整数；非法返回 null */
function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export function createAdminRoutes(ctx: AdminRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);
  const requireAdmin = createRequireAdminHook();

  return async function adminRoutes(app) {
    /** GET /api/admin/users —— 分页列表 */
    app.get<{ Querystring: AdminListQuery }>(
      '/api/admin/users',
      {
        onRequest: [requireAuth, requireAdmin],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              page: { type: 'integer', minimum: 1, default: 1 },
              pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
              status: { type: 'string', enum: ['active', 'disabled'] },
              q: { type: 'string', maxLength: 100 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: AdminListQuery }>) => {
        const query = request.query ?? {};
        const result = listUsersPage(ctx.db, {
          page: query.page ?? 1,
          pageSize: query.pageSize ?? 20,
          status: query.status,
          q: query.q,
        });
        return ok(result);
      },
    );

    /** POST /api/admin/users —— 管理员建号 */
    app.post<{ Body: AdminCreateBody }>(
      '/api/admin/users',
      {
        onRequest: [requireAuth, requireAdmin],
        schema: {
          body: {
            type: 'object',
            required: ['username'],
            additionalProperties: false,
            properties: {
              username: {
                type: 'string',
                minLength: USERNAME_MIN,
                maxLength: USERNAME_MAX,
                pattern: '^[a-zA-Z0-9_-]+$',
              },
              password: { type: 'string', minLength: 8, maxLength: PASSWORD_MAX },
              role: { type: 'string', enum: ['admin', 'user'] },
              email: { type: ['string', 'null'], maxLength: 160 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: AdminCreateBody }>) => {
        const body = request.body ?? ({} as AdminCreateBody);
        const result = await createUserByAdmin(ctx.db, {
          username: body.username,
          password: body.password,
          role: body.role,
          email: body.email ?? null,
        });
        return ok({
          user: toPublicUser(result.user),
          ...(result.initialPassword ? { initialPassword: result.initialPassword } : {}),
        });
      },
    );

    /** PATCH /api/admin/users/:id/status —— 启用/禁用 */
    app.patch<{ Params: IdParams; Body: AdminStatusBody }>(
      '/api/admin/users/:id/status',
      {
        onRequest: [requireAuth, requireAdmin],
        schema: {
          body: {
            type: 'object',
            required: ['status'],
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['active', 'disabled'] },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: IdParams; Body: AdminStatusBody }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const user = setUserStatus(ctx.db, {
          operatorId: request.userId,
          targetId: id,
          status: request.body.status,
        });
        return ok({ user: toPublicUser(user) });
      },
    );

    /** POST /api/admin/users/:id/reset-password —— 重置密码 */
    app.post<{ Params: IdParams; Body: AdminResetBody }>(
      '/api/admin/users/:id/reset-password',
      {
        onRequest: [requireAuth, requireAdmin],
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              password: { type: 'string', minLength: 8, maxLength: PASSWORD_MAX },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: IdParams; Body: AdminResetBody }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const result = await resetUserPassword(ctx.db, id, {
          password: request.body?.password,
        });
        return ok({
          user: toPublicUser(result.user),
          ...(result.initialPassword ? { initialPassword: result.initialPassword } : {}),
        });
      },
    );
  };
}
