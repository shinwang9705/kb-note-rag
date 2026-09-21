/**
 * 知识库用例：创建 / 列表 / 详情 / 删除 / 多用户硬隔离 / 边界 id。
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

const TMP = makeTempDir('library');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('lib_a');
const userB = uniqueUsername('lib_b');
let tokenA = '';
let tokenB = '';
let libId = 0;

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

test('A 创建知识库成功', async () => {
  const res = await call('POST', '/api/libraries', {
    token: tokenA,
    payload: { name: 'A的知识库', description: '测试用' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.ok(res.body.data.item.id > 0);
  assert.equal(res.body.data.item.name, 'A的知识库');
  libId = res.body.data.item.id;
});

test('同名知识库返回 409', async () => {
  const res = await call('POST', '/api/libraries', {
    token: tokenA,
    payload: { name: 'A的知识库' },
  });
  assert.equal(res.status, 409);
});

test('A 的列表包含自己创建的库', async () => {
  const res = await call('GET', '/api/libraries', { token: tokenA });
  assert.equal(res.status, 200);
  const ids = (res.body.data.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(ids.includes(libId));
  assert.equal(res.body.data.total, res.body.data.items.length);
});

test('B 的列表不含 A 的库', async () => {
  const res = await call('GET', '/api/libraries', { token: tokenB });
  assert.equal(res.status, 200);
  const ids = (res.body.data.items as Array<{ id: number }>).map((i) => i.id);
  assert.ok(!ids.includes(libId));
});

test('B 越权 GET A 的库返回 404', async () => {
  const res = await call('GET', `/api/libraries/${libId}`, { token: tokenB });
  assert.equal(res.status, 404);
});

test('B 越权 DELETE A 的库返回 404', async () => {
  const res = await call('DELETE', `/api/libraries/${libId}`, { token: tokenB });
  assert.equal(res.status, 404);
});

test('A 读取自己的库返回 200', async () => {
  const res = await call('GET', `/api/libraries/${libId}`, { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.item.id, libId);
});

test('非数字 id 返回 400', async () => {
  const res = await call('GET', '/api/libraries/abc', { token: tokenA });
  assert.equal(res.status, 400);
});

test('不存在的 id 返回 404', async () => {
  const res = await call('GET', '/api/libraries/999999', { token: tokenA });
  assert.equal(res.status, 404);
});

test('A 删除自己的库后详情 404', async () => {
  const del = await call('DELETE', `/api/libraries/${libId}`, { token: tokenA });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.removed, true);

  const res = await call('GET', `/api/libraries/${libId}`, { token: tokenA });
  assert.equal(res.status, 404);
});
