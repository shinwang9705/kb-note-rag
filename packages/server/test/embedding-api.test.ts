import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiEmbeddingProvider } from '../src/embedding/api.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('OpenAI 兼容基址自动追加 /embeddings 并解析 data', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ data: [{ embedding: [3, 4, 0] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const provider = new ApiEmbeddingProvider({
    apiBase: 'https://example.test/v1',
    apiKey: 'test-key',
    apiModel: 'embedding-model',
    timeoutMs: 1_000,
    batchSize: 8,
    dim: 3,
  });
  const vectors = await provider.embed(['测试']);

  assert.equal(requestedUrl, 'https://example.test/v1/embeddings');
  assert.deepEqual(requestedBody, { model: 'embedding-model', input: ['测试'] });
  assert.equal(vectors.length, 1);
  assert.ok(vectors[0]?.some((value) => value !== 0));
});

test('DashScope 原生完整端点不重复拼接并解析 output.embeddings', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output: {
        embeddings: [
          { text_index: 1, embedding: [0, 2, 0] },
          { text_index: 0, embedding: [1, 0, 0] },
        ],
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const endpoint = 'https://example.test/api/v1/services/embeddings/text-embedding/text-embedding';
  const provider = new ApiEmbeddingProvider({
    apiBase: endpoint,
    apiKey: 'test-key',
    apiModel: 'qwen-embedding',
    timeoutMs: 1_000,
    batchSize: 8,
    dim: 3,
  });
  const vectors = await provider.embed(['第一条', '第二条']);

  assert.equal(requestedUrl, endpoint);
  assert.deepEqual(requestedBody, {
    model: 'qwen-embedding',
    input: { texts: ['第一条', '第二条'] },
  });
  assert.deepEqual(vectors, [[1, 0, 0], [0, 2, 0]]);
});

test('请求失败时保留不含密钥的诊断信息', async () => {
  globalThis.fetch = (async () => new Response('{"message":"bad model"}', { status: 400 })) as typeof fetch;
  const provider = new ApiEmbeddingProvider({
    apiBase: 'https://example.test/v1',
    apiKey: 'must-not-leak',
    apiModel: 'bad-model',
    timeoutMs: 1_000,
    batchSize: 1,
    dim: 3,
  });

  assert.deepEqual(await provider.embed(['测试']), []);
  assert.match(provider.lastError ?? '', /400.*bad model/u);
  assert.equal(provider.lastError?.includes('must-not-leak'), false);
});
