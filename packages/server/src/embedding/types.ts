/**
 * 向量化（Embedding）提供者抽象。
 *
 * 设计要点：
 *   1. 上层（ingest / search）只依赖本接口，不感知底层是本地模型还是远端 API。
 *   2. provider 不可用时（available === false）调用方必须降级为纯关键词检索，
 *      而不是抛错中断入库流程 —— 保证「没有模型也能用」。
 *   3. embed 与 embedQuery 分开：部分模型对「文档/查询」有不同前缀指令
 *      （如 bge 系列查询侧要加 "为这个句子生成表示："），此处留出差异空间。
 */

/** 提供者类型：none = 不向量化，local = 本地模型，api = 远端服务 */
export type EmbeddingProviderKind = 'none' | 'local' | 'api';

/** 一条向量及其来源片段 id */
export interface EmbeddedChunk {
  /** 对应的 chunks.id */
  chunkId: number;
  /** 定长浮点向量，长度必须等于 provider.dim */
  vector: number[];
}

/**
 * 向量化提供者统一接口。
 * 实现必须保证：init() 之前 available === false；init() 失败时保持 available === false。
 */
export interface EmbeddingProvider {
  /** 提供者类型 */
  readonly kind: EmbeddingProviderKind;
  /** 模型标识（none 为 'none'） */
  readonly model: string;
  /** 向量维度 */
  readonly dim: number;
  /** 是否真正可用（none 恒为 false） */
  readonly available: boolean;

  /**
   * 初始化（加载模型 / 建立连接 / 自检）。
   * 允许重复调用；内部必须自行保证只真正初始化一次。
   */
  init(): Promise<void>;

  /**
   * 批量向量化文档片段。
   * @param texts 待向量化的文本，顺序必须与返回值一一对应
   * @returns 与 texts 等长的向量数组；不可用时返回空数组
   */
  embed(texts: readonly string[]): Promise<number[][]>;

  /**
   * 向量化单条查询。
   * @returns 长度等于 dim 的向量；不可用时返回空数组
   */
  embedQuery(text: string): Promise<number[]>;

  /** 释放资源（模型句柄 / 连接池） */
  close(): Promise<void>;
}

/** 极简日志契约，避免 embedding 层强耦合 pino */
export interface EmbeddingLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** 把任意浮点数组规整为定长 number[]（NaN/Infinity 归零，长度不足补 0） */
export function normalizeVector(input: readonly number[], dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const limit = Math.min(input.length, dim);
  for (let i = 0; i < limit; i += 1) {
    const value = input[i] ?? 0;
    out[i] = Number.isFinite(value) ? value : 0;
  }
  return out;
}
