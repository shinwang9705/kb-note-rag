/**
 * 重排序（Rerank）提供者抽象。
 *
 * 设计要点（对齐 embedding 可插拔套路）：
 *   1. rerank 是「检索之后、回表之后、组装 prompt 之前」的**增强**环节，
 *      任何失败都不应阻断检索与生成主链路。
 *   2. provider 不可用（available === false）时调用方直接跳过重排，保持 RRF 原序。
 *   3. rerank() 失败/超时返回空数组而不是抛错，由调用方（rag-pipeline）降级。
 */

/** 提供者类型：none = 不重排，api = 云端 cross-encoder 精排 */
export type RerankProviderKind = 'api' | 'none';

/** 一条重排结果：index 对应输入 docs 的下标，score 为归一化相关度 0..1 */
export interface RerankResult {
  index: number;
  score: number;
}

/**
 * 重排序提供者统一接口。
 * 实现必须保证：init() 之前 available === false；init() 失败时保持 available === false。
 */
export interface RerankProvider {
  /** 提供者类型 */
  readonly kind: RerankProviderKind;
  /** 模型标识（none 为 'none'） */
  readonly model: string;
  /** 是否真正可用（none 恒 false；api 无 key 也 false） */
  readonly available: boolean;
  /** 幂等初始化；失败时保持 available=false，绝不抛错 */
  init(): Promise<void>;
  /**
   * 对候选文档重排，返回按相关度降序的 { index, score }[]。
   * 不可用或失败时返回空数组（调用方降级为不重排）。
   */
  rerank(query: string, docs: readonly string[]): Promise<RerankResult[]>;
  /** 释放资源（无连接池需要释放） */
  close(): Promise<void>;
}

/** 极简日志契约，避免 rerank 层强耦合 pino */
export interface RerankLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
