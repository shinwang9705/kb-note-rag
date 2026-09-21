/**
 * 四期 T02 补强（QA 独立补充，非 rubber-stamp 复核）：
 *   既有 rerank.test.ts 已覆盖「重排/抛错降级/空返回降级/不可用跳过/finalK/归一化」，
 *   本文件补齐其未覆盖的边界：
 *     1. assembleContext：rerank 只返回部分 index 时，未命中候选按原序补末尾、缺失分不越界；
 *     2. ApiRerankProvider 超时（AbortController 触发）-> 返回空数组且不抛错（降级）；
 *     3. ApiRerankProvider 过滤越界下标 / 非法数值（防御上游脏数据）；
 *     4. 工厂 createRerankProvider / initRerankProvider / rerankEnabled 装配正确性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchHit } from '@kb/shared';
import type { AppConfig } from '../src/config.ts';
import { assembleContext } from '../src/service/rag-pipeline.ts';
import { ApiRerankProvider } from '../src/rerank/api.ts';
import {
  createRerankProvider,
  initRerankProvider,
  rerankEnabled,
  NoneRerankProvider,
} from '../src/rerank/index.ts';
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

function rerankConfig(provider: 'api' | 'none', apiKey: string): AppConfig {
  return {
    rerank: {
      provider,
      apiBase: 'https://example.test/rerank',
      apiKey,
      model: 'qwen3.7-text-rerank',
      topN: 20,
      topK: 5,
      timeoutMs: 5000,
    },
  } as unknown as AppConfig;
}

test('assembleContext：rerank 只返回部分 index 时未命中候选按原序补末尾', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A')],
    [11, makeChunk(11, 1, 'B')],
    [12, makeChunk(12, 2, 'C')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8), makeHit(12, 2, 0.7)];
  // 只返回 index=0，其余 1、2 应按原序补在末尾，且仅 index=0 有 rerankScore
  const rerank = rerankWith([{ index: 0, score: 0.88 }]);

  const result = await assembleContext(makeDeps(rerank, chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, true);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [10, 11, 12]);
  assert.equal(result.chunks[0]?.rerankScore, 0.88);
  assert.equal(result.chunks[1]?.rerankScore, undefined);
  assert.equal(result.chunks[2]?.rerankScore, undefined);
});

test('assembleContext：rerank 返回重复 index 时去重且不重复输出', async () => {
  const chunkMap = new Map<number, ContextChunk>([
    [10, makeChunk(10, 1, 'A')],
    [11, makeChunk(11, 1, 'B')],
  ]);
  const hits = [makeHit(10, 1, 0.9), makeHit(11, 1, 0.8)];
  // 重复 index=0 出现两次，第二次应被去重
  const rerank = rerankWith([
    { index: 0, score: 0.9 },
    { index: 0, score: 0.5 },
  ]);

  const result = await assembleContext(makeDeps(rerank, chunkMap), {
    userId: 1,
    query: 'q',
    hits,
    finalK: 5,
  });

  assert.equal(result.reranked, true);
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), [10, 11]);
});

test('ApiRerankProvider 超时触发 AbortController 并降级返回空数组', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // fetch 永不 resolve，只在 signal abort 时 reject —— 模拟超时
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      })) as typeof fetch;

    const provider = new ApiRerankProvider({
      apiBase: 'https://example.test/rerank',
      apiKey: 'k',
      model: 'qwen3.7-text-rerank',
      timeoutMs: 30,
      logger: null,
    });
    await provider.init();
    assert.equal(provider.available, true);

    const results = await provider.rerank('q', ['a', 'b']);
    assert.deepEqual(results, [], '超时后应降级返回空数组，绝不抛错');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ApiRerankProvider 过滤越界下标与非法数值', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          output: {
            results: [
              { index: 0, relevance_score: 0.9 },
              { index: 99, relevance_score: 0.8 }, // 越界 -> 丢弃
              { index: 1, relevance_score: 'oops' }, // 非数值 -> 丢弃
              { index: -1, relevance_score: 0.5 }, // 负下标 -> 丢弃
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

    const results = await provider.rerank('q', ['a', 'b']);
    assert.deepEqual(results, [{ index: 0, score: 0.9 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createRerankProvider：provider=none -> NoneRerankProvider（available=false）', () => {
  const provider = createRerankProvider({ config: rerankConfig('none', ''), logger: null });
  assert.ok(provider instanceof NoneRerankProvider);
  assert.equal(provider.kind, 'none');
  assert.equal(provider.available, false);
  assert.equal(rerankEnabled(provider), false);
});

test('createRerankProvider：provider=api 无 key -> available=false；有 key -> available=true', () => {
  const noKey = createRerankProvider({ config: rerankConfig('api', ''), logger: null });
  assert.equal(noKey.kind, 'api');
  assert.equal(noKey.available, false);
  assert.equal(rerankEnabled(noKey), false);

  const withKey = createRerankProvider({ config: rerankConfig('api', 'sk-123'), logger: null });
  assert.equal(withKey.kind, 'api');
  assert.equal(withKey.available, true);
  assert.equal(rerankEnabled(withKey), true);
});

test('initRerankProvider：none 场景初始化后仍 available=false 且不抛错', async () => {
  const provider = await initRerankProvider({ config: rerankConfig('none', ''), logger: null });
  assert.ok(provider instanceof NoneRerankProvider);
  assert.equal(provider.available, false);
  assert.equal(rerankEnabled(provider), false);
});

test('initRerankProvider：api 无 key 初始化后 available=false（不重排）', async () => {
  const provider = await initRerankProvider({ config: rerankConfig('api', ''), logger: null });
  assert.equal(provider.kind, 'api');
  assert.equal(provider.available, false);
  assert.equal(rerankEnabled(provider), false);
});
