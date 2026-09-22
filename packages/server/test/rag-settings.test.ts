/**
 * RAG 设置用例（六期 T01）。
 *
 * 单元覆盖：
 *   1. 归一化 clamp：越界数值收敛到范围、defaultMode 非法回退 auto、字段缺失回退默认；
 *   2. 合并优先级：stored.rag > env 默认 > 代码常量默认；
 *   3. JSON 损坏降级：settings_json 解析失败 -> 全回退 env/默认；
 *   4. resolveRagParams：rerankEnabled = enabled && available，finalK = topK/context.topK 分支。
 *
 * 集成冒烟（app.inject）：
 *   5. GET /api/settings 返回含 rag 默认值；
 *   6. PATCH rag.search.topK=40 后 GET 回读 40；
 *   7. GET /api/rag/status 返回 effective/resolved/structuralHint。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAG_SETTINGS, RAG_RANGE } from '@kb/shared';
import { getRagSettings, normalizeRagSettings, ragStatus, resolveRagParams } from '../src/service/rag.service.ts';
import {
  makeTempDir,
  setTestEnv,
  createTestApp,
  makeCall,
  uniqueUsername,
  PASSWORD,
  type TestApp,
  type Caller,
} from './harness.ts';

// ---------------------------------------------------------------------------
// 单元测试：fakes（不依赖 DB / config 实例）
// ---------------------------------------------------------------------------

function makeDb(settingsJson: string | null) {
  return {
    driver: {
      get: () => (settingsJson === null ? undefined : { settings_json: settingsJson }),
    },
  };
}

function makeConfig() {
  return {
    search: { topK: 40, finalK: 12 },
    llm: { contextTopK: 6 },
    rerank: { topN: 25, topK: 7 },
    chunk: { size: 400, overlap: 80 },
  };
}

function makeRerank(available: boolean) {
  return { available };
}

test('normalizeRagSettings：越界数值 clamp 到范围', () => {
  const normalized = normalizeRagSettings({
    search: { topK: 999, finalK: -5, defaultMode: 'hybrid' },
    context: { topK: 60 },
    rerank: { enabled: false, topN: 0, topK: 500 },
    confidence: { groundedScore: 2, partialScore: -1 },
  });
  assert.equal(normalized.search.topK, RAG_RANGE.searchTopK.max);
  assert.equal(normalized.search.finalK, RAG_RANGE.searchFinalK.min);
  assert.equal(normalized.search.defaultMode, 'hybrid');
  assert.equal(normalized.context.topK, RAG_RANGE.contextTopK.max);
  assert.equal(normalized.rerank.enabled, false);
  assert.equal(normalized.rerank.topN, RAG_RANGE.rerankTopN.min);
  assert.equal(normalized.rerank.topK, RAG_RANGE.rerankTopK.max);
  assert.equal(normalized.confidence.groundedScore, RAG_RANGE.confidence.max);
  assert.equal(normalized.confidence.partialScore, RAG_RANGE.confidence.min);
});

test('normalizeRagSettings：defaultMode 非法值回退 auto', () => {
  const normalized = normalizeRagSettings({ search: { defaultMode: 'bogus' as never } });
  assert.equal(normalized.search.defaultMode, 'auto');
});

test('normalizeRagSettings：字段缺失回退默认值', () => {
  const normalized = normalizeRagSettings({});
  assert.deepEqual(normalized, DEFAULT_RAG_SETTINGS);
});

test('normalizeRagSettings：字段类型错误回退默认值', () => {
  const normalized = normalizeRagSettings({
    search: { topK: '40' as never },
    rerank: { enabled: 1 as never },
  });
  assert.equal(normalized.search.topK, DEFAULT_RAG_SETTINGS.search.topK);
  assert.equal(normalized.rerank.enabled, DEFAULT_RAG_SETTINGS.rerank.enabled);
});

test('getRagSettings：stored > env > 默认', () => {
  const db = makeDb(JSON.stringify({ rag: { search: { topK: 50 }, rerank: { enabled: false } } }));
  const rag = getRagSettings({ db, config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 50, 'stored 覆盖 env');
  assert.equal(rag.search.finalK, 12, '未存 finalK 用 env config.search.finalK');
  assert.equal(rag.context.topK, 6, '未存 context.topK 用 env config.llm.contextTopK');
  assert.equal(rag.rerank.topN, 25, '未存 rerank.topN 用 env config.rerank.topN');
  assert.equal(rag.rerank.topK, 7, '未存 rerank.topK 用 env config.rerank.topK');
  assert.equal(rag.rerank.enabled, false, 'stored 覆盖默认');
  assert.equal(rag.confidence.groundedScore, 0.5, '无 env 用代码常量默认');
});

test('getRagSettings：无 stored 时 env > 默认', () => {
  const db = makeDb(null);
  const rag = getRagSettings({ db, config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 40);
  assert.equal(rag.search.finalK, 12);
  assert.equal(rag.context.topK, 6);
  assert.equal(rag.rerank.topN, 25);
  assert.equal(rag.rerank.topK, 7);
  assert.equal(rag.rerank.enabled, true, '默认 enabled=true');
});

test('getRagSettings：settings_json 损坏降级为 env/默认', () => {
  const db = makeDb('{invalid json');
  const rag = getRagSettings({ db, config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 40, '回退 env');
  assert.equal(rag.rerank.enabled, true, '回退默认');
});

test('resolveRagParams：rerank 可用时 finalK=rerank.topK', () => {
  const params = resolveRagParams(
    { db: makeDb(null), config: makeConfig(), rerank: makeRerank(true) } as never,
    1,
  );
  assert.equal(params.rerankEnabled, true);
  assert.equal(params.topN, 25);
  assert.equal(params.finalK, 7, 'rerank.topK');
  assert.equal(params.searchTopK, 40);
  assert.equal(params.searchFinalK, 12);
  assert.equal(params.searchMode, 'auto');
});

test('resolveRagParams：用户关闭 rerank 时 finalK=context.topK', () => {
  const params = resolveRagParams(
    {
      db: makeDb(JSON.stringify({ rag: { rerank: { enabled: false } } })),
      config: makeConfig(),
      rerank: makeRerank(true),
    } as never,
    1,
  );
  assert.equal(params.rerankEnabled, false);
  assert.equal(params.finalK, 6, 'context.topK');
});

test('resolveRagParams：provider 不可用时 finalK=context.topK', () => {
  const params = resolveRagParams(
    { db: makeDb(null), config: makeConfig(), rerank: makeRerank(false) } as never,
    1,
  );
  assert.equal(params.rerankEnabled, false);
  assert.equal(params.finalK, 6, 'context.topK');
});

test('ragStatus：默认态 structuralHint 为空', () => {
  const status = ragStatus(
    {
      db: { driver: { get: () => undefined }, vecAvailable: true },
      config: makeConfig(),
      embedding: { kind: 'local', model: 'Xenova/bge-small-zh-v1.5', available: true, dim: 512 },
      rerank: { kind: 'api', model: 'qwen3.7-text-rerank', available: true },
    } as never,
    1,
  );
  assert.deepEqual(status.structuralHint, []);
});

test('ragStatus：结构级偏离默认时给出对应提示', () => {
  const status = ragStatus(
    {
      db: { driver: { get: () => undefined }, vecAvailable: false },
      config: { ...makeConfig(), chunk: { size: 600, overlap: 100 } },
      embedding: { kind: 'none', model: 'none', available: false, dim: 512 },
      rerank: { kind: 'none', model: 'none', available: false },
    } as never,
    1,
  );
  assert.ok(status.structuralHint.includes('Embedding 当前不可用，检索将自动降级为关键词模式'));
  assert.ok(status.structuralHint.includes('Rerank 当前不可用，候选证据将保持召回顺序'));
  assert.ok(status.structuralHint.includes('分块规则已自定义；新文档立即生效，已有文档需重建索引'));
  assert.ok(status.structuralHint.includes('语义检索不可用：sqlite-vec 未装载'));
});

// ---------------------------------------------------------------------------
// 集成冒烟：走完整 app（Fastify inject）
// ---------------------------------------------------------------------------

const TMP = makeTempDir('rag-settings');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let token = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const reg = await call('POST', '/api/auth/register', {
    payload: { username: uniqueUsername('rag_set'), password: PASSWORD },
  });
  assert.equal(reg.status, 200);
  token = reg.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('GET /api/settings 返回含 rag 默认值', async () => {
  const res = await call('GET', '/api/settings', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.rag, DEFAULT_RAG_SETTINGS);
});

test('PATCH rag.search.topK=40 后 GET 回读 40，未覆盖字段保留', async () => {
  const patch = await call('PATCH', '/api/settings', {
    token,
    payload: { rag: { search: { topK: 40 } } },
  });
  assert.equal(patch.status, 200);
  const s = patch.body.data.settings as Record<string, any>;
  assert.equal(s.rag.search.topK, 40);
  assert.equal(s.rag.search.finalK, DEFAULT_RAG_SETTINGS.search.finalK, '未覆盖 finalK 应保留默认');

  const got = await call('GET', '/api/settings', { token });
  assert.equal(got.status, 200);
  assert.equal(got.body.data.rag.search.topK, 40);
});

test('GET /api/rag/status 返回 effective/resolved/structuralHint', async () => {
  const res = await call('GET', '/api/rag/status', { token });
  assert.equal(res.status, 200);
  const data = res.body.data as Record<string, any>;
  assert.ok(data.effective, '应返回 effective');
  assert.ok(data.resolved, '应返回 resolved');
  assert.ok(Array.isArray(data.structuralHint), '应返回 structuralHint 数组');
  assert.equal(typeof data.vecAvailable, 'boolean');
  assert.ok(data.embedding, '应返回 embedding 结构级状态');
  assert.ok(data.rerankProvider, '应返回 rerankProvider 结构级状态');
  assert.equal(data.chunk.size, 400);
  assert.equal(data.resolved.rerankEnabled, false, '测试环境无 rerank provider，rerankEnabled 应为 false');
});

test('未登录访问 /api/rag/status 返回 401', async () => {
  const res = await call('GET', '/api/rag/status');
  assert.equal(res.status, 401);
});
