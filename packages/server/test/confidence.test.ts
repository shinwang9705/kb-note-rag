/**
 * 四期 T03：置信度三档阈值单测（computeConfidence 纯函数）。
 *
 * 覆盖（设计 §3.2 第 4 点）：
 *   无命中 -> ungrounded；
 *   rerank 高分(>=0.5) -> grounded；
 *   中分(0.25<=x<0.5) -> partial；
 *   低分(<0.25) -> ungrounded；
 *   rerank 降级 + top1 多通道(source='both') -> grounded；
 *   rerank 降级 + 跨文档(docCount>=2) -> partial；
 *   rerank 降级 + 单通道 -> partial。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchHit } from '@kb/shared';
import { computeConfidence } from '../src/service/chat.service.ts';
import type { RankedChunk } from '../src/service/rag-pipeline.ts';

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

test('无命中 -> ungrounded', () => {
  assert.equal(computeConfidence([], { chunks: [], docCount: 0 }, false), 'ungrounded');
});

test('rerank 高分(>=0.5) -> grounded', () => {
  const chunk = makeChunk(1, 1, 0.9);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'grounded');
});

test('rerank 边界分(0.5) -> grounded', () => {
  const chunk = makeChunk(1, 1, 0.5);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'grounded');
});

test('rerank 中分(0.25<=x<0.5) -> partial', () => {
  const chunk = makeChunk(1, 1, 0.3);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'partial');
});

test('rerank 边界分(0.25) -> partial', () => {
  const chunk = makeChunk(1, 1, 0.25);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'partial');
});

test('rerank 低分(<0.25) -> ungrounded', () => {
  const chunk = makeChunk(1, 1, 0.1);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'ungrounded');
});

test('rerank 降级 + top1 多通道(source=both) -> partial', () => {
  const chunk = makeChunk(1, 1);
  const hits = [makeHit(1, 1, 'both')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, false), 'partial');
});

test('rerank 降级 + 跨文档(docCount>=2) -> partial', () => {
  const chunk = makeChunk(1, 1);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 2 }, false), 'partial');
});

test('rerank 降级 + 单通道单文档 -> partial', () => {
  const chunk = makeChunk(1, 1);
  const hits = [makeHit(1, 1, 'fts')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, false), 'partial');
});

test('reranked=true 但缺 rerankScore 时走 RRF 降级路径', () => {
  const chunk = makeChunk(1, 1);
  const hits = [makeHit(1, 1, 'both')];
  assert.equal(computeConfidence(hits, { chunks: [chunk], docCount: 1 }, true), 'partial');
});
