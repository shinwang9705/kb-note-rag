/**
 * 鉴权路由：注册 / 登录 / 登出 / 当前用户。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN } from '@kb/shared';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { AuthError, changePassword, login, logout, register } from '../../service/auth.service.js';
import { toPublicUser } from '../../repo/user.repo.js';

export interface AuthRouteContext {
  db: DbHandle;
  config: AppConfig;
}

const usernameSchema = {
  type: 'string',
  minLength: USERNAME_MIN,
  maxLength: USERNAME_MAX,
  pattern: '^[a-zA-Z0-9_-]+$',
} as const;

const passwordSchema = {
  type: 'string',
  minLength: PASSWORD_MIN,
  maxLength: PASSWORD_MAX,
} as const;

interface RegisterBody {
  username: string;
  password: string;
  email?: string | null;
}

interface LoginBody {
  username: string;
  password: string;
}

interface PasswordBody {
  oldPassword: string;
  newPassword: string;
}

export function createAuthRoutes(ctx: AuthRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function authRoutes(app) {
    /** POST /api/auth/register */
    app.post<{ Body: RegisterBody }>(
      '/api/auth/register',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            additionalProperties: false,
            properties: {
              username: usernameSchema,
              password: passwordSchema,
              email: { type: ['string', 'null'], maxLength: 160 },
            },
          },
        },
      },
      async (request, reply) => {
        try {
          const result = await register(ctx, request.body);
          return ok(result);
        } catch (error) {
          if (error instanceof AuthError && error.code === 'USERNAME_TAKEN') {
            throw ApiError.conflict(error.message);
          }
          throw error;
        }
      },
    );

    /** POST /api/auth/login */
    app.post<{ Body: LoginBody }>(
      '/api/auth/login',
      {
        schema: {
          body: {
            type: 'object',
            required: ['username', 'password'],
            additionalProperties: false,
            properties: {
              username: { type: 'string', minLength: 1, maxLength: USERNAME_MAX },
              password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
            },
          },
        },
      },
      async (request) => {
        const result = await login(ctx, request.body);
        return ok(result);
      },
    );

    /** PATCH /api/auth/password —— 修改密码（校验原密码） */
    app.patch<{ Body: PasswordBody }>(
      '/api/auth/password',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['oldPassword', 'newPassword'],
            additionalProperties: false,
            properties: {
              oldPassword: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX },
              newPassword: passwordSchema,
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: PasswordBody }>) => {
        await changePassword(ctx, request.userId, request.body);
        return ok({ changed: true });
      },
    );

    /** POST /api/auth/logout —— 把当前 token 的 jti 加入黑名单 */
    app.post(
      '/api/auth/logout',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest) => {
        const revoked = logout(ctx, request.rawToken);
        return ok({ revoked });
      },
    );

    /** GET /api/auth/me */
    app.get('/api/auth/me', { onRequest: [requireAuth] }, async (request: FastifyRequest) => {
      const user = request.currentUser;
      if (!user) throw new AuthError('UNAUTHORIZED', '未登录或令牌已失效', 401);
      return ok({ user: toPublicUser(user), expiresIn: ctx.config.auth.jwtExpiresInSec });
    });
  };
}

export { AuthError };
