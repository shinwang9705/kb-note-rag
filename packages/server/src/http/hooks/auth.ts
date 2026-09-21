/**
 * HTTP 鉴权钩子：把 JWT 解析结果挂到 req 上。
 *
 * 强约束：任何业务路由只能通过 req.userId 取当前用户，
 * repository 层又会强制 WHERE user_id = ?，双重保证多用户隔离。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { AuthError, resolveUserFromHeader } from '../../service/auth.service.js';
import type { UserRow } from '../../repo/user.repo.js';
import { extractBearerToken } from '../../util/crypto.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 当前登录用户 id（未登录为 0） */
    userId: number;
    /** 当前登录用户角色 */
    userRole: string;
    /** 当前用户实体（未登录为 null） */
    currentUser: UserRow | null;
    /** 原始 token（用于登出） */
    rawToken: string | null;
  }
}

export interface AuthHookContext {
  db: DbHandle;
  config: AppConfig;
}

/** 可选鉴权：解析成功挂 req，失败不拦截（用于 /api/meta 等公开接口） */
export function createOptionalAuthHook(ctx: AuthHookContext) {
  return async function optionalAuth(request: FastifyRequest): Promise<void> {
    request.userId = 0;
    request.userRole = '';
    request.currentUser = null;
    request.rawToken = extractBearerToken(request.headers.authorization);
    if (!request.rawToken) return;
    try {
      const user = resolveUserFromHeader(ctx, request.headers.authorization);
      if (user) {
        request.currentUser = user;
        request.userId = user.id;
        request.userRole = user.role;
      }
    } catch {
      // 可选鉴权下忽略无效 token
    }
  };
}

/** 强制鉴权：无有效 token 直接 401 */
export function createRequireAuthHook(ctx: AuthHookContext) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.userId || !request.currentUser) {
      const err = new AuthError('UNAUTHORIZED', '未登录或令牌已失效', 401);
      void reply.status(err.statusCode).send({
        code: err.code,
        message: err.message,
        request_id: request.id,
      });
      return;
    }
    if (request.currentUser.status !== 'active') {
      const err = new AuthError('USER_DISABLED', '账号已被禁用', 403);
      void reply.status(err.statusCode).send({
        code: err.code,
        message: err.message,
        request_id: request.id,
      });
    }
  };
}

/** 角色守卫：仅允许 admin */
export function createRequireAdminHook() {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.userRole !== 'admin') {
      void reply.status(403).send({
        code: 'FORBIDDEN',
        message: '需要管理员权限',
        request_id: request.id,
      });
    }
  };
}
