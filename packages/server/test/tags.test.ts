/**
 * 五期 §5.2 标签收藏用例：标签 CRUD + 覆盖式 set + 收藏置顶 + 按标签/收藏筛选 + 越权隔离。
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

const TMP = makeTempDir('tags');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('tags_a');
const userB = uniqueUsername('tags_b');
let tokenA = '';
let tokenB = '';
let docId1 = 0;
let docId2 = 0;
let tagA = 0;

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

test('创建标签（CRUD-create）', async () => {
  const res = await call('POST', '/api/documents/tags', { token: tokenA, payload: { name: '重要' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.ok(res.body.data.item.id > 0);
  tagA = res.body.data.item.id;
});

test('重复创建同名标签幂等返回既有', async () => {
  const res = await call('POST', '/api/documents/tags', { token: tokenA, payload: { name: '重要' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.id, tagA);
});

test('列出标签（CRUD-read）', async () => {
  const res = await call('GET', '/api/documents/tags', { token: tokenA });
  assert.equal(res.status, 200);
  const names = (res.body.data.items as Array<{ name: string }>).map((t) => t.name);
  assert.ok(names.includes('重要'));
});

test('删除标签（CRUD-delete）', async () => {
  const created = await call('POST', '/api/documents/tags', { token: tokenA, payload: { name: '临时' } });
  const tmpId = created.body.data.item.id as number;
  const del = await call('DELETE', `/api/documents/tags/${tmpId}`, { token: tokenA });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.removed, true);
});

test('入库两个文档并覆盖式设置标签', async () => {
  const r1 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '标签测试文档一', content: '这是关于数据备份与恢复的内容。'.repeat(5) },
  });
  docId1 = r1.body.data.item.id as number;

  const r2 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '标签测试文档二', content: '这是关于向量检索与混合召回的内容。'.repeat(5) },
  });
  docId2 = r2.body.data.item.id as number;

  const set = await call('POST', `/api/documents/${docId1}/tags`, { token: tokenA, payload: { tagIds: [tagA] } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.tags, ['重要']);
});

test('按标签筛选列表（DTO 带 tags/isFavorite）', async () => {
  const res = await call('GET', '/api/documents', { token: tokenA, query: { tagId: tagA } });
  assert.equal(res.status, 200);
  const ids = (res.body.data.items as Array<{ id: number }>).map((d) => d.id);
  assert.ok(ids.includes(docId1));
  assert.ok(!ids.includes(docId2));

  const d1 = (res.body.data.items as Array<{ id: number; tags: string[]; isFavorite: boolean }>).find(
    (d) => d.id === docId1,
  );
  assert.ok(d1);
  assert.deepEqual(d1.tags, ['重要']);
  assert.equal(d1.isFavorite, false);
});

test('收藏置顶（收藏的较旧文档排最前）', async () => {
  await call('PATCH', `/api/documents/${docId1}/favorite`, { token: tokenA, payload: { isFavorite: true } });
  const res = await call('GET', '/api/documents', { token: tokenA });
  const ids = (res.body.data.items as Array<{ id: number }>).map((d) => d.id);
  assert.equal(ids[0], docId1);
});

test('仅收藏筛选', async () => {
  const res = await call('GET', '/api/documents', { token: tokenA, query: { favorite: 'true' } });
  const ids = (res.body.data.items as Array<{ id: number }>).map((d) => d.id);
  assert.ok(ids.includes(docId1));
  assert.ok(!ids.includes(docId2));
});

test('取消收藏', async () => {
  const res = await call('PATCH', `/api/documents/${docId1}/favorite`, { token: tokenA, payload: { isFavorite: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.isFavorite, false);
});

test('覆盖式 set：二次设置替换旧标签', async () => {
  const created = await call('POST', '/api/documents/tags', { token: tokenA, payload: { name: '待办' } });
  const tagB = created.body.data.item.id as number;
  await call('POST', `/api/documents/${docId1}/tags`, { token: tokenA, payload: { tagIds: [tagB] } });
  const res = await call('GET', `/api/documents/${docId1}`, { token: tokenA });
  assert.deepEqual(res.body.data.item.tags, ['待办']);
});

test('越权隔离：B 看不到/改不了 A 的标签与文档', async () => {
  const set = await call('POST', `/api/documents/${docId1}/tags`, { token: tokenB, payload: { tagIds: [tagA] } });
  assert.equal(set.status, 404);

  const del = await call('DELETE', `/api/documents/tags/${tagA}`, { token: tokenB });
  assert.equal(del.status, 404);

  const list = await call('GET', '/api/documents/tags', { token: tokenB });
  assert.equal(list.body.data.items.length, 0);
});

test('覆盖式 set 只接受本人标签（跨用户 tag id 被忽略）', async () => {
  const bTag = await call('POST', '/api/documents/tags', { token: tokenB, payload: { name: 'B标签' } });
  const bTagId = bTag.body.data.item.id as number;
  const bDoc = await call('POST', '/api/documents/text', {
    token: tokenB,
    payload: { title: 'B 的文档', content: '这是 B 的内容。'.repeat(10) },
  });
  const bDocId = bDoc.body.data.item.id as number;

  const set = await call('POST', `/api/documents/${bDocId}/tags`, {
    token: tokenB,
    payload: { tagIds: [tagA, bTagId] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data.tags, ['B标签']);
});
