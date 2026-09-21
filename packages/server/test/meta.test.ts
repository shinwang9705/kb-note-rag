/**
 * 元信息用例：健康检查 / 应用元信息 / 检索模式（含鉴权）。
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

const TMP = makeTempDir('meta');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let token = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const username = uniqueUsername('meta');
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  token = reg.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('GET /api/health 返回 ok（不鉴权）', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.equal(res.body.data.status, 'ok');
  assert.equal(res.body.data.db, 'up');
  assert.ok(typeof res.body.data.uptimeSec === 'number');
});

test('GET /api/meta 返回应用元信息（不鉴权）', async () => {
  const res = await call('GET', '/api/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.ok(['keyword', 'hybrid', 'vector'].includes(res.body.data.searchMode));
  assert.equal(res.body.data.embeddingProvider, 'none');
  assert.equal(res.body.data.allowRegister, true);
  assert.ok(res.body.data.limits && res.body.data.limits.maxDocumentsPerUser > 0);
});

test('GET /api/search/mode 未登录返回 401', async () => {
  const res = await call('GET', '/api/search/mode');
  assert.equal(res.status, 401);
});

test('GET /api/search/mode 登录后返回 keyword 与降级信息', async () => {
  const res = await call('GET', '/api/search/mode', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.equal(res.body.data.mode, 'keyword');
  assert.equal(res.body.data.embeddingProvider, 'none');
  assert.equal(res.body.data.embeddingAvailable, false);
  assert.equal(res.body.data.vectorReady, false);
});
