/**
 * 三期测试夹具：mock ModelGateway + 带网关注入的 app 装配。
 *
 * 目的：不依赖外网，用 mock 覆盖多轮对话 / 深度思考的 LLM 编排逻辑。
 * 本文件不以 *.test.ts 结尾，不会被 node --test 收集。
 *
 * 设计要点：
 *   - createMockGateway 返回一个可配置的 ModelGateway，并捕获所有 chatStream/chat 请求，
 *     便于断言「上下文装配是否正确」（多轮不丢历史、增量上下文等）；
 *   - createTestAppWithGateway 与 harness.createTestApp 同构，唯一点差异是注入 mock gateway，
 *     从而让 /api/conversations、/api/thinking 等路由走 mock 而非真实出网。
 */
import type { ModelGateway, GatewayRequest, ResolvedTarget } from '../src/llm/router.js';
import type { ChatStreamEvent, TokenUsage } from '../src/llm/catalog.js';
import type { NormalizedError } from '@kb/shared';

export type StreamFactory = (req: GatewayRequest, signal: AbortSignal) => AsyncIterable<ChatStreamEvent>;

export interface MockGatewayOptions {
  providerId?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** 按 chatStream 调用次序消费的事件序列（数组或工厂）；用尽后回退 defaultStream */
  streams?: Array<ChatStreamEvent[] | StreamFactory>;
  defaultStream?: StreamFactory;
  chatImpl?: (req: GatewayRequest) => Promise<{ content: string; usage?: TokenUsage }>;
  testImpl?: (providerId: string, apiKey: string, baseUrlOverride?: string) => Promise<{ ok: boolean; error?: NormalizedError }>;
  health?: Record<string, unknown>;
  /** resolve 直接失败（模拟无任何可用供应商 -> LLM_NOT_CONFIGURED） */
  noTarget?: boolean;
}

export interface MockGateway {
  gateway: ModelGateway;
  streamRequests: GatewayRequest[];
  chatRequests: GatewayRequest[];
  /** 追加一条「下一个 chatStream 调用」消费的流（FIFO；用尽后回退 defaultStream） */
  pushStream(stream: ChatStreamEvent[] | StreamFactory): void;
}

export function createMockGateway(opts: MockGatewayOptions = {}): MockGateway {
  const streamRequests: GatewayRequest[] = [];
  const chatRequests: GatewayRequest[] = [];
  const queue: Array<ChatStreamEvent[] | StreamFactory> = [...(opts.streams ?? [])];

  const defaultStream: StreamFactory =
    opts.defaultStream ??
    (async function* () {
      yield { type: 'content_delta', text: 'mock 回答' };
      yield { type: 'finish', finishReason: 'stop' };
    });

  const target: ResolvedTarget = {
    providerId: (opts.providerId ?? 'deepseek') as ResolvedTarget['providerId'],
    model: opts.model ?? 'deepseek-chat',
    profile: {} as ResolvedTarget['profile'],
    apiKey: opts.apiKey ?? 'mock-key',
    baseUrl: opts.baseUrl ?? 'http://mock.local',
  };

  const gateway: ModelGateway = {
    async resolve() {
      if (opts.noTarget) throw new Error('LLM_NOT_CONFIGURED');
      return target;
    },
    chatStream(req, signal) {
      streamRequests.push(req);
      const next = queue.shift();
      if (next === undefined) return defaultStream(req, signal);
      if (typeof next === 'function') return next(req, signal);
      return (async function* () {
        for (const event of next) yield event;
      })();
    },
    async chat(req) {
      chatRequests.push(req);
      if (opts.chatImpl) return opts.chatImpl(req);
      return { content: 'mock 回答' };
    },
    async testConnection(providerId, apiKey, baseUrlOverride) {
      if (opts.testImpl) return opts.testImpl(providerId, apiKey, baseUrlOverride);
      return { ok: true };
    },
    healthSnapshot() {
      return (opts.health ?? {}) as Record<string, { okRate: number; p95Ms: number; openUntil?: number }>;
    },
  };

  return {
    gateway,
    streamRequests,
    chatRequests,
    pushStream(stream) {
      queue.push(stream);
    },
  };
}

/** 与 harness.createTestApp 同构，唯一点差异：注入 mock gateway */
export async function createTestAppWithGateway(gateway: ModelGateway) {
  const { resetConfigCache, loadConfig } = await import('../src/config.ts');
  const { initDatabase, closeDatabase } = await import('../src/db/connection.ts');
  const { runMigrations } = await import('../src/db/migrate.ts');
  const { createLogger } = await import('../src/logger.ts');
  const { buildApp } = await import('../src/app.ts');
  const { initEmbeddingProvider } = await import('../src/embedding/index.ts');

  closeDatabase();
  resetConfigCache();

  const config = loadConfig({ reload: true });
  const logger = createLogger(config, { level: 'silent' });
  const db = await initDatabase(config);
  runMigrations(db, { embeddingDim: config.embedding.dim });
  const embedding = await initEmbeddingProvider({ config, logger: null });
  const app = await buildApp({ config, logger, db, startedAt: Date.now(), embedding, gateway });

  return {
    app: app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; payload: string }>; close: () => Promise<void> },
    db,
    config,
    close: async () => {
      await app.close();
      closeDatabase();
    },
  };
}

/** 构造一轮深度思考 XML 产物（对齐 prompts.ts 的标签结构） */
export function thinkingArtifact(
  round: number,
  opts: { hfi?: boolean; draft?: string; withTags?: boolean } = {},
): string {
  const hfi = opts.hfi ?? false;
  const draft = opts.draft ?? `第${round}轮草稿正文`;
  if (opts.withTags === false) return draft; // 降级③：无 <draft> -> 整段作 draft
  return [
    '<outline>',
    `- 要点${round}A`,
    `- 要点${round}B`,
    '</outline>',
    '<changes>',
    '- added|新要点|补充说明',
    '</changes>',
    '<score>',
    'clarity: 8',
    'coverage: 7',
    'evidence: 7',
    'concision: 8',
    '</score>',
    `<has_further_improvement>${hfi}</has_further_improvement>`,
    '<draft>',
    draft,
    '</draft>',
  ].join('\n');
}

/** 单段文本流（chat 模式）：content_delta + finish */
export function textStream(text: string): ChatStreamEvent[] {
  return [
    { type: 'content_delta', text },
    { type: 'finish', finishReason: 'stop' },
  ];
}

/** 单轮深度思考流：content_delta(整段 XML) + usage */
export function roundStream(text: string, usage?: TokenUsage): ChatStreamEvent[] {
  return [
    { type: 'content_delta', text },
    ...(usage ? [{ type: 'usage', usage } as ChatStreamEvent] : []),
  ];
}

/** 把 SSE 原始文本解析成事件对象数组 */
export function parseSse(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => {
      const json = chunk.slice(5).trim();
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch {
        return { raw: json } as Record<string, unknown>;
      }
    });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
