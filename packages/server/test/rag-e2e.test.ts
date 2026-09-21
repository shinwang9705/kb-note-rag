/**
 * 六期 QA 端到端验收：三挂载点实时生效 + 多用户隔离（走完整 app.inject + mock LLM/rerank）。
 *
 * 与工程师 rag-settings.test.ts 的差异：后者 rerank provider 恒不可用（NoneRerankProvider），
 * 从未覆盖「rerank 可用但用户关掉 enabled」的路径。本文件注入 mock rerank（available=true），
 * 独立证明：
 *   1. PATCH rag.search.topK 实时改变检索候选数；
 *   2. PATCH rag.rerank.enabled=false 实时停止精排（rerankScore 缺省、不再重排）；
 *   3. PATCH rag.context.topK 实时改变进生成片段数（rerank 关闭时）；
 *   4. PATCH rag.confidence.groundedScore 实时移动置信度三档判定边界；
 *   5. A 改 rag 配置不影响 B（B 仍返回默认）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAG_SETTINGS } from '@kb/shared';
import {
  makeTempDir,
  setTestEnv,
  makeCall,
  uniqueUsername,
  PASSWORD,
  type Caller,
} from './harness.ts';
import { NoneEmbeddingProvider } from '../src/embedding/none.ts';
import { ask } from '../src/service/chat.service.ts';
import type { RerankProvider, RerankResult } from '../src/rerank/types.ts';
import type { ModelGateway } from '../src/llm/router.ts';

const TMP = makeTempDir('rag-e2e');
setTestEnv(TMP);

// ---------------------------------------------------------------------------
// mock 组装
// ---------------------------------------------------------------------------

interface RerankMock {
  provider: RerankProvider;
  readonly calls: number;
  setResults(results: RerankResult[] | null): void;
}

function createRerankMock(available = true): RerankMock {
  const state = { calls: 0, results: null as RerankResult[] | null };
  const provider: RerankProvider = {
    kind: 'api',
    model: 'mock-reranker',
    available,
    init: async () => {},
    rerank: async (_query, docs) => {
      state.calls += 1;
      if (state.results) return state.results;
      // 默认：保持原序、分数递减，top1 恒有 rerankScore
      return docs.map((_, index) => ({ index, score: Number((1 - index * 0.03).toFixed(4)) }));
    },
    close: async () => {},
  };
  return {
    provider,
    get calls() {
      return state.calls;
    },
    setResults(results) {
      state.results = results;
    },
  };
}

function createGatewayMock(): ModelGateway {
  return {
    resolve: async () => ({
      providerId: 'deepseek',
      model: 'mock-model',
      profile: {},
      apiKey: 'mock-key',
      baseUrl: 'http://mock',
    }),
    chat: async () => ({ content: 'mock answer' }),
    chatStream: async function* () {
      yield { type: 'content_delta', text: 'mock' };
      yield { type: 'finish', finishReason: 'stop' };
    },
    testConnection: async () => ({ ok: true }),
    healthSnapshot: () => ({}),
  } as unknown as ModelGateway;
}

/** 与 harness.createTestApp 同构，额外注入 mock rerank + mock gateway */
async function createFullApp(rerank: RerankProvider, gateway: ModelGateway) {
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
  const app = await buildApp({ config, logger, db, startedAt: Date.now(), embedding, rerank, gateway });

  return {
    app: app as unknown as {
      inject: (o: unknown) => Promise<{ statusCode: number; payload: string }>;
      close: () => Promise<void>;
    },
    db,
    config,
    close: async () => {
      await app.close();
      closeDatabase();
    },
  };
}

async function registerAndLogin(call: Caller, username: string): Promise<{ token: string; id: number }> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.body.data.token as string, id: login.body.data.user.id as number };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TERM = '共同标记';
const DOC_COUNT = 45;

let rerankMock: RerankMock;
let ctx: Awaited<ReturnType<typeof createFullApp>>;
let call: Caller;
let tokenA = '';
let tokenB = '';
let userAId = 0;

before(async () => {
  rerankMock = createRerankMock(true);
  ctx = await createFullApp(rerankMock.provider, createGatewayMock());
  call = makeCall(ctx.app);

  const a = await registerAndLogin(call, uniqueUsername('rag_e2e_a'));
  tokenA = a.token;
  userAId = a.id;
  const b = await registerAndLogin(call, uniqueUsername('rag_e2e_b'));
  tokenB = b.token;

  // 45 篇短文档（各 1 个切片）都含 TERM，供 topK/context 计数观察
  for (let i = 1; i <= DOC_COUNT; i += 1) {
    const res = await call('POST', '/api/documents/text', {
      token: tokenA,
      payload: { title: `文档${i}号`, content: `第${i}篇，含${TERM}词汇，唯一标识 docnum${i}。` },
    });
    assert.equal(res.status, 200, `入库失败：${JSON.stringify(res.body)}`);
  }
});

after(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('实时生效：PATCH rag.search.topK=40 后检索候选数（stats.fts）变为 40，改 3 后变 3', async () => {
  const patch = await call('PATCH', '/api/settings', {
    token: tokenA,
    payload: { rag: { search: { topK: 40 } } },
  });
  assert.equal(patch.status, 200);
  assert.equal((patch.body.data.settings as Record<string, any>).rag.search.topK, 40);

  const after40 = await call('POST', '/api/search', { token: tokenA, payload: { query: TERM } });
  assert.equal(after40.status, 200);
  assert.equal(after40.body.data.stats.fts, 40, 'topK=40 -> FTS 候选 40');

  await call('PATCH', '/api/settings', { token: tokenA, payload: { rag: { search: { topK: 3 } } } });
  const after3 = await call('POST', '/api/search', { token: tokenA, payload: { query: TERM } });
  assert.equal(after3.body.data.stats.fts, 3, 'topK=3 -> FTS 候选 3');
});

test('多用户隔离：A 改 rag 配置，B 的 GET /api/settings 仍返回默认', async () => {
  // A 已把 topK 改到 3（上一条用例）；此处再确认 A 非默认、B 仍默认
  const gotA = await call('GET', '/api/settings', { token: tokenA });
  assert.notEqual(gotA.body.data.rag.search.topK, DEFAULT_RAG_SETTINGS.search.topK, 'A 已偏离默认');

  const gotB = await call('GET', '/api/settings', { token: tokenB });
  assert.equal(gotB.status, 200);
  assert.deepEqual(gotB.body.data.rag, DEFAULT_RAG_SETTINGS, 'B 不受 A 影响，仍默认');

  const statusB = await call('GET', '/api/rag/status', { token: tokenB });
  assert.equal(statusB.status, 200);
  assert.equal(statusB.body.data.effective.search.topK, DEFAULT_RAG_SETTINGS.search.topK);
});

test('rerank 可用且 enabled=true（默认）：ask() 来源携带 rerankScore 且确实调用 rerank', async () => {
  // 复位：确保 rerank 开启（上一条用例未改 rerank，此处防御性复位）
  await call('PATCH', '/api/settings', { token: tokenA, payload: { rag: { rerank: { enabled: true } } } });
  rerankMock.setResults(null);

  const callsBefore = rerankMock.calls;
  const result = await ask(
    {
      db: ctx.db as never,
      config: ctx.config as never,
      embedding: new NoneEmbeddingProvider(null),
      rerank: rerankMock.provider,
      gateway: createGatewayMock() as never,
    },
    { userId: userAId, query: TERM },
  );
  assert.equal(result.grounded, true);
  assert.ok(result.sources.length > 0, '应有引用来源');
  assert.ok('rerankScore' in result.sources[0]!, 'rerank 开启时应带 rerankScore');
  assert.ok(rerankMock.calls > callsBefore, 'rerank 应被调用');
});

test('实时生效：PATCH rag.rerank.enabled=false 后不再重排（rerankScore 缺省、rerank 不再调用）', async () => {
  await call('PATCH', '/api/settings', { token: tokenA, payload: { rag: { rerank: { enabled: false } } } });
  rerankMock.setResults(null);

  const callsBefore = rerankMock.calls;
  const result = await ask(
    {
      db: ctx.db as never,
      config: ctx.config as never,
      embedding: new NoneEmbeddingProvider(null),
      rerank: rerankMock.provider,
      gateway: createGatewayMock() as never,
    },
    { userId: userAId, query: TERM },
  );

  assert.equal(result.grounded, true);
  assert.ok(result.sources.length > 0);
  assert.ok(
    !('rerankScore' in result.sources[0]!),
    '关闭 rerank 后来源不应再携带 rerankScore（不再重排）',
  );
  assert.equal(rerankMock.calls, callsBefore, '关闭 rerank 后不应再调用 rerank provider');
});

test('实时生效：rerank 关闭时 PATCH rag.context.topK=8 使进生成片段数变为 8', async () => {
  await call('PATCH', '/api/settings', {
    token: tokenA,
    payload: { rag: { rerank: { enabled: false }, context: { topK: 8 } } },
  });

  const result = await ask(
    {
      db: ctx.db as never,
      config: ctx.config as never,
      embedding: new NoneEmbeddingProvider(null),
      rerank: rerankMock.provider,
      gateway: createGatewayMock() as never,
    },
    { userId: userAId, query: TERM },
  );
  assert.equal(result.grounded, true);
  assert.equal(result.sources.length, 8, 'context.topK=8 -> 进生成片段 8 条');
});

test('实时生效：PATCH rag.confidence.groundedScore 移动三档判定边界（0.8 由 grounded 变 partial）', async () => {
  // 重新开启 rerank，并让 mock 给 top1 打 0.8 分
  await call('PATCH', '/api/settings', {
    token: tokenA,
    payload: { rag: { rerank: { enabled: true }, confidence: { groundedScore: 0.5, partialScore: 0.25 } } },
  });
  rerankMock.setResults([
    { index: 0, score: 0.8 },
    { index: 1, score: 0.7 },
  ]);

  const chatCtx = {
    db: ctx.db as never,
    config: ctx.config as never,
    embedding: new NoneEmbeddingProvider(null),
    rerank: rerankMock.provider,
    gateway: createGatewayMock() as never,
  };

  const before = await ask(chatCtx, { userId: userAId, query: TERM });
  assert.equal(before.confidence, 'grounded', '默认阈值 0.5，top1=0.8 -> grounded');

  await call('PATCH', '/api/settings', {
    token: tokenA,
    payload: { rag: { confidence: { groundedScore: 0.9 } } },
  });

  const afterPatch = await ask(chatCtx, { userId: userAId, query: TERM });
  assert.equal(afterPatch.confidence, 'partial', '阈值上移 0.9 后 top1=0.8 -> partial');
});
