/**
 * 四期 T02：云端 Rerank 可插拔环节单测。
 *
 * 覆盖：
 *   1. assembleContext 在 rerank 可用时按分数重排并回填 rerankScore；
 *   2. 降级路径：rerank 抛错 -> 保持 RRF 原序、reranked=false；
 *   3. 降级路径：rerank 返回空 -> 保持 RRF 原序；
 *   4. rerank 不可用（available=false）-> 不重排；
 *   5. finalK 截断 + docCount/groupedByDoc 统计；
 *   6. ApiRerankProvider 响应归一化（DashScope output.results / 通用 results）+ 失败返回空。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchHit } from '@kb/shared';
import { assembleContext } from '../src/service/rag-pipeline.ts';
import { ApiRerankProvider } from '../src/rerank/api.ts';
import type { ContextChunk } from '../src/repo/chat.repo.ts';
import type { RerankProvider, RerankResult } from '../src/rerank/types.ts';

function makeHit(chunkId: number, docId: number, score: number): SearchHit {
  return {
    chunkId,
    docId,
    docTitle: `文档${docId}`,
    snippet: '',
    score,
    charStart: 0,
    charEnd: 0,
    seq: chunkId,
    highlightStart: -1,
    highlightEnd: -1,
    source: 'fts',
  };
}

function makeChunk(chunkId: number, docId: number, content: string): ContextChunk {
  return { chunkId, docId, docTitle: `文档${docId}`, content, charStart: 0, charEnd: content.length };
}

function makeDeps(rerank: RerankProvider, chunkMap: Map<number, ContextChunk>) {
  return {
    rerank,
    db: {} as never,
    getContextChunks: (_db: unknown, _userId: number, ids: readonly number[]): ContextChunk[] =>
      ids.map((id) => chunkMap.get(id)).filter((chunk): chunk is ContextChunk => Boolean(chunk)),
  };
}

function rerankWith(results: RerankResult[]): RerankProvider {
  return {
    kind: 'api',
    model: 'fake-reranker',
    available: true,
    init: async () => {},
    rerank: async () => results,
    close: async () => {},
  };
}

function rerankThrowing(): RerankProvider {
  return {
    kind: 'api',
    model: 'fake-reranker',
    available: true,
    init: async () => {},
    rerank: async () => {
      throw new Error('boom');
    },
    close: async () => {},
  };
}

function noneRerank(): RerankProvider {
  return {
    kind: 'none',
    model: 'none',
    available: false,
    init: async () => {},
    rerank: async () => [],
    close: async () => {},
  };
}

test('rerank 可用时按分数重排并回填 rerankScore', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A 内容')],
    [11, makeChunk(11, 1, 'B 内容')],
    [12, makeChunk(12, 2, 'C 内容')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8), makeHit(12, 2, 0.7)];
  const rerank = rerankWith([
    { index: 2, score: 0.95 },
    { index: 0, score: 0.6 },
    { index: 1, score: 0.3 },
  ]);

  const result = await assembleContext(makeDeps(rerank, chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, true);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [12, 10, 11]);
  assert.equal(result.chunks[0]?.rerankScore, 0.95);
  assert.equal(result.chunks[1]?.rerankScore, 0.6);
  assert.equal(result.chunks[2]?.rerankScore, 0.3);
});

test('rerank 抛错时保持 RRF 原序且 reranked=false', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A 内容')],
    [11, makeChunk(11, 1, 'B 内容')],
    [12, makeChunk(12, 2, 'C 内容')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8), makeHit(12, 2, 0.7)];

  const result = await assembleContext(makeDeps(rerankThrowing(), chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, false);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [10, 11, 12]);
  assert.ok(result.chunks.every((chunk) => chunk.rerankScore === undefined));
});

test('rerank 返回空结果时降级为 RRF 原序', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A 内容')],
    [11, makeChunk(11, 1, 'B 内容')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8)];

  const result = await assembleContext(makeDeps(rerankWith([]), chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, false);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [10, 11]);
});

test('rerank 不可用（available=false）时不重排', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A 内容')],
    [11, makeChunk(11, 1, 'B 内容')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8)];

  const result = await assembleContext(makeDeps(noneRerank(), chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, false);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [10, 11]);
});

test('finalK 截断 + docCount/groupedByDoc 统计', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'x')],
    [11, makeChunk(11, 1, 'y')],
    [12, makeChunk(12, 2, 'z')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8), makeHit(12, 2, 0.7)];
  const rerank = rerankWith([
    { index: 2, score: 0.9 },
    { index: 0, score: 0.8 },
    { index: 1, score: 0.7 },
  ]);

  const result = await assembleContext(makeDeps(rerank, chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 2,
  });

  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [12, 10]);
  assert.equal(result.docCount, 2);
  assert.equal(result.groupedByDoc.size, 2);
  assert.deepEqual(result.groupedByDoc.get(2)?.map((chunk) => chunk.chunkId), [12]);
  assert.deepEqual(result.groupedByDoc.get(1)?.map((chunk) => chunk.chunkId), [10]);
});

test('ApiRerankProvider 归一化 DashScope output.results 与通用 results', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          output: {
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.3 },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const provider = new ApiRerankProvider({
      apiBase: 'https://example.test/rerank',
      apiKey: 'k',
      model: 'qwen3.7-text-rerank',
      timeoutMs: 5000,
      logger: null,
    });
    await provider.init();
    assert.equal(provider.available, true);

    const results = await provider.rerank('q', ['a', 'b']);
    assert.deepEqual(results, [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.3 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ApiRerankProvider 归一化通用 results 字段', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.75 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const provider = new ApiRerankProvider({
      apiBase: 'https://example.test/rerank',
      apiKey: 'k',
      model: 'qwen3.7-text-rerank',
      timeoutMs: 5000,
      logger: null,
    });
    await provider.init();

    const results = await provider.rerank('q', ['a']);
    assert.deepEqual(results, [{ index: 0, score: 0.75 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ApiRerankProvider 网络失败返回空数组且不抛错', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const provider = new ApiRerankProvider({
      apiBase: 'https://example.test/rerank',
      apiKey: 'k',
      model: 'qwen3.7-text-rerank',
      timeoutMs: 5000,
      logger: null,
    });
    await provider.init();

    const results = await provider.rerank('q', ['a', 'b']);
    assert.deepEqual(results, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ApiRerankProvider 无 apiKey 时 available=false 且 rerank 返回空', async () => {
  const provider = new ApiRerankProvider({
    apiBase: 'https://example.test/rerank',
    apiKey: '',
    model: 'gte-rerank',
    timeoutMs: 5000,
    logger: null,
  });
  await provider.init();
  assert.equal(provider.available, false);
  assert.deepEqual(await provider.rerank('q', ['a', 'b']), []);
});
