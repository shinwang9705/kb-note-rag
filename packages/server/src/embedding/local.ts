/**
 * 本地向量化实现（transformers.js / Xenova）。
 *
 * 为什么用**惰性动态 import**：
 *   - @xenova/transformers 体积大（含 onnxruntime 原生依赖），且首次运行要下载模型
 *   - 把它作为硬依赖会让 `npm install` 变慢，并在无网/无模型环境直接拖垮启动
 *   - 因此只在 EMBEDDING_PROVIDER=local 时才去 import；import 失败或模型加载失败
 *     一律降级为不可用（available=false），由检索层自动走纯关键词
 *
 * 启用方式（可选）：
 *   npm i @xenova/transformers -w @kb/server
 *   首次运行会从 HF_ENDPOINT 拉取模型到 EMBEDDING_CACHE_DIR
 */
import path from 'node:path';
import {
  normalizeVector,
  type EmbeddingLogger,
  type EmbeddingProvider,
  type EmbeddingProviderKind,
} from './types.js';

/** transformers.js 的 pipeline 最小可用形状（避免强依赖其类型） */
interface FeatureExtractionPipeline {
  (input: string[], options: Record<string, unknown>): Promise<{
    data: Float32Array | number[];
    dims: number[];
  }>;
}

interface TransformersModule {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<FeatureExtractionPipeline>;
  env: Record<string, unknown>;
}

export interface LocalEmbeddingOptions {
  model: string;
  dim: number;
  cacheDir: string;
  hfEndpoint: string;
  logger?: EmbeddingLogger | null;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly kind: EmbeddingProviderKind = 'local';
  readonly model: string;
  readonly dim: number;
  available = false;

  private readonly options: LocalEmbeddingOptions;
  private readonly logger: EmbeddingLogger | null;
  private pipe: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: LocalEmbeddingOptions) {
    this.options = options;
    this.model = options.model;
    this.dim = options.dim;
    this.logger = options.logger ?? null;
  }

  /** 初始化（重复调用只会真正执行一次） */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      // 用变量做 specifier：TypeScript 不会在依赖缺失时报错
      const specifier = '@xenova/transformers';
      const mod = (await import(specifier)) as unknown as TransformersModule;

      if (mod.env) {
        // 指向镜像站与本地缓存，避免每次都回源 huggingface.co
        if (this.options.hfEndpoint) {
          mod.env.remoteHost = this.options.hfEndpoint;
          mod.env.remotePathTemplate = '{model}/resolve/{revision}/';
        }
        mod.env.cacheDir = path.resolve(this.options.cacheDir);
        mod.env.allowLocalModels = true;
      }

      this.pipe = await mod.pipeline('feature-extraction', this.options.model, {
        quantized: true,
      });
      this.available = true;
      this.logger?.info(
        `[embedding] local provider ready：model=${this.options.model} dim=${this.dim}` +
          ` cache=${this.options.cacheDir}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.available = false;
      this.pipe = null;
      this.logger?.warn(
        `[embedding] local provider 初始化失败，降级为关键词检索：${message}。` +
          `如需语义检索请执行：npm i @xenova/transformers -w @kb/server（模型会下载到 ${this.options.cacheDir}）`,
      );
    }
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!this.available || !this.pipe || texts.length === 0) return [];
    try {
      const output = await this.pipe([...texts], { pooling: 'mean', normalize: true });
      return sliceMatrix(output, this.dim, texts.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn(`[embedding] embed 失败，本次不产出向量：${message}`);
      return [];
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    const vectors = await this.embed([text]);
    return vectors[0] ?? [];
  }

  async close(): Promise<void> {
    this.pipe = null;
    this.available = false;
    this.initPromise = null;
  }
}

/**
 * 把 transformers.js 返回的扁平张量切成 [n, dim]。
 * 不同版本返回的 dims 顺序不一致，这里按 dims 数组判断行主序。
 */
function sliceMatrix(
  output: { data: Float32Array | number[]; dims: number[] },
  dim: number,
  rows: number,
): number[][] {
  const data = output.data instanceof Float32Array ? Array.from(output.data) : output.data;
  const dims = output.dims ?? [rows, dim];
  const width = dims.length >= 2 ? dims[dims.length - 1] : dim;
  if (width !== dim || data.length !== rows * dim) throw new Error('模型向量维度与索引维度不一致，请检查配置并重建索引');
  const out: number[][] = [];
  for (let i = 0; i < rows; i += 1) {
    out.push(normalizeVector(data.slice(i * width, (i + 1) * width), dim));
  }
  return out;
}
