import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir, setTestEnv, makeCall, PASSWORD } from './harness.ts';
import { createMockGateway, createTestAppWithGateway } from './mock-gateway.ts';
import { ModelGatewayImpl, type GatewayRequest } from '../src/llm/router.ts';
import { withRetry } from '../src/llm/retry.ts';
import { normalizeError } from '../src/llm/errors.ts';
import { validateProviderBaseUrl } from '../src/llm/endpoint.ts';
import { PROVIDER_CATALOG } from '../src/llm/providers/index.ts';
import { upsertCredential } from '../src/repo/provider-credential.repo.ts';
import { encryptSecret } from '../src/util/secret-crypto.ts';
import { search } from '../src/service/search.service.ts';
import { searchByVector } from '../src/repo/search.repo.ts';
import { insertVectors } from '../src/repo/vector.repo.ts';
import { listChunks } from '../src/repo/chunk.repo.ts';
import { findDocumentById } from '../src/repo/document.repo.ts';
import { ingestText, replaceDocument, reindexAll } from '../src/service/ingest.service.ts';
import { NoneEmbeddingProvider } from '../src/embedding/none.ts';
import type { EmbeddingProvider } from '../src/embedding/types.ts';

setTestEnv(makeTempDir('resilience'));
let ctx: Awaited<ReturnType<typeof createTestAppWithGateway>>;
let userId: number;
let secondId: number;
const none = new NoneEmbeddingProvider(null);
before(async () => {
  ctx = await createTestAppWithGateway(createMockGateway().gateway);
  const call = makeCall(ctx.app);
  for (const name of ['resilience_a', 'resilience_b']) {
    const res = await call('POST', '/api/auth/register', { payload: { username: name, password: PASSWORD } });
    assert.equal(res.status, 200);
    if (!userId) userId = res.body.data.user.id; else secondId = res.body.data.user.id;
  }
});
after(async () => { await ctx.close(); });
function embedding(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return { kind: 'local', model: 'mock', dim: ctx.config.embedding.dim, available: true,
    init: async () => {}, close: async () => {}, embed: async () => [], embedQuery: async () => [], ...overrides };
}
function req(id = userId): GatewayRequest {
  return { userId: id, providerId: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'test' }],
    params: { temperature: 0, maxTokens: 20 }, meta: { purpose: 'chat' } };
}
function config(timeoutMs = 2000) {
  return { ...ctx.config, llm: { ...ctx.config.llm, provider: 'deepseek' as const, apiKey: 'mock-only', apiBase: 'https://mock.example/v1', timeoutMs } };
}

test('模型地址仅允许官方端点或管理员授权来源', () => {
  const settings = config();
  assert.equal(validateProviderBaseUrl('https://api.deepseek.com/', settings), 'https://api.deepseek.com');
  assert.equal(validateProviderBaseUrl('https://mock.example/v1/', settings), 'https://mock.example/v1');
  for (const address of ['http://127.0.0.1:8787/api', 'http://169.254.169.254/latest',
    'https://api.deepseek.com.evil.example/v1', 'https://user:password@api.deepseek.com',
    'https://api.deepseek.com/?target=internal', 'file:///etc/passwd', 'not-a-url']) {
    assert.throws(() => validateProviderBaseUrl(address, settings));
  }
  assert.equal(validateProviderBaseUrl('http://127.0.0.1:11434/v1', {
    ...settings, providerAllowedOrigins: ['http://127.0.0.1:11434'],
  }), 'http://127.0.0.1:11434/v1');
});

test('vector-only 模型空向量/抛错均降级 keyword 并返回关键词结果', async () => {
  await ingestText({ ...ctx, embedding: none }, { userId, libraryId: null, title: '降级验证', content: '可靠性降级关键词正文' });
  for (const embedQuery of [async () => [], async () => { throw new Error('mock unavailable'); }]) {
    const result = await search({ ...ctx, db: { ...ctx.db, vecAvailable: true }, embedding: embedding({ embedQuery }) },
      { userId, query: '可靠性降级关键词', mode: 'vector' });
    assert.equal(result.mode, 'keyword');
    assert.ok(result.hits.length > 0);
    assert.ok(result.warnings?.length);
  }
});

test('范围内 topK 不被库外近邻挤占，且不越权', (t) => {
  if (!ctx.db.vecAvailable) return t.skip('sqlite-vec 未装载');
  const vector = new Array(ctx.config.embedding.dim).fill(0); vector[0] = 1;
  return (async () => {
    const inside = await ingestText({ ...ctx, embedding: none }, { userId, libraryId: null, title: '范围内', content: '范围内的资料' });
    const outside = await ingestText({ ...ctx, embedding: none }, { userId, libraryId: null, title: '范围外', content: '范围外的资料' });
    const inId = Number(listChunks(ctx.db, userId, inside.documentId)[0]!.id);
    const outId = Number(listChunks(ctx.db, userId, outside.documentId)[0]!.id);
    insertVectors(ctx.db, userId, inside.documentId, [{ chunkId: inId, vector: vector.map(v => v * 0.5) }]);
    insertVectors(ctx.db, userId, outside.documentId, [{ chunkId: outId, vector }]);
    const hits = searchByVector(ctx.db, userId, vector, 1, null, inside.documentId);
    assert.equal(hits.length, 1); assert.equal(hits[0]!.docId, inside.documentId);
    assert.equal(searchByVector(ctx.db, secondId, vector, 1, null, inside.documentId).length, 0);
  })();
});

test('替换向量失败保留旧文件、正文、索引，并清理暂存文件', async () => {
  const doc = await ingestText({ ...ctx, embedding: none }, { userId, libraryId: null, title: '原始内容', content: '必须保留的旧内容' });
  const old = findDocumentById(ctx.db, userId, doc.documentId)!;
  const oldChunks = listChunks(ctx.db, userId, doc.documentId);
  const diskPath = path.join(ctx.config.db.dataDir, old.storage_path!);
  const files = readdirSync(path.dirname(diskPath));
  await assert.rejects(replaceDocument({ ...ctx, logger: { info() {}, warn: console.warn, error: console.error, debug() {} }, db: { ...ctx.db, vecAvailable: true }, embedding: embedding() },
    { userId, docId: doc.documentId, fileName: 'new.txt', buffer: Buffer.from('新版本') }), /向量生成失败/);
  assert.deepEqual(findDocumentById(ctx.db, userId, doc.documentId), old);
  assert.deepEqual(listChunks(ctx.db, userId, doc.documentId), oldChunks);
  assert.equal(readFileSync(diskPath, 'utf8'), '必须保留的旧内容');
  assert.deepEqual(readdirSync(path.dirname(diskPath)), files);
});

test('重建向量失败不损坏旧片段', async () => {
  const before = ctx.db.driver.all('SELECT * FROM chunks ORDER BY id');
  const result = await reindexAll({ ...ctx, db: { ...ctx.db, vecAvailable: true }, embedding: embedding() }, { userId });
  assert.ok(result.failed.length > 0);
  assert.deepEqual(ctx.db.driver.all('SELECT * FROM chunks ORDER BY id'), before);
});

test('替换配额扣除旧文档字节数', async () => {
  const doc = await ingestText({ ...ctx, embedding: none }, { userId: secondId, libraryId: null, title: '配额', content: '1234567890' });
  const config = { ...ctx.config, quota: { ...ctx.config.quota, maxTotalBytes: 10 } };
  const result = await replaceDocument({ ...ctx, config, embedding: none }, { userId: secondId, docId: doc.documentId, fileName: 'new.txt', buffer: Buffer.from('abcdefghij') });
  assert.equal(result.status, 'ready');
});

test('网关使用全局自定义 Base URL', async () => {
  const target = await new ModelGatewayImpl({ ...ctx, config: config() }).resolve(userId, { kind: 'pinned', providerId: 'deepseek', model: 'deepseek-chat' });
  assert.equal(target.baseUrl, 'https://mock.example/v1');
});

test('重试退避可即时取消，不发第二次请求', async () => {
  const abort = new AbortController(); let calls = 0;
  const running = withRetry(async () => { calls++; throw new Error('retry'); }, () => ({ retryable: true, maxRetries: 1, delaysMs: [10000] }), abort.signal);
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(calls, 1);
});

test('模型请求超时归一化为 timeout，且不继续重试', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    calls++; const signal = init.signal!; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  // timeout signal 的 timer 为 unref；保持测试进程存活直到断言结束。
  const timer = setTimeout(() => {}, 1000);
  try { await assert.rejects(new ModelGatewayImpl({ ...ctx, config: config(25) }).chat(req(), new AbortController().signal), (error: any) => error.normalized.kind === 'timeout'); }
  finally { clearTimeout(timer); }
  assert.equal(calls, 1); assert.equal(normalizeError(new DOMException('timeout', 'TimeoutError'), 'deepseek').kind, 'timeout');
});

test('一个用户鉴权失败不会熔断其他用户请求', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return calls <= 3 ? new Response('{}', { status: 401 }) : Response.json({ choices: [{ message: { content: 'ok' } }] }); });
  const gateway = new ModelGatewayImpl({ ...ctx, config: config() });
  for (let i = 0; i < 3; i++) await assert.rejects(gateway.chat(req(), new AbortController().signal));
  assert.equal(gateway.healthSnapshot().deepseek?.openUntil, undefined);
  assert.equal((await gateway.chat(req(secondId), new AbortController().signal)).content, 'ok');
});

test('流式故障转移使用目标厂商的模型，思考轮次禁止跨厂商', async (t) => {
  upsertCredential(ctx.db, userId, 'qwen', { apiKeyEnc: encryptSecret('mock-key', ctx.config.secretsKey), enabled: true });
  const models: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model; models.push(model);
    // 无任何输出前 SSE 解析失败，可直接转移，无退避等待。
    return new Response(model === 'deepseek-chat' ? 'data: invalid\n\n' : 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  const gateway = new ModelGatewayImpl({ ...ctx, config: config() });
  const events = [];
  for await (const event of gateway.chatStream(req(), new AbortController().signal)) events.push(event);
  assert.deepEqual(models, ['deepseek-chat', PROVIDER_CATALOG.qwen!.models[0]!.id]);
  assert.ok(events.some(e => e.type === 'content_delta' && e.text === 'ok'));
  models.length = 0;
  for await (const _event of gateway.chatStream({ ...req(), meta: { purpose: 'thinking' } }, new AbortController().signal)) {}
  assert.deepEqual(models, ['deepseek-chat']);
});
