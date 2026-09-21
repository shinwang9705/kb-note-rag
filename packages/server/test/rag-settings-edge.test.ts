/**
 * 六期 QA 补强（边界单测）—— 不照单全收，独立复核三层合并 / 归一化 / 降级 / resolveRagParams / 置信度阈值。
 *
 * 与工程师 rag-settings.test.ts 的差异：
 *   - 合并优先级「9 项逐字段」逐一断言（含 confidence 两项，原测试只测了 groundedScore）；
 *   - clamp 下边界（topK=0 -> 1）、float 越界（confidence 1.5 -> 1）、defaultMode 非字符串类型回退；
 *   - readStoredRag 的 rag 段「非对象（数组/字符串）」降级；
 *   - resolveRagParams 的 rerankEnabled=enabled && available 双向分支 + enabled=false 时 topN/topK 不生效；
 *   - computeConfidence 的 groundedScore 阈值随参数移动（改阈值后三档判定边界变化）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RAG_SETTINGS, RAG_RANGE, type SearchHit } from '@kb/shared';
import {
  getRagSettings,
  normalizeRagSettings,
  readStoredRag,
  resolveRagParams,
} from '../src/service/rag.service.ts';
import { computeConfidence } from '../src/service/chat.service.ts';
import type { RankedChunk } from '../src/service/rag-pipeline.ts';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function makeDb(settingsJson: string | null) {
  return {
    driver: {
      get: () => (settingsJson === null ? undefined : { settings_json: settingsJson }),
    },
  };
}

/** env 默认（有代表性的非默认值，便于区分三层） */
function makeConfig() {
  return {
    search: { topK: 40, finalK: 12 },
    llm: { contextTopK: 6 },
    rerank: { topN: 25, topK: 7 },
    chunk: { size: 400, overlap: 80 },
  };
}

function makeRerank(available: boolean) {
  return { available };
}

function makeHit(chunkId: number, docId: number, source: SearchHit['source']): SearchHit {
  return {
    chunkId,
    docId,
    docTitle: `文档${docId}`,
    snippet: '',
    score: 0.5,
    charStart: 0,
    charEnd: 0,
    seq: chunkId,
    highlightStart: -1,
    highlightEnd: -1,
    source,
  };
}

function makeChunk(chunkId: number, docId: number, rerankScore?: number): RankedChunk {
  return {
    chunkId,
    docId,
    docTitle: `文档${docId}`,
    content: '内容',
    charStart: 0,
    charEnd: 2,
    ...(rerankScore !== undefined ? { rerankScore } : {}),
  };
}

// ---------------------------------------------------------------------------
// 归一化 clamp 边界
// ---------------------------------------------------------------------------

test('normalizeRagSettings：topK 传 0 clamp 到下界 1', () => {
  const n = normalizeRagSettings({ search: { topK: 0 } });
  assert.equal(n.search.topK, RAG_RANGE.searchTopK.min);
});

test('normalizeRagSettings：topK 传 999 clamp 到上界 100', () => {
  const n = normalizeRagSettings({ search: { topK: 999 } });
  assert.equal(n.search.topK, RAG_RANGE.searchTopK.max);
});

test('normalizeRagSettings：confidence 传 1.5 clamp 到 1', () => {
  const n = normalizeRagSettings({ confidence: { groundedScore: 1.5, partialScore: 1.5 } });
  assert.equal(n.confidence.groundedScore, RAG_RANGE.confidence.max);
  assert.equal(n.confidence.partialScore, RAG_RANGE.confidence.max);
});

test('normalizeRagSettings：confidence 传 -0.5 clamp 到 0', () => {
  const n = normalizeRagSettings({ confidence: { groundedScore: -0.5 } });
  assert.equal(n.confidence.groundedScore, RAG_RANGE.confidence.min);
});

test('normalizeRagSettings：defaultMode 传非字符串(数字) 回退 auto', () => {
  const n = normalizeRagSettings({ search: { defaultMode: 42 as never } });
  assert.equal(n.search.defaultMode, 'auto');
});

test('normalizeRagSettings：conf 字符串数字回退默认', () => {
  const n = normalizeRagSettings({ confidence: { groundedScore: '0.9' as never } });
  assert.equal(n.confidence.groundedScore, DEFAULT_RAG_SETTINGS.confidence.groundedScore);
});

// ---------------------------------------------------------------------------
// 三层合并（9 项逐字段）
// ---------------------------------------------------------------------------

test('getRagSettings：stored 全量覆盖时 9 项均取 stored', () => {
  const stored = {
    search: { topK: 50, finalK: 13, defaultMode: 'vector' },
    context: { topK: 9 },
    rerank: { enabled: false, topN: 26, topK: 8 },
    confidence: { groundedScore: 0.7, partialScore: 0.3 },
  };
  const rag = getRagSettings({ db: makeDb(JSON.stringify({ rag: stored })), config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 50);
  assert.equal(rag.search.finalK, 13);
  assert.equal(rag.search.defaultMode, 'vector');
  assert.equal(rag.context.topK, 9);
  assert.equal(rag.rerank.enabled, false);
  assert.equal(rag.rerank.topN, 26);
  assert.equal(rag.rerank.topK, 8);
  assert.equal(rag.confidence.groundedScore, 0.7);
  assert.equal(rag.confidence.partialScore, 0.3);
});

test('getRagSettings：无 stored 时 9 项 = env 默认或代码常量默认', () => {
  const rag = getRagSettings({ db: makeDb(null), config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 40, 'env config.search.topK');
  assert.equal(rag.search.finalK, 12, 'env config.search.finalK');
  assert.equal(rag.search.defaultMode, 'auto', 'defaultMode 无 env 用常量');
  assert.equal(rag.context.topK, 6, 'env config.llm.contextTopK');
  assert.equal(rag.rerank.enabled, true, 'enabled 无 env 用常量');
  assert.equal(rag.rerank.topN, 25, 'env config.rerank.topN');
  assert.equal(rag.rerank.topK, 7, 'env config.rerank.topK');
  assert.equal(rag.confidence.groundedScore, 0.5, 'groundedScore 无 env 用常量');
  assert.equal(rag.confidence.partialScore, 0.25, 'partialScore 无 env 用常量');
});

test('getRagSettings：stored 只覆盖部分字段时其余字段走 env/默认', () => {
  const db = makeDb(JSON.stringify({ rag: { search: { topK: 55 }, confidence: { partialScore: 0.4 } } }));
  const rag = getRagSettings({ db, config: makeConfig() } as never, 1);
  assert.equal(rag.search.topK, 55, 'stored 覆盖');
  assert.equal(rag.search.finalK, 12, '未存 finalK 走 env');
  assert.equal(rag.confidence.partialScore, 0.4, 'stored 覆盖');
  assert.equal(rag.confidence.groundedScore, 0.5, '未存 groundedScore 走常量');
});

// ---------------------------------------------------------------------------
// 降级：JSON 损坏 / rag 段类型错误
// ---------------------------------------------------------------------------

test('readStoredRag：settings_json 损坏返回 {}', () => {
  assert.deepEqual(readStoredRag(makeDb('{oops') as never, 1), {});
});

test('readStoredRag：rag 段为数组返回 {}', () => {
  assert.deepEqual(readStoredRag(makeDb(JSON.stringify({ rag: [1, 2, 3] })) as never, 1), {});
});

test('readStoredRag：rag 段为字符串返回 {}', () => {
  assert.deepEqual(readStoredRag(makeDb(JSON.stringify({ rag: 'not-an-object' })) as never, 1), {});
});

test('getRagSettings：字段类型错误（字符串数字）回退默认/env', () => {
  const db = makeDb(JSON.stringify({ rag: { search: { topK: '40' }, rerank: { enabled: 1 } } }));
  const rag = getRagSettings({ db, config: makeConfig() } as never, 1);
  // 字符串数字被 firstNumber 判非法 -> 落到 env
  assert.equal(rag.search.topK, 40, '字符串 topK 回退 env');
  // enabled 非布尔 -> 落到默认
  assert.equal(rag.rerank.enabled, true);
});

// ---------------------------------------------------------------------------
// resolveRagParams：rerankEnabled = enabled && available，finalK 分支
// ---------------------------------------------------------------------------

test('resolveRagParams：enabled=true 但 provider 不可用 -> rerankEnabled=false 且 finalK=context.topK', () => {
  const params = resolveRagParams(
    { db: makeDb(null), config: makeConfig(), rerank: makeRerank(false) } as never,
    1,
  );
  assert.equal(params.rerankEnabled, false);
  assert.equal(params.finalK, 6, 'provider 不可用 -> context.topK');
});

test('resolveRagParams：enabled=false 时 rerank.topK 不生效，finalK=context.topK', () => {
  const db = makeDb(JSON.stringify({ rag: { rerank: { enabled: false, topK: 7 }, context: { topK: 6 } } }));
  const params = resolveRagParams({ db, config: makeConfig(), rerank: makeRerank(true) } as never, 1);
  assert.equal(params.rerankEnabled, false);
  assert.equal(params.finalK, 6, 'rerank.topK(7) 不生效，仍 context.topK(6)');
});

test('resolveRagParams：enabled=true 且 provider 可用 -> finalK=rerank.topK', () => {
  const db = makeDb(JSON.stringify({ rag: { rerank: { enabled: true, topK: 8 } } }));
  const params = resolveRagParams({ db, config: makeConfig(), rerank: makeRerank(true) } as never, 1);
  assert.equal(params.rerankEnabled, true);
  assert.equal(params.finalK, 8);
});

// ---------------------------------------------------------------------------
// computeConfidence：阈值随 rag.confidence 变化
// ---------------------------------------------------------------------------

test('computeConfidence：groundedScore 0.5 -> 0.9，rerank 0.8 由 grounded 变 partial', () => {
  const chunk = makeChunk(1, 1, 0.8);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'grounded');
  assert.equal(
    computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true, { groundedScore: 0.9, partialScore: 0.25 }),
    'partial',
  );
});

test('computeConfidence：rerank 分数恰好等于 groundedScore 判定为 grounded', () => {
  const chunk = makeChunk(1, 1, 0.9);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(
    computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true, { groundedScore: 0.9, partialScore: 0.25 }),
    'grounded',
  );
});
