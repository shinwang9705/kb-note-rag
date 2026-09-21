/**
 * 四期 T03 补强：多文档交叉验证 + 置信度（integration，走 ask() 全链路）。
 *
 * 背景：computeConfidence 已由 confidence.test.ts 覆盖三档阈值（0.5/0.25 边界），
 *       但 computeCrossDoc 是 chat.service 内部非导出函数，只能通过 ask() 全链路验证。
 * 本文件补齐：
 *   1. crossDoc.conflict 兜底触发：docCount>=2 且两文档 rerank 分差 < 0.1 -> conflict=true；
 *   2. 标记优先：answer 含固定标记 -> conflict=true（即使分差较大）；
 *   3. 单文档命中：docCount=1、conflict=false。
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
import { ask, type ChatContext } from '../src/service/chat.service.ts';
import type { RerankProvider, RerankResult } from '../src/rerank/types.ts';

const TMP = makeTempDir('conf-integ');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let tokenA = '';
let userAId = 0;

const userA = uniqueUsername('conf_a');

async function registerAndLogin(username: string): Promise<{ token: string; id: number }> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.body.data.token as string, id: login.body.data.user.id as number };
}

function mockRerank(results: RerankResult[]): RerankProvider {
  return {
    kind: 'api',
    model: 'mock-reranker',
    available: true,
    init: async () => {},
    rerank: async () => results,
    close: async () => {},
  };
}

function makeGateway(answer: string) {
  return {
    resolve: async () => ({
      providerId: 'deepseek',
      model: 'mock-model',
      profile: {},
      apiKey: 'mock-key',
      baseUrl: 'http://mock',
    }),
    chat: async () => ({ content: answer }),
    chatStream: async function* () {
      yield { type: 'content_delta', text: answer };
      yield { type: 'finish', finishReason: 'stop' };
    },
    testConnection: async () => ({ ok: true }),
    healthSnapshot: () => ({}),
  };
}

function chatContext(answer: string, rerankResults: RerankResult[]): ChatContext {
  return {
    db: ctx.db as never,
    config: ctx.config as never,
    embedding: new NoneEmbeddingProvider(null),
    rerank: mockRerank(rerankResults),
    gateway: makeGateway(answer) as never,
  };
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  const a = await registerAndLogin(userA);
  tokenA = a.token;
  userAId = a.id;

  // 两篇文档都含「冲突测试词」，各自含唯一 ASCII 词；内容短于 CHUNK_SIZE -> 各 1 个切片
  const d1 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '文档甲', content: '冲突测试词：文档甲主张全量备份更安全。uniquetokA 出现于此。' },
  });
  assert.equal(d1.status, 200);

  const d2 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '文档乙', content: '冲突测试词：文档乙主张增量备份更高效。uniquetokB 出现于此。' },
  });
  assert.equal(d2.status, 200);
});

after(async () => {
  await ctx.close();
});

test('相近相关度不能推断事实冲突', async () => {
  const result = await ask(
    chatContext('这是一句不含冲突标记的普通回答。', [
      { index: 0, score: 0.55 },
      { index: 1, score: 0.52 },
    ]),
    { userId: userAId, query: '冲突测试词', topK: 5 },
  );

  assert.equal(result.grounded, true);
  assert.equal(result.confidence, 'grounded');
  assert.ok(result.crossDoc, '应返回 crossDoc 元数据');
  assert.equal(result.crossDoc!.docCount, 2);
  assert.equal(result.crossDoc!.conflict, false, '分差相近并不意味着事实冲突');
  assert.equal(result.crossDoc!.conflictSources, undefined);
});

test('标记优先：answer 含固定标记 -> conflict=true（即使分差较大）', async () => {
  const answer = '两份文档说法有出入。\n⚠️ 不同文档存在表述差异：文档甲；文档乙';
  const result = await ask(
    chatContext(answer, [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.1 },
    ]),
    { userId: userAId, query: '冲突测试词', topK: 5 },
  );

  assert.equal(result.grounded, true);
  assert.ok(result.crossDoc, '应返回 crossDoc 元数据');
  assert.equal(result.crossDoc!.docCount, 2);
  assert.equal(result.crossDoc!.conflict, true, '标记应优先判定 conflict');
});

test('单文档命中：docCount=1、conflict=false', async () => {
  const result = await ask(chatContext('单一来源的普通回答。', []), {
    userId: userAId,
    query: 'uniquetokA',
    topK: 5,
  });

  assert.equal(result.grounded, true);
  assert.ok(result.crossDoc, '应返回 crossDoc 元数据');
  assert.equal(result.crossDoc!.docCount, 1);
  assert.equal(result.crossDoc!.conflict, false);
});
