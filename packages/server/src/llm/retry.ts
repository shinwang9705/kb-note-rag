/**
 * 指数退避 + 抖动 + 可重试判定（零依赖）。
 *
 * 退避时长照 §3.1.2 表：rate_limit/network 2/8/30s、server 1/4/15s（≤2 次）、
 * parse 0.5/1.5s、timeout 1/4s；不可重试的 kind（auth/quota/invalid_request/
 * context_overflow/aborted）不重试。
 */
import type { ErrorKind } from '@kb/shared';
import { backoffFor } from './errors.js';

export interface RetryDecision {
  retryable: boolean;
  /** 各次重试前的等待毫秒数（含抖动后） */
  delaysMs: number[];
  /** 最多重试次数（= delaysMs.length） */
  maxRetries: number;
}

/** 由 ErrorKind 取重试决策 */
export function retryDecisionOf(kind: ErrorKind): RetryDecision {
  const base = backoffFor(kind);
  return {
    retryable: base.length > 0,
    delaysMs: base.map((delay) => delay + Math.floor(Math.random() * Math.max(1, delay * 0.2))),
    maxRetries: base.length,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 按错误归一化结果执行重试。
 * @param fn 单次执行（会抛错）
 * @param resolve 把错误映射为重试决策（调用方先用 normalizeError 再 retryDecisionOf）
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  resolve: (error: unknown) => RetryDecision,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      signal?.throwIfAborted();
      const decision = resolve(error);
      if (!decision.retryable || attempt >= decision.maxRetries) {
        throw error;
      }
      const delay = decision.delaysMs[attempt] ?? decision.delaysMs[decision.delaysMs.length - 1] ?? 0;
      await sleep(delay, signal);
    }
  }
}
