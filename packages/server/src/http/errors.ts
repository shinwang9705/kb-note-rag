/**
 * 统一错误定义与 Fastify 错误处理器。
 * 对外错误体固定为 { code, message, request_id }。
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError } from '../service/auth.service.js';

/** 业务错误 */
export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError('BAD_REQUEST', message, 400, details);
  }

  static notFound(message = '资源不存在'): ApiError {
    return new ApiError('NOT_FOUND', message, 404);
  }

  static conflict(message: string): ApiError {
    return new ApiError('CONFLICT', message, 409);
  }

  static forbidden(message = '无权访问'): ApiError {
    return new ApiError('FORBIDDEN', message, 403);
  }
}

/** 归一化 LLM 错误 -> ApiError（非流式接口用；SSE 流用 llm/errors 的 normalizedToCode） */
export function normalizedToApiError(error: import('@kb/shared').NormalizedError): ApiError {
  if (error.kind === 'aborted') return new ApiError('LLM_ABORTED', '已停止生成', 499);
  if (error.kind === 'timeout') {
    return new ApiError('LLM_TIMEOUT', '模型服务超时，请稍后重试', 504);
  }
  if (error.kind === 'auth') return new ApiError('LLM_AUTH_ERROR', error.userMessage, 502);
  if (error.kind === 'quota') return new ApiError('LLM_QUOTA_ERROR', error.userMessage, 502);
  if (error.kind === 'context_overflow') return new ApiError('CONTEXT_OVERFLOW', error.userMessage, 400);
  return new ApiError('LLM_UPSTREAM_ERROR', error.userMessage || '模型服务上游出错', 502);
}

/** 成功响应信封 */
export function ok<T>(data: T, requestId?: string): { code: string; message: string; data: T; request_id?: string } {
  return { code: 'OK', message: 'ok', data, ...(requestId ? { request_id: requestId } : {}) };
}

/**
 * 统一错误处理器：
 *   - AuthError / ApiError：使用自定义 code 与状态码
 *   - Fastify 校验错误（FST_ERR_VALIDATION）：422 + VALIDATION_ERROR
 *   - 其余：500，生产环境不暴露堆栈
 */
export function createErrorHandler(isProduction: boolean) {
  return function errorHandler(
    error: FastifyError,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const requestId = request.id;

    if (error instanceof AuthError) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        request_id: requestId,
      });
      return;
    }
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        request_id: requestId,
      });
      return;
    }

    if (error.validation) {
      void reply.status(422).send({
        code: 'VALIDATION_ERROR',
        message: error.message || '请求参数校验失败',
        details: error.validation,
        request_id: requestId,
      });
      return;
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode === 404) {
      void reply.status(404).send({
        code: 'NOT_FOUND',
        message: `接口不存在：${request.method} ${request.url}`,
        request_id: requestId,
      });
      return;
    }

    request.log.error({ err: error, request_id: requestId }, 'unhandled error');
    void reply.status(statusCode >= 400 ? statusCode : 500).send({
      code: statusCode === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
      message: isProduction ? '服务器内部错误' : error.message || '服务器内部错误',
      request_id: requestId,
    });
  };
}
