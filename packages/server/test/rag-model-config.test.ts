import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, setTestEnv, createTestApp, makeCall, uniqueUsername, PASSWORD, type TestApp, type Caller } from './harness.ts';

const TMP = makeTempDir('rag-model-config');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let token = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const registered = await call('POST', '/api/auth/register', { payload: { username: uniqueUsername('rag_model'), password: PASSWORD } });
  assert.equal(registered.status, 200);
  token = registered.body.data.token as string;
});

after(async () => { await ctx.close(); });

test('RAG 模型凭证可由前端 API 配置且数据库不保存明文', async () => {
  const initial = await call('GET', '/api/rag/models', { token });
  assert.equal(initial.status, 200);
  const embedding = initial.body.data.items.find((item: any) => item.capability === 'embedding');
  assert.ok(embedding);

  const secret = 'rag-model-encryption-test-token';
  const saved = await call('PUT', '/api/rag/models/embedding', {
    token,
    payload: {
      enabled: true,
      apiBase: embedding.apiBase,
      model: 'text-embedding-v3',
      apiKey: secret,
      timeoutMs: 12_000,
      dim: ctx.config.embedding.dim,
      batchSize: 8,
    },
  });
  assert.equal(saved.status, 200);
  const item = saved.body.data.items.find((entry: any) => entry.capability === 'embedding');
  assert.equal(item.source, 'user');
  assert.equal(item.maskedKey, '****oken');
  assert.equal(JSON.stringify(saved.body).includes(secret), false);

  const row = ctx.db.driver.get<{ api_key_enc: string }>("SELECT api_key_enc FROM rag_model_credentials WHERE capability='embedding'");
  assert.ok(row?.api_key_enc);
  assert.equal(row?.api_key_enc.includes(secret), false);

  const reset = await call('DELETE', '/api/rag/models/embedding', { token });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.data.items.find((entry: any) => entry.capability === 'embedding').source, 'none');
});

test('Embedding 维度不匹配会被拒绝', async () => {
  const initial = await call('GET', '/api/rag/models', { token });
  const embedding = initial.body.data.items.find((item: any) => item.capability === 'embedding');
  const result = await call('PUT', '/api/rag/models/embedding', {
    token,
    payload: { enabled: true, apiBase: embedding.apiBase, model: 'bad-dim', apiKey: 'dimension-test-token', timeoutMs: 10_000, dim: ctx.config.embedding.dim + 1, batchSize: 8 },
  });
  assert.equal(result.status, 400);
});
