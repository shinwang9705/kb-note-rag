/**
 * 重排序提供者工厂。
 *
 *   - RERANK_PROVIDER=none -> NoneRerankProvider（恒不可用，保持 RRF 原序）
 *   - RERANK_PROVIDER=api（默认）-> ApiRerankProvider（阿里云 DashScope 云端重排序；
 *                             无 DASHSCOPE_API_KEY 时 available=false，检索后不重排）
 *
 * 统一原则：rerank 是**增强能力**，任何失败都不能阻断进程启动与检索主链路。
 */
import type { AppConfig } from '../config.js';
import { NoneRerankProvider } from './none.js';
import { ApiRerankProvider } from './api.js';
import type { RerankLogger, RerankProvider } from './types.js';

export interface RerankFactoryOptions {
  config: AppConfig;
  logger?: RerankLogger | null;
}

/**
 * 创建提供者实例（尚未 init，调用方需自行 await provider.init()）。
 */
export function createRerankProvider(options: RerankFactoryOptions): RerankProvider {
  const { config, logger } = options;
  const kind = config.rerank.provider;

  if (kind === 'api') {
    return new ApiRerankProvider({
      apiBase: config.rerank.apiBase,
      apiKey: config.rerank.apiKey,
      model: config.rerank.model,
      timeoutMs: config.rerank.timeoutMs,
      returnDocuments: config.rerank.returnDocuments,
      logger: logger ?? null,
    });
  }

  return new NoneRerankProvider(logger ?? null);
}

/**
 * 创建并初始化提供者。
 * 初始化失败时回退到空实现，保证调用方永远拿到非空对象。
 */
export async function initRerankProvider(options: RerankFactoryOptions): Promise<RerankProvider> {
  const provider = createRerankProvider(options);
  try {
    await provider.init();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error(`[rerank] 初始化失败，降级为 none：${message}`);
    const fallback = new NoneRerankProvider(options.logger ?? null);
    await fallback.init();
    return fallback;
  }
  return provider;
}

/** 重排是否真正启用（供 /api/meta 与业务统一取用） */
export function rerankEnabled(provider: RerankProvider): boolean {
  return provider.available;
}

export { NoneRerankProvider } from './none.js';
export { ApiRerankProvider } from './api.js';
export type {
  RerankLogger,
  RerankProvider,
  RerankProviderKind,
  RerankResult,
} from './types.js';
