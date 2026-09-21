/**
 * 空重排实现（RERANK_PROVIDER=none 或初始化失败时的兜底）。
 *
 * 行为契约：
 *   - available 恒为 false，调用方据此跳过重排，保持 RRF 原序
 *   - rerank 返回空数组而不是抛错，保证生成链路不被打断
 *   - init / close 都是幂等空操作
 */
import type { RerankLogger, RerankProvider, RerankProviderKind, RerankResult } from './types.js';

export class NoneRerankProvider implements RerankProvider {
  readonly kind: RerankProviderKind = 'none';
  readonly model = 'none';
  readonly available = false;

  private readonly logger: RerankLogger | null;
  private initialized = false;

  constructor(logger: RerankLogger | null = null) {
    this.logger = logger;
  }

  /** 空实现无需初始化，仅记录一次降级提示 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.logger?.info('[rerank] provider=none，检索结果不做重排序');
  }

  /** 永远返回空数组：调用方需按 available 判断，不应依赖返回值长度 */
  async rerank(_query: string, _docs: readonly string[]): Promise<RerankResult[]> {
    return [];
  }

  async close(): Promise<void> {
    this.initialized = false;
  }
}
