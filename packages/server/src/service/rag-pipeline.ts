/**
 * RAG 上下文装配纯函数（3 个 RAG 挂载点共用）：
 *   单轮 chat.service.prepareAsk / 多轮 conversation.service.buildKnowledge /
 *   深度思考 thinking.engine.buildKbSection 都复用本函数，消除重复样板。
 *
 * 流程：检索候选 -> 回表全文 -> 可选 rerank -> 按 docId 分组统计 -> 返回排序片段。
 *
 * 降级哲学：rerank 是增强环节，任何失败都不阻断主链路——
 *   rerank 抛错 / 返回空 -> 保持 RRF 原序，reranked=false。
 */
import type { SearchHit } from '@kb/shared';
import type { DbHandle } from '../db/connection.js';
import type { ContextChunk } from '../repo/chat.repo.js';
import type { RerankProvider } from '../rerank/types.js';

/** 进生成/上下文的片段：在 ContextChunk 之上追加可选 rerank 分 */
export interface RankedChunk extends ContextChunk {
  rerankScore?: number;
}

export interface AssembleContextDeps {
  rerank: RerankProvider;
  /** 回表取完整正文（薄封装，透传 db） */
  getContextChunks: (db: DbHandle, userId: number, chunkIds: readonly number[]) => ContextChunk[];
  db: DbHandle;
  /**
   * 用户是否启用精排（运行级开关，与 provider 可用性求 && 后生效）。
   * 缺省 true：兼容直接调用 assembleContext 的既有用例（不传即视为启用）。
   */
  rerankEnabled?: boolean;
}

export interface AssembleContextInput {
  userId: number;
  query: string;
  /** search() 的融合结果（topN 候选，已按 RRF 降序） */
  hits: SearchHit[];
  /** 进生成/上下文的最终条数 */
  finalK: number;
}

export interface AssembleContextResult {
  /** 按最终顺序（rerank 后或 RRF 原序） */
  chunks: RankedChunk[];
  /** 是否真的走了 rerank */
  reranked: boolean;
  /** 命中片段跨多少个不同 docId */
  docCount: number;
  groupedByDoc: Map<number, RankedChunk[]>;
}

export async function assembleContext(
  deps: AssembleContextDeps,
  input: AssembleContextInput,
): Promise<AssembleContextResult> {
  const { rerank, getContextChunks, db } = deps;
  const rerankEnabled = deps.rerankEnabled ?? true;
  const { userId, query, hits, finalK } = input;

  // ① hits 取 chunkId 回表取完整正文（保持 hit 顺序）
  const chunkIds = hits.map((hit) => hit.chunkId);
  const fetched = getContextChunks(db, userId, chunkIds);
  const chunkById = new Map<number, ContextChunk>();
  for (const chunk of fetched) chunkById.set(chunk.chunkId, chunk);

  let chunks: RankedChunk[] = hits
    .map((hit) => chunkById.get(hit.chunkId))
    .filter((chunk): chunk is ContextChunk => Boolean(chunk))
    .map((chunk) => ({ ...chunk }));

  let reranked = false;

  // ② 可选 rerank：provider 可用 + 用户启用 + 候选数 > 1 才重排；失败/空结果 -> 保持 RRF 原序
  if (rerank.available && rerankEnabled && chunks.length > 1) {
    try {
      const results = await rerank.rerank(query, chunks.map((chunk) => chunk.content));
      if (results.length > 0) {
        const reordered: RankedChunk[] = [];
        const seen = new Set<number>();
        for (const result of results) {
          const chunk = chunks[result.index];
          if (chunk && !seen.has(result.index)) {
            seen.add(result.index);
            reordered.push({ ...chunk, rerankScore: result.score });
          }
        }
        // 防御上游漏返回部分 index：未命中的候选按原序补在末尾
        chunks.forEach((chunk, index) => {
          if (!seen.has(index)) reordered.push(chunk);
        });
        chunks = reordered;
        reranked = true;
      }
    } catch {
      reranked = false;
    }
  }

  // ③ 截取最终条数
  const limit = Math.max(1, Math.trunc(finalK));
  chunks = chunks.slice(0, limit);

  // ④ 统计 docCount 与按 docId 分组
  const docIdSet = new Set<number>();
  const groupedByDoc = new Map<number, RankedChunk[]>();
  for (const chunk of chunks) {
    docIdSet.add(chunk.docId);
    const group = groupedByDoc.get(chunk.docId);
    if (group) group.push(chunk);
    else groupedByDoc.set(chunk.docId, [chunk]);
  }

  return {
    chunks,
    reranked,
    docCount: docIdSet.size,
    groupedByDoc,
  };
}
