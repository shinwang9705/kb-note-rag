/**
 * 向量化提供者工厂。
 *
 *   - EMBEDDING_PROVIDER=none  -> NoneEmbeddingProvider（恒不可用，检索降级为关键词）
 *   - EMBEDDING_PROVIDER=local -> LocalEmbeddingProvider（惰性 import transformers.js；
 *                                 依赖缺失 / 模型缺失时 init() 内部降级为不可用，不抛错）
 *   - EMBEDDING_PROVIDER=api   -> ApiEmbeddingProvider（OpenAI 兼容云端接口；
 *                                 无 apiKey 时 available=false，检索自动降级为关键词）
 *
 * 统一原则：向量化是**增强能力**，任何失败都不能阻断进程启动与关键词检索。
 */
import type { AppConfig } from '../config.js';
import { NoneEmbeddingProvider } from './none.js';
import { LocalEmbeddingProvider } from './local.js';
import { ApiEmbeddingProvider } from './api.js';
import type { EmbeddingLogger, EmbeddingProvider } from './types.js';

export interface EmbeddingFactoryOptions {
  config: AppConfig;
  logger?: EmbeddingLogger | null;
}

/**
 * 创建提供者实例（尚未 init，调用方需自行 await provider.init()）。
 */
export function createEmbeddingProvider(options: EmbeddingFactoryOptions): EmbeddingProvider {
  const { config, logger } = options;
  const kind = config.embedding.provider;

  if (kind === 'local') {
    return new LocalEmbeddingProvider({
      model: config.embedding.model,
      dim: config.embedding.dim,
      cacheDir: config.embedding.cacheDir,
      hfEndpoint: config.embedding.hfEndpoint,
      logger: logger ?? null,
    });
  }

  if (kind === 'api') {
    return new ApiEmbeddingProvider({
      apiBase: config.embedding.apiBase,
      apiKey: config.embedding.apiKey,
      apiModel: config.embedding.apiModel,
      timeoutMs: config.embedding.timeoutMs,
      batchSize: config.embedding.batchSize,
      dim: config.embedding.dim,
      logger: logger ?? null,
    });
  }

  return new NoneEmbeddingProvider(logger ?? null);
}

/**
 * 创建并初始化提供者。
 * 初始化失败时回退到空实现，保证调用方永远拿到非空对象。
 */
export async function initEmbeddingProvider(
  options: EmbeddingFactoryOptions,
): Promise<EmbeddingProvider> {
  const provider = createEmbeddingProvider(options);
  try {
    await provider.init();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.error(`[embedding] 初始化失败，降级为 none：${message}`);
    const fallback = new NoneEmbeddingProvider(options.logger ?? null);
    await fallback.init();
    return fallback;
  }
  return provider;
}

/**
 * 检索模式推导：向量可用 -> hybrid，否则 keyword。
 * 供 /api/meta 与检索服务统一取用，避免各处各写一套判断。
 */
export function embeddingModeOf(provider: EmbeddingProvider): 'hybrid' | 'keyword' | 'none' {
  if (provider.kind === 'none' || !provider.available) return 'none';
  return 'hybrid';
}

export { LocalEmbeddingProvider } from './local.js';
export { NoneEmbeddingProvider } from './none.js';
export { ApiEmbeddingProvider } from './api.js';
export type {
  EmbeddedChunk,
  EmbeddingLogger,
  EmbeddingProvider,
  EmbeddingProviderKind,
} from './types.js';
export { normalizeVector } from './types.js';
