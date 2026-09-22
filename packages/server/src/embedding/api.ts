/**
 * 云端 Embedding API 实现（OpenAI 兼容协议）。
 *
 * 启用方式：EMBEDDING_PROVIDER=api 且 EMBEDDING_API_KEY 非空。
 *   请求：POST ${apiBase}/embeddings
 *   请求体：{ model: apiModel, input: string[] }
 *   响应：{ data: [{ embedding: number[] }] }（按输入顺序一一对应）
 *
 * 统一原则：向量化是**增强能力**，任何网络失败都不能阻断入库链路，
 * embed 失败返回空数组，由检索层自动降级为纯关键词模式。
 */
import {
  normalizeVector,
  type EmbeddingLogger,
  type EmbeddingProvider,
  type EmbeddingProviderKind,
} from './types.js';

export interface ApiEmbeddingOptions {
  /** OpenAI 兼容接口基址（不含 /embeddings 后缀），如 https://dashscope.aliyuncs.com/compatible-mode/v1 */
  apiBase: string;
  /** 鉴权密钥，为空表示 provider 不可用 */
  apiKey: string;
  /** 远端模型标识 */
  apiModel: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 单次请求最多携带多少条文本 */
  batchSize: number;
  /** 向量维度（结果会归一化到该长度） */
  dim: number;
  logger?: EmbeddingLogger | null;
}

interface ApiEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  output?: {
    embeddings?: Array<{
      embedding?: number[];
      index?: number;
      text_index?: number;
    }>;
  };
}

export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = 'api';
  readonly model: string;
  readonly dim: number;
  available: boolean;
  /** 最近一次请求错误，仅用于连接测试与诊断，不包含 API Key。 */
  lastError: string | null = null;

  private readonly options: ApiEmbeddingOptions;
  private readonly logger: EmbeddingLogger | null;
  private initialized = false;

  constructor(options: ApiEmbeddingOptions) {
    this.options = options;
    this.model = options.apiModel;
    this.dim = options.dim;
    this.logger = options.logger ?? null;
    // 无 apiKey 时恒不可用，检索自动降级为 keyword
    this.available = Boolean(options.apiKey);
  }

  /** 初始化（幂等）：校验关键配置并记录状态，不建立常驻连接 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.options.apiKey) {
      this.available = false;
      this.logger?.warn(
        '[embedding] api provider 未配置 EMBEDDING_API_KEY，本次运行不生成向量，检索将降级为纯关键词模式',
      );
      return;
    }

    this.available = true;
    this.logger?.info(
      `[embedding] api provider ready：model=${this.model} dim=${this.dim}` +
        ` base=${this.options.apiBase} batch=${this.options.batchSize}`,
    );
  }

  /** 批量向量化：按 batchSize 分批请求，任一批失败则整体返回空数组 */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!this.available || texts.length === 0) return [];

    const batchSize = Math.max(1, Math.trunc(this.options.batchSize));
    const output: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      try {
        const vectors = await this.embedBatch(batch);
        this.lastError = null;
        output.push(...vectors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.logger?.warn(`[embedding] embed 失败，本次不产出向量：${message}`);
        return [];
      }
    }

    return output;
  }

  /** 单条查询向量化 */
  async embedQuery(text: string): Promise<number[]> {
    const vectors = await this.embed([text]);
    return vectors[0] ?? normalizeVector([], this.dim);
  }

  /** 无连接池需要释放 */
  async close(): Promise<void> {
    this.available = false;
    this.initialized = false;
  }

  private async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const { apiBase, apiKey, apiModel, timeoutMs } = this.options;
    const base = apiBase.replace(/\/+$/, '');
    const parsedBase = new URL(base);
    const isDashScopeNative = parsedBase.pathname.includes('/services/embeddings/');
    // 用户可以填写 OpenAI 兼容基址，也可以直接填写 DashScope 原生完整端点。
    // 对完整端点再次拼接 /embeddings 会形成无效 URL。
    const isFullEmbeddingEndpoint = isDashScopeNative || /\/embeddings$/u.test(parsedBase.pathname);
    const endpoint = isFullEmbeddingEndpoint ? base : `${base}/embeddings`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.trunc(timeoutMs)));

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(isDashScopeNative
          ? { model: apiModel, input: { texts: [...texts] } }
          : { model: apiModel, input: [...texts] }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`embedding API 返回 ${response.status}：${detail.slice(0, 200)}`);
      }

      const payload = (await response.json()) as ApiEmbeddingResponse;
      const data = payload?.data ?? [];
      const nativeData = payload?.output?.embeddings ?? [];
      // 按输入顺序取回，并归一化到声明维度，防御远端返回维度不一致
      return texts.map((_, index) => {
        const nativeItem = nativeData.find((item, position) => (item.text_index ?? item.index ?? position) === index);
        return normalizeVector(data[index]?.embedding ?? nativeItem?.embedding ?? [], this.dim);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
