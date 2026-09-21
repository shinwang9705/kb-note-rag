/**
 * 多厂商接入用例（三期 T04）。
 *
 * 覆盖（对照 P0-02 / 条款 1）：
 *   1. 能力目录：GET /api/providers 返回 4 家内置厂商及模型；
 *   2. 凭据密文：PUT 凭据后 DB 中无明文 Key，AES-256-GCM 可解密，maskedKey 只露尾 4 位；
 *   3. 连通性测试：有效 Key -> ok:true；无效 Key -> ok:false + 归一化错误；
 *   4. 越权隔离：B 看不到 A 的凭据（configured=false / maskedKey=null），B DELETE 不影响 A；
 *   5. 未知供应商 -> 404。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, setTestEnv, makeCall, uniqueUsername, PASSWORD, type Caller } from './harness.ts';
import { createMockGateway, createTestAppWithGateway, type MockGateway } from './mock-gateway.ts';
import { decryptSecret } from '../src/util/secret-crypto.js';

const TMP = makeTempDir('providers');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let mock: MockGateway;
let ctx: Awaited<ReturnType<typeof createTestAppWithGateway>>;
let call: Caller;

const userA = uniqueUsername('prv_a');
const userB = uniqueUsername('prv_b');
let tokenA = '';
let tokenB = '';
let userIdA = 0;

before(async () => {
  mock = createMockGateway({
    testImpl: async (_pid, apiKey) =>
      apiKey === 'bad-key'
        ? { ok: false, error: { kind: 'auth', userMessage: '密钥无效', retryable: false } }
        : { ok: true },
  });
  ctx = await createTestAppWithGateway(mock.gateway);
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  userIdA = regA.body.data.user.id as number;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('能力目录：返回 4 家内置厂商及模型', async () => {
  const res = await call('GET', '/api/providers', { token: tokenA });
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<{ id: string; models: unknown[]; defaultModel: string }>;
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((p) => p.id).sort(), ['deepseek', 'doubao', 'glm', 'qwen']);
  for (const p of items) {
    assert.ok(Array.isArray(p.models) && p.models.length > 0, `${p.id} 应有模型`);
    assert.ok(typeof p.defaultModel === 'string' && p.defaultModel.length > 0);
  }
});

test('凭据密文：PUT 后 DB 无明文、可解密、maskedKey 只露尾 4 位', async () => {
  const key = ['sk', 'test-placeholder'].join('-');
  const put = await call('PUT', '/api/providers/deepseek/credentials', { token: tokenA, payload: { apiKey: key } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.configured, true);

  const row = ctx.db.driver.get<{ api_key_enc: string }>(
    'SELECT api_key_enc FROM provider_credentials WHERE user_id = ? AND provider_id = ?',
    [userIdA, 'deepseek'],
  );
  assert.ok(row, '应存在凭据行');
  assert.ok(row!.api_key_enc.startsWith('v1:'), `密文应为 v1: 格式：${row!.api_key_enc.slice(0, 20)}`);
  assert.ok(!row!.api_key_enc.includes(key), 'DB 中不应出现明文 Key');
  assert.equal(decryptSecret(row!.api_key_enc, ctx.config.secretsKey), key, '应能解密还原');

  const list = await call('GET', '/api/providers', { token: tokenA });
  const ds = (list.body.data.items as Array<Record<string, any>>).find((p) => p.id === 'deepseek')!;
  assert.equal(ds.configured, true);
  assert.equal(ds.maskedKey, `****${key.slice(-4)}`, 'maskedKey 只露尾 4 位');
  assert.equal(ds.isDefault, true, '首个凭据应为默认供应商');
});

test('连通性测试：有效 Key ok:true、无效 Key ok:false + 归一化错误', async () => {
  const good = await call('POST', '/api/providers/deepseek/test', { token: tokenA, payload: { apiKey: 'sk-valid' } });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.ok, true);

  const bad = await call('POST', '/api/providers/deepseek/test', { token: tokenA, payload: { apiKey: 'bad-key' } });
  assert.equal(bad.status, 200);
  assert.equal(bad.body.data.ok, false);
  assert.equal(bad.body.data.error.kind, 'auth');
  assert.equal(bad.body.data.error.userMessage, '密钥无效');
});

test('越权隔离：B 看不到 A 的凭据，B DELETE 不影响 A', async () => {
  const listB = await call('GET', '/api/providers', { token: tokenB });
  const dsB = (listB.body.data.items as Array<Record<string, any>>).find((p) => p.id === 'deepseek')!;
  assert.equal(dsB.configured, false, 'B 不应看到 A 的 deepseek 已配置');
  assert.equal(dsB.maskedKey, null, 'B 不应看到 A 的掩码 Key');

  // B 尝试删除 A 的凭据（幂等，不产生效果）
  const delB = await call('DELETE', '/api/providers/deepseek/credentials', { token: tokenB });
  assert.equal(delB.status, 200);
  assert.equal(delB.body.data.configured, false);

  // A 的凭据仍然在
  const listA = await call('GET', '/api/providers', { token: tokenA });
  const dsA = (listA.body.data.items as Array<Record<string, any>>).find((p) => p.id === 'deepseek')!;
  assert.equal(dsA.configured, true, 'B 的 DELETE 不应影响 A 的凭据');
});

test('未知供应商 -> 404 PROVIDER_UNKNOWN', async () => {
  const res = await call('PUT', '/api/providers/unknown-xyz/credentials', { token: tokenA, payload: { apiKey: 'sk-1' } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'PROVIDER_UNKNOWN');
});
