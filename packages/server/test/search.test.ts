/**
 * 检索用例：关键词召回、短词 LIKE 兜底、空查询、未登录、多用户隔离、
 *           NoneEmbeddingProvider 降级为 keyword 且不报错。
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

const TMP = makeTempDir('search');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('sea_a');
const userB = uniqueUsername('sea_b');
let tokenA = '';
let tokenB = '';

const DOC_BACKUP = `# 数据备份与恢复
数据备份与恢复策略说明如下。备份策略分为全量备份、增量备份与差异备份三种。
全量备份每周日执行一次，增量备份每小时执行一次。
恢复演练每季度进行一次，验证恢复点目标与恢复时间目标是否达标。
本知识库支持全文检索与语义检索两种模式。`;

const DOC_VECTOR = `# 向量检索原理
向量检索把文本映射成稠密向量，再通过余弦相似度或内积召回候选片段。
本项目使用 sqlite-vec 扩展提供的 vec0 虚表存放向量。`;

async function registerAndLogin(username: string): Promise<string> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return login.body.data.token as string;
}

async function ingestText(token: string, title: string, content: string): Promise<void> {
  const res = await call('POST', '/api/documents/text', { token, payload: { title, content } });
  assert.equal(res.status, 200, `入库失败：${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.item.status, 'ready');
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  tokenA = await registerAndLogin(userA);
  tokenB = await registerAndLogin(userB);

  await ingestText(tokenA, '数据备份与恢复', DOC_BACKUP);
  await ingestText(tokenA, '向量检索原理', DOC_VECTOR);
});

after(async () => {
  await ctx.close();
});

test('3 字以上中文关键词有结果（FTS 通道）', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '备份策略', finalK: 10 },
  });
  assert.equal(res.status, 200);
  const hits = res.body.data.hits as Array<{ docTitle: string }>;
  assert.ok(hits.length > 0, '应召回至少一条');
  assert.ok(hits.some((h) => h.docTitle.includes('数据备份与恢复')));
  assert.ok(res.body.data.stats.fts > 0);
});

test('2 字中文短词「向量」LIKE 兜底有结果', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '向量', finalK: 10 },
  });
  assert.equal(res.status, 200);
  const hits = res.body.data.hits as Array<{ docTitle: string }>;
  assert.ok(hits.length > 0, 'LIKE 兜底应有结果');
  assert.equal(res.body.data.fallbackLike, true);
});

test('1 字中文短词「库」有结果', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '库', finalK: 10 },
  });
  assert.equal(res.status, 200);
  const hits = res.body.data.hits as unknown[];
  assert.ok(hits.length > 0);
});

test('空查询返回 400', async () => {
  const res = await call('POST', '/api/search', { token: tokenA, payload: { query: '   ' } });
  assert.equal(res.status, 400);
});

test('未登录调用检索返回 401', async () => {
  const res = await call('POST', '/api/search', { payload: { query: '备份策略' } });
  assert.equal(res.status, 401);
});

test('B 用户搜不到 A 的文档（hits=0）', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenB,
    payload: { query: '备份策略', finalK: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal((res.body.data.hits as unknown[]).length, 0);
});

test('NoneEmbeddingProvider 下检索仍 200 且 mode=keyword（降级不报错）', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '备份策略', finalK: 10 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.mode, 'keyword');
});

test('GET /api/search 便捷入口可用', async () => {
  const res = await call('GET', '/api/search', { token: tokenA, query: { q: '恢复演练' } });
  assert.equal(res.status, 200);
  assert.ok((res.body.data.hits as unknown[]).length > 0);
});

test('GET /api/search/mode 返回 keyword（鉴权后）', async () => {
  const res = await call('GET', '/api/search/mode', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.mode, 'keyword');
  assert.equal(res.body.data.embeddingProvider, 'none');
  assert.equal(res.body.data.vectorReady, false);
});
