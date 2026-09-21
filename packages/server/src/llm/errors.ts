/**
 * LLM 错误归一化（三期 T04）。
 *
 * 把 HTTP/网络/解析错误映射为 NormalizedError（跨端单一数据源在 @kb/shared）。
 * 映射表照设计 §3.1.2 一字不差：
 *   401/403 -> auth（不重试 -> open_settings）
 *   429     -> rate_limit（重试 2/8/30s -> retry）
 *   402     -> quota（不重试 -> open_settings）
 *   400 含 maximum context length -> context_overflow（-> reduce_context）
 *   400 其他 -> invalid_request（-> open_settings）
 *   5xx     -> server（重试 1/4/15s，≤2 次 -> retry）
 *   ECONNRESET/ENOTFOUND/fetch failed -> network（重试 2/8/30s -> check_network）
 *   AbortError/超时 -> timeout 或 aborted
 *   SSE 解析异常 -> parse（-> switch_provider）
 */
import type { ErrorKind, NormalizedError, ProviderId, SuggestedAction } from '@kb/shared';

export type { ErrorKind, NormalizedError, ProviderId, SuggestedAction };

/** 非 2xx 上游响应（由 adapter 抛出） */
export class LlmHttpError extends Error {
  readonly statusCode: number;
  readonly body: string;
  readonly providerCode?: string;

  constructor(statusCode: number, body: string, providerCode?: string) {
    super(`LLM 上游返回 ${statusCode}：${body.slice(0, 200)}`);
    this.name = 'LlmHttpError';
    this.statusCode = statusCode;
    this.body = body;
    this.providerCode = providerCode;
  }
}

/** SSE 流解析异常（由 adapter/sse 抛出） */
export class LlmSseParseError extends Error {
  constructor(message: string) {
    super(`SSE 解析失败：${message}`);
    this.name = 'LlmSseParseError';
  }
}

const RETRY_DELAYS: Record<ErrorKind, number[]> = {
  auth: [],
  rate_limit: [2000, 8000, 30000],
  quota: [],
  invalid_request: [],
  server: [1000, 4000, 15000],
  network: [2000, 8000, 30000],
  context_overflow: [],
  timeout: [1000, 4000],
  parse: [500, 1500],
  aborted: [],
  unknown: [],
};

/** 按 ErrorKind 取退避序列（供 retry.withRetry 用） */
export function backoffFor(kind: ErrorKind): number[] {
  return RETRY_DELAYS[kind] ?? [];
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text = error.message ?? '';
  return /ECONNRESET|ENOTFOUND|fetch failed|ECONNREFUSED|network/i.test(text);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 从上游响应体里尽力抽取厂商 code（仅排障，不进用户提示） */
function extractProviderCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    return parsed.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * 归一化任意错误。
 * @param providerId 仅用于用户提示与 providerCode 兜底
 */
export function normalizeError(error: unknown, providerId: ProviderId): NormalizedError {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { kind: 'timeout', userMessage: '模型响应超时，请重试或调整超时设置', retryable: true, suggestedAction: 'retry' };
  }
  if (isAbortError(error)) {
    return { kind: 'aborted', userMessage: '请求已中止', retryable: false };
  }

  if (error instanceof LlmHttpError) {
    const status = error.statusCode;
    const code = error.providerCode ?? extractProviderCode(error.body);
    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        httpStatus: status,
        providerCode: code,
        userMessage: `${providerId} 鉴权失败，请检查 API Key`,
        retryable: false,
        suggestedAction: 'open_settings',
      };
    }
    if (status === 429) {
      return {
        kind: 'rate_limit',
        httpStatus: status,
        providerCode: code,
        userMessage: `${providerId} 触发限流，稍后重试`,
        retryable: true,
        suggestedAction: 'retry',
      };
    }
    if (status === 402) {
      return {
        kind: 'quota',
        httpStatus: status,
        providerCode: code,
        userMessage: `${providerId} 余额不足，请充值或更换供应商`,
        retryable: false,
        suggestedAction: 'open_settings',
      };
    }
    if (status === 400 && /maximum context length|context_length_exceeded|context window/i.test(error.body)) {
      return {
        kind: 'context_overflow',
        httpStatus: status,
        providerCode: code,
        userMessage: '上下文超出模型窗口，请减少历史或减小 maxTokens',
        retryable: false,
        suggestedAction: 'reduce_context',
      };
    }
    if (status === 400) {
      return {
        kind: 'invalid_request',
        httpStatus: status,
        providerCode: code,
        userMessage: `${providerId} 请求参数非法`,
        retryable: false,
        suggestedAction: 'open_settings',
      };
    }
    if (status >= 500) {
      return {
        kind: 'server',
        httpStatus: status,
        providerCode: code,
        userMessage: `${providerId} 服务暂时不可用，请稍后重试`,
        retryable: true,
        suggestedAction: 'retry',
      };
    }
  }

  if (isNetworkError(error)) {
    return {
      kind: 'network',
      userMessage: '网络连接失败，请检查网络后重试',
      retryable: true,
      suggestedAction: 'check_network',
    };
  }

  if (error instanceof LlmSseParseError) {
    return {
      kind: 'parse',
      userMessage: '模型返回内容解析失败，建议切换供应商',
      retryable: true,
      suggestedAction: 'switch_provider',
    };
  }

  return {
    kind: 'unknown',
    userMessage: error instanceof Error ? error.message : '模型调用失败',
    retryable: false,
  };
}

/** 网关调用失败时抛出的错误（携带归一化结果），供 service/route 映射为 ApiError */
export class GatewayError extends Error {
  readonly normalized: NormalizedError;

  constructor(normalized: NormalizedError) {
    super(normalized.userMessage);
    this.name = 'GatewayError';
    this.normalized = normalized;
  }
}

/** 归一化错误 -> SSE error 帧的 {code,message}（面向用户的可读码） */
export function normalizedToCode(error: NormalizedError): { code: string; message: string } {
  switch (error.kind) {
    case 'timeout':
      return { code: 'LLM_TIMEOUT', message: '模型服务超时，请稍后重试' };
    case 'aborted':
      return { code: 'LLM_ABORTED', message: '已停止生成' };
    case 'auth':
      return { code: 'LLM_AUTH_ERROR', message: error.userMessage };
    case 'quota':
      return { code: 'LLM_QUOTA_ERROR', message: error.userMessage };
    case 'context_overflow':
      return { code: 'CONTEXT_OVERFLOW', message: error.userMessage };
    case 'server':
    case 'network':
      return { code: 'LLM_UPSTREAM_ERROR', message: '模型服务上游出错，请稍后重试' };
    default:
      return { code: 'LLM_ERROR', message: error.userMessage };
  }
}
