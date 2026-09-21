/**
 * 文档用例：纯文本入库 -> ready、列表、详情、片段、删除级联、越权隔离、边界 id。
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

const TMP = makeTempDir('document');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('doc_a');
const userB = uniqueUsername('doc_b');
let tokenA = '';
let tokenB = '';
let docId = 0;
let chunkCount = 0;

async function registerAndLogin(username: string): Promise<string> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return login.body.data.token as string;
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  tokenA = await registerAndLogin(userA);
  tokenB = await registerAndLogin(userB);
});

after(async () => {
  await ctx.close();
});

test('纯文本入库到 ready 且切片数 > 0', async () => {
  // 约 600 字，必然切成多块（chunk=400 / overlap=80）
  const sentence = '知识库系统负责把散落文档变成可检索资产，支持全文与语义混合检索。';
  const content = sentence.repeat(20);

  const res = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '入库链路测试文档', content },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');

  const item = res.body.data.item;
  assert.ok(item.id > 0);
  assert.equal(item.status, 'ready');
  assert.equal(item.sourceType, 'text');
  assert.ok(item.chunkCount > 1, `chunkCount=${item.chunkCount}`);
  assert.ok(item.charCount > 0);

  docId = item.id;
  chunkCount = item.chunkCount;
});

test('文档列表可见', async () => {
  const res = await call('GET', '/api/documents', { token: tokenA });
  assert.equal(res.status, 200);
  const ids = (res.body.data.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(ids.includes(docId));
  assert.equal(res.body.data.total, res.body.data.items.length);
});

test('按 libraryId 过滤列表', async () => {
  const res = await call('GET', '/api/documents', { token: tokenA, query: { libraryId: 999999 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 0);
  assert.equal(res.body.data.total, 0);
});

test('文档详情可见', async () => {
  const res = await call('GET', `/api/documents/${docId}`, { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.id, docId);
  assert.equal(res.body.data.item.status, 'ready');
});

test('片段列表返回且与 chunkCount 一致', async () => {
  const res = await call('GET', `/api/documents/${docId}/chunks`, { token: tokenA });
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<{ seq: number; content: string }>;
  assert.equal(items.length, chunkCount);
  // seq 连续递增
  items.forEach((c, i) => assert.equal(c.seq, i));
});

test('B 越权读取 / 删除 A 的文档返回 404', async () => {
  const get = await call('GET', `/api/documents/${docId}`, { token: tokenB });
  assert.equal(get.status, 404);

  const del = await call('DELETE', `/api/documents/${docId}`, { token: tokenB });
  assert.equal(del.status, 404);
});

test('非数字 id 返回 400', async () => {
  const res = await call('GET', '/api/documents/abc', { token: tokenA });
  assert.equal(res.status, 400);
});

test('不存在的 id 返回 404', async () => {
  const res = await call('GET', '/api/documents/999999', { token: tokenA });
  assert.equal(res.status, 404);
});

test('删除后详情 404 且片段级联清空', async () => {
  const del = await call('DELETE', `/api/documents/${docId}`, { token: tokenA });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.removed, true);

  const after = await call('GET', `/api/documents/${docId}`, { token: tokenA });
  assert.equal(after.status, 404);

  // 片段表已级联清空
  const orphans = ctx.db.driver.all<{ c: number }>(
    'SELECT COUNT(*) AS c FROM chunks WHERE doc_id = ?',
    [docId],
  );
  assert.equal(Number(orphans[0]?.c ?? 0), 0);
});
