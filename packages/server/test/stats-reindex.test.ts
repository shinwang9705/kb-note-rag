/**
 * 用量看板 / 索引健康 / 全量重建 / meta 补充字段用例（二期 S4 / OPS-05 / IDX-06 / IDX-07）。
 *
 * 覆盖：GET /api/stats/usage、GET /api/admin/stats、GET /api/documents/stats（vecCoverage 0..1）；
 *       POST /api/reindex（本人）、POST /api/admin/reindex（admin）、普通用户调 admin 接口 403；
 *       /api/meta 的 llmEnabled/llmProvider/llmModel/storageBytes/storageQuotaBytes。
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
import { hashPassword } from '../src/util/crypto.ts';
import { createUser } from '../src/repo/user.repo.ts';

const TMP = makeTempDir('stats');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

const ADMIN_PASSWORD = 'AdminPass123!';
const GIB = 1024 * 1024 * 1024;

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('stats_a');
const userB = uniqueUsername('stats_b');
const adminName = uniqueUsername('stats_root');
let tokenA = '';
let tokenB = '';
let tokenAdmin = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;

  // A 建两篇文档
  for (const [title, content] of [
    ['用量看板文档一', '用量看板统计个人文档数、存储占用与近七日检索次数。'],
    ['用量看板文档二', '索引健康统计片段总数与向量覆盖比例。'],
  ]) {
    const res = await call('POST', '/api/documents/text', { token: tokenA, payload: { title, content } });
    assert.equal(res.status, 200);
  }

  const passwordHash = await hashPassword(ADMIN_PASSWORD);
  createUser(ctx.db as never, { username: adminName, passwordHash, role: 'admin', status: 'active' });
  const login = await call('POST', '/api/auth/login', { payload: { username: adminName, password: ADMIN_PASSWORD } });
  assert.equal(login.status, 200);
  tokenAdmin = login.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('GET /api/stats/usage 返回个人用量与配额', async () => {
  const res = await call('GET', '/api/stats/usage', { token: tokenA });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.docCount >= 2);
  assert.ok(res.body.data.storageBytes > 0);
  assert.equal(res.body.data.docQuota, 500);
  assert.equal(res.body.data.storageQuotaBytes, 2 * GIB);
  assert.ok(typeof res.body.data.taskSuccessRate === 'number');
});

test('GET /api/documents/stats 返回索引健康且 vecCoverage 在 [0,1]', async () => {
  const res = await call('GET', '/api/documents/stats', { token: tokenA });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.docTotal >= 2);
  assert.ok(res.body.data.docReady >= 2);
  assert.ok(res.body.data.chunkTotal > 0);
  assert.equal(res.body.data.vecCovered, 0, 'EMBEDDING_PROVIDER=none 时无向量');
  const cov = res.body.data.vecCoverage as number;
  assert.ok(cov >= 0 && cov <= 1, `vecCoverage=${cov}`);
});

test('普通用户调 GET /api/admin/stats 返回 403', async () => {
  const res = await call('GET', '/api/admin/stats', { token: tokenA });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('admin 调 GET /api/admin/stats 返回全局用量', async () => {
  const res = await call('GET', '/api/admin/stats', { token: tokenAdmin });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.userCount >= 3);
  assert.ok(res.body.data.docCount >= 2);
  assert.ok(res.body.data.storageBytes > 0);
});

test('POST /api/reindex 重建本人索引', async () => {
  const res = await call('POST', '/api/reindex', { token: tokenA, payload: {} });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.docs >= 2);
  assert.equal(res.body.data.reindexed, res.body.data.docs, '本人全部 ready 文档应重建成功');
  assert.equal((res.body.data.failed as unknown[]).length, 0);
});

test('普通用户调 POST /api/admin/reindex 返回 403', async () => {
  const res = await call('POST', '/api/admin/reindex', { token: tokenA, payload: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('admin 调 POST /api/admin/reindex 全量重建', async () => {
  const res = await call('POST', '/api/admin/reindex', { token: tokenAdmin, payload: {} });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.docs >= 2);
  assert.equal(res.body.data.reindexed, res.body.data.docs);
});

test('/api/meta 补充字段 llmEnabled/llmProvider/llmModel/storageBytes/storageQuotaBytes', async () => {
  const res = await call('GET', '/api/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.llmEnabled, false);
  assert.equal(res.body.data.llmProvider, 'none');
  assert.equal(res.body.data.llmModel, 'none');
  assert.ok(typeof res.body.data.storageBytes === 'number');
  assert.equal(res.body.data.storageQuotaBytes, 2 * GIB);
});
