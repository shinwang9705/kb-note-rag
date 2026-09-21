/**
 * 空向量化实现（EMBEDDING_PROVIDER=none 或初始化失败时的兜底）。
 *
 * 行为契约：
 *   - available 恒为 false，调用方据此降级为纯关键词检索
 *   - embed / embedQuery 返回空数组而不是抛错，保证入库链路不被打断
 *   - init / close 都是幂等空操作
 */
import {
  normalizeVector,
  type EmbeddingLogger,
  type EmbeddingProvider,
  type EmbeddingProviderKind,
} from './types.js';

/** 空实现的默认维度（仅用于占位，实际不会写入向量表） */
const NONE_DIM = 1;

export class NoneEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = 'none';
  readonly model = 'none';
  readonly dim = NONE_DIM;
  readonly available = false;

  private readonly logger: EmbeddingLogger | null;
  private initialized = false;

  constructor(logger: EmbeddingLogger | null = null) {
    this.logger = logger;
  }

  /** 空实现无需初始化，仅记录一次降级提示 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.logger?.info('[embedding] provider=none，本次运行不生成向量，检索将降级为纯关键词模式');
  }

  /** 永远返回空数组：调用方需按 available 判断，不应依赖返回值长度 */
  async embed(texts: readonly string[]): Promise<number[][]> {
    void texts;
    return [];
  }

  async embedQuery(text: string): Promise<number[]> {
    void text;
    return normalizeVector([], NONE_DIM);
  }

  async close(): Promise<void> {
    this.initialized = false;
  }
}
