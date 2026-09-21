/**
 * RAG 问答用例（二期 S1）。
 *
 * 覆盖：
 *   1. 检索无命中 -> grounded:false、answer=固定话术、不调 LLM（不编造）；
 *   2. 有命中但 LLM 未配置 -> 404 LLM_NOT_CONFIGURED；
 *   3. GET /api/chat/status 降级为 enabled:false；
 *   4. 多用户隔离：B 问不到 A 的文档；
 *   5. mock LLM 验证 grounded:true 主链路与 askStream 流式（不依赖外网）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
import { NoneEmbeddingProvider } from '../src/embedding/none.ts';
import { NoneRerankProvider } from '../src/rerank/none.ts';
import { ask, askStream } from '../src/service/chat.service.ts';

const TMP = makeTempDir('chat');
setTestEnv(TMP);
// 关键：强制 LLM=none，避免 .env 里 deepseek 配置串味（虽然 harness 注入的是 NoneLlmProvider）
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('chat_a');
const userB = uniqueUsername('chat_b');
let tokenA = '';
let tokenB = '';
let userAId = 0;

async function registerAndLogin(username: string): Promise<{ token: string; id: number }> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.body.data.token as string, id: login.body.data.user.id as number };
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  const a = await registerAndLogin(userA);
  const b = await registerAndLogin(userB);
  tokenA = a.token;
  userAId = a.id;
  tokenB = b.token;

  // A 入库一篇含独特关键词的文档
  const res = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '数据备份与恢复', content: '数据备份策略分为全量备份、增量备份与差异备份三种。' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.status, 'ready');
});

after(async () => {
  await ctx.close();
});

test('检索无命中：/api/chat 返回 grounded:false 且 answer 为固定话术、不调 LLM', async () => {
  const res = await call('POST', '/api/chat', {
    token: tokenA,
    payload: { query: '一个绝对不存在的词条xyzzzz' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.grounded, false);
  assert.equal(res.body.data.answer, '未在你的知识库中找到依据');
  assert.equal(res.body.data.model, '');
  assert.deepEqual(res.body.data.sources, []);
});

test('有命中但 LLM 未配置：/api/chat 返回 404 LLM_NOT_CONFIGURED', async () => {
  const res = await call('POST', '/api/chat', {
    token: tokenA,
    payload: { query: '备份策略' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'LLM_NOT_CONFIGURED');
});

test('GET /api/chat/status 返回 enabled:false（provider=none）', async () => {
  const res = await call('GET', '/api/chat/status', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.enabled, false);
  assert.equal(res.body.data.provider, 'none');
  assert.equal(res.body.data.model, 'none');
});

test('多用户隔离：B 用 A 文档的命中词提问，grounded:false', async () => {
  const res = await call('POST', '/api/chat', {
    token: tokenB,
    payload: { query: '备份策略' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.grounded, false);
});

test('未登录调用 /api/chat 返回 401', async () => {
  const res = await call('POST', '/api/chat', { payload: { query: '备份策略' } });
  assert.equal(res.status, 401);
});

test('SSE 无命中：/api/chat/stream 发 done 帧且 grounded:false', async () => {
  const res = await call('POST', '/api/chat/stream', {
    token: tokenA,
    payload: { query: '一个绝对不存在的词条xyzzzz' },
  });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.raw === 'string', 'SSE 应为文本流');
  assert.ok(res.body.raw.includes('"type":"done"'), `应含 done 帧：${res.body.raw}`);
  assert.ok(res.body.raw.includes('"grounded":false'), `done 帧应 grounded:false：${res.body.raw}`);
});

test('SSE 有命中但 LLM 未配置：/api/chat/stream 发 error 帧（LLM_NOT_CONFIGURED）', async () => {
  const res = await call('POST', '/api/chat/stream', {
    token: tokenA,
    payload: { query: '备份策略' },
  });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.raw === 'string', 'SSE 应为文本流');
  assert.ok(res.body.raw.includes('"type":"error"'), `应含 error 帧：${res.body.raw}`);
  assert.ok(res.body.raw.includes('LLM_NOT_CONFIGURED'), `error 帧应带 LLM_NOT_CONFIGURED：${res.body.raw}`);
});

// ---------- mock gateway：验证 grounded:true 主链路与流式（不依赖外网） ----------
const mockGateway = {
  resolve: async () => ({
    providerId: 'deepseek',
    model: 'mock-model',
    profile: {},
    apiKey: 'mock-key',
    baseUrl: 'http://mock',
  }),
  chat: async () => ({ content: '根据资料，答案是 Mock 回答。' }),
  chatStream: async function* () {
    yield { type: 'content_delta', text: '根据资料' };
    yield { type: 'content_delta', text: '，答案是 Mock。' };
    yield { type: 'finish', finishReason: 'stop' };
  },
  testConnection: async () => ({ ok: true }),
  healthSnapshot: () => ({}),
};

function chatContext() {
  return {
    db: ctx.db as never,
    config: ctx.config as never,
    embedding: new NoneEmbeddingProvider(null),
    rerank: new NoneRerankProvider(null),
    gateway: mockGateway as never,
  };
}

test('mock LLM：有命中时 ask() 返回 grounded:true + 引用来源 + model', async () => {
  const result = await ask(chatContext() as never, { userId: userAId, query: '备份策略', topK: 5 });
  assert.equal(result.grounded, true);
  assert.equal(result.answer, '根据资料，答案是 Mock 回答。');
  assert.equal(result.model, 'mock-model');
  assert.ok(result.sources.length > 0, '应返回引用来源');
  for (const source of result.sources) {
    assert.ok(typeof source.docTitle === 'string' && source.docId > 0, '引用来源应含 docId/docTitle');
  }
});

test('mock LLM：askStream() 逐段回调增量并返回完整 answer', async () => {
  const deltas: string[] = [];
  const result = await askStream(
    chatContext() as never,
    { userId: userAId, query: '备份策略', topK: 5 },
    (delta) => {
      if (delta !== null) deltas.push(delta);
    },
  );
  assert.equal(result.grounded, true);
  assert.equal(result.answer, '根据资料，答案是 Mock。');
  assert.deepEqual(deltas, ['根据资料', '，答案是 Mock。']);
});
