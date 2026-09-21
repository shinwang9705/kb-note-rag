/**
 * 云端 Rerank API 实现（阿里云 DashScope 文本重排序）。
 *
 * 启用方式：RERANK_PROVIDER=api（默认）且 DASHSCOPE_API_KEY 非空。
 *   请求：POST ${apiBase}
 *   请求体：{ model, input: { query, documents: docs }, parameters: { top_n, return_documents } }
 *   响应归一化：DashScope 的 output.results[{index,relevance_score,document}] 与
 *               通用 results[{index,relevance_score}] 统一归一到 { index, score }[]。
 *
 * 统一原则：rerank 是**增强能力**，任何网络失败/超时都不能阻断检索主链路，
 * rerank 失败返回空数组，由 rag-pipeline 降级为保持 RRF 原序。
 *
 * 说明：rerank 不是 OpenAI 官方 API，三家厂商（DashScope/Jina/Cohere）均为各自
 * 私有 HTTP 形状；切换厂商只需改 RERANK_API_BASE/RERANK_MODEL/DASHSCOPE_API_KEY。
 */
import type { RerankLogger, RerankProvider, RerankProviderKind, RerankResult } from './types.js';

export interface ApiRerankOptions {
  /** 云端 rerank 端点全路径（含 /services/rerank/... 后缀） */
  apiBase: string;
  /** 鉴权密钥，为空表示 provider 不可用（由 DASHSCOPE_API_KEY 注入） */
  apiKey: string;
  /** 远端模型标识（默认 qwen3.7-text-rerank） */
  model: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 是否让上游返回原文（return_documents），默认 false */
  returnDocuments: boolean;
  logger?: RerankLogger | null;
}

interface RerankResultItem {
  index?: number;
  relevance_score?: number;
}

interface RerankApiResponse {
  output?: { results?: RerankResultItem[] };
  results?: RerankResultItem[];
}

export class ApiRerankProvider implements RerankProvider {
  readonly kind: RerankProviderKind = 'api';
  readonly model: string;
  available: boolean;

  private readonly options: ApiRerankOptions;
  private readonly logger: RerankLogger | null;
  private initialized = false;

  constructor(options: ApiRerankOptions) {
    this.options = options;
    this.model = options.model;
    this.logger = options.logger ?? null;
    // 无 apiKey 时恒不可用，检索后不重排
    this.available = Boolean(options.apiKey);
  }

  /** 初始化（幂等）：校验关键配置并记录状态，不建立常驻连接 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.options.apiKey) {
      this.available = false;
      this.logger?.warn(
        '[rerank] api provider 未配置 DASHSCOPE_API_KEY，本次运行不做重排序',
      );
      return;
    }

    this.available = true;
    this.logger?.info(
      `[rerank] api provider ready：model=${this.model} base=${this.options.apiBase}`,
    );
  }

  /** 对候选文档重排；失败/超时/不可用统一返回空数组（调用方降级） */
  async rerank(query: string, docs: readonly string[]): Promise<RerankResult[]> {
    if (!this.available || docs.length === 0) return [];
    try {
      return await this.request(query, docs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`[rerank] 请求失败，本次保持 RRF 原序：${message}`);
      return [];
    }
  }

  /** 无连接池需要释放 */
  async close(): Promise<void> {
    this.available = false;
    this.initialized = false;
  }

  private async request(query: string, docs: readonly string[]): Promise<RerankResult[]> {
    const { apiBase, apiKey, model, timeoutMs } = this.options;
    const endpoint = apiBase.replace(/\/+$/, '');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.trunc(timeoutMs)));

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: { query, documents: [...docs] },
          // top_n 取候选总数：rag-pipeline 拿到完整重排序列后再自行 slice(finalK)
          parameters: {
            top_n: docs.length,
            return_documents: this.options.returnDocuments,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`rerank API 返回 ${response.status}：${detail.slice(0, 200)}`);
      }

      const payload = (await response.json()) as RerankApiResponse;
      const rawResults = payload?.output?.results ?? payload?.results ?? [];

      const normalized: RerankResult[] = [];
      for (const item of rawResults) {
        const index = Number(item?.index);
        // relevance_score 缺失（null/undefined）时丢弃该条，避免 Number(null)=0 把无分结果排到最前
        if (item?.relevance_score == null) continue;
        const score = Number(item.relevance_score);
        // 防御上游返回越界下标 / 非法数值，避免下游取值越界
        if (!Number.isInteger(index) || index < 0 || index >= docs.length) continue;
        if (!Number.isFinite(score)) continue;
        normalized.push({ index, score });
      }
      normalized.sort((a, b) => b.score - a.score);
      return normalized;
    } finally {
      clearTimeout(timer);
    }
  }
}
