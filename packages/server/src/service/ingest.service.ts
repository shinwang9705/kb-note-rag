/**
 * 入库服务：解析 -> 分块 -> 落库（chunks + FTS）->（可选）向量化 -> 置为 ready。
 *
 * 关键约定：
 *   1. 文档状态机：pending -> processing -> ready / failed。任何一步失败都要落到 failed 并写入 error_message。
 *   2. 所有写操作强制带 user_id，任务表 / 文档表 / 片段表三处一致。
 *   3. 向量化是**可选增强**：provider 不可用或 sqlite-vec 未装载时静默跳过，
 *      文档照样 ready，检索降级为纯关键词。
 *   4. 原文落盘（uploads/<userId>/<docId>/<file>），保证可回溯与下载。
 */
import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DocumentStatus, RagChunkSettings } from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { ApiError } from '../http/errors.js';
import { ParseError, extOf, isSupportedExt, parseDocument } from '../parser/index.js';
import { chunkText, chunkTextStructured, type TextChunk } from '../util/text.js';
import { ensureDir, safeJoin, sanitizeFileName, userUploadDir } from '../util/fs.js';
import {
  countDocuments,
  createDocument,
  deleteDocument,
  findDocumentById,
  listReadyDocuments,
  updateDocument,
  type DocumentRow,
} from '../repo/document.repo.js';
import { deleteChunksByDoc, insertChunks, listChunks } from '../repo/chunk.repo.js';
import { storageBytesOf } from '../repo/usage.repo.js';
import {
  INGEST_STAGE,
  createIngestTask,
  updateIngestTask,
  type IngestTaskRow,
} from '../repo/ingest-task.repo.js';
import { deleteVectorsByChunkIds, insertVectors, type VectorRow } from '../repo/vector.repo.js';
import { findLibraryById } from '../repo/library.repo.js';
import type { EmbeddingLogger, EmbeddingProvider } from '../embedding/types.js';

/** 单个文档允许的最大片段数，防止超大文件拖垮库 */
export const MAX_CHUNKS_PER_DOC = 2000;

export interface IngestContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
  chunk?: RagChunkSettings;
  logger?: EmbeddingLogger | null;
}

export interface IngestUploadInput {
  userId: number;
  libraryId: number | null;
  fileName: string;
  buffer: Buffer;
  mimeType?: string | null;
  title?: string | null;
}

export interface IngestTextInput {
  userId: number;
  libraryId: number | null;
  title: string;
  content: string;
}

export interface IngestResult {
  documentId: number;
  taskId: number;
  title: string;
  status: DocumentStatus;
  charCount: number;
  chunkCount: number;
  vectorCount: number;
  fileExt: string | null;
  message: string | null;
}

function log(ctx: IngestContext, level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
  const logger = ctx.logger;
  if (!logger) return;
  logger[level](message);
}

/** 把任意异常归一为 ApiError（ParseError 保留业务码与 errno） */
export function toIngestError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ParseError) {
    return new ApiError(error.code, error.message, error.statusCode, { errNo: error.errNo });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError('INTERNAL_ERROR', `入库失败：${message}`, 500);
}

/** 去掉扩展名后的文件名，用作兜底标题 */
function titleFromFileName(fileName: string): string {
  const base = path.basename(fileName);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 检查知识库归属；null 表示不挂库 */
function assertLibraryOwned(ctx: IngestContext, userId: number, libraryId: number | null): void {
  if (libraryId === null || libraryId === undefined) return;
  const id = Number(libraryId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest('非法的 libraryId');
  if (!findLibraryById(ctx.db, userId, id)) {
    throw ApiError.notFound('知识库不存在或无权访问');
  }
}

/** 检查文档数配额 */
function assertWithinQuota(ctx: IngestContext, userId: number): void {
  const used = countDocuments(ctx.db, userId);
  if (used >= ctx.config.quota.maxDocumentsPerUser) {
    throw ApiError.conflict(
      `文档数量已达上限（${ctx.config.quota.maxDocumentsPerUser}），请先删除部分文档`,
    );
  }
}

/** 字节数转可读字符串 */
function humanizeBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

/** 检查存储总量配额（现有占用 + 本批字节 ≤ maxTotalBytes） */
function assertWithinStorageQuota(ctx: IngestContext, userId: number, incomingBytes: number, replacedBytes = 0): void {
  const used = storageBytesOf(ctx.db, userId);
  const max = ctx.config.quota.maxTotalBytes;
  if (used - replacedBytes + Math.max(0, Math.trunc(incomingBytes)) > max) {
    throw new ApiError(
      'QUOTA_BYTES_EXCEEDED',
      `存储空间已达上限（${humanizeBytes(max)}），请先删除部分文档`,
      409,
    );
  }
}

/**
 * 把原文落盘，返回相对 dataDir 的存储路径（统一用 / 分隔，便于跨平台读取）。
 */
function persistSourceFile(ctx: IngestContext, userId: number, docId: number, fileName: string, data: Buffer): string {
  const dir = ensureDir(userUploadDir(ctx.config.db.dataDir, userId, docId));
  const target = safeJoin(dir, sanitizeFileName(fileName, `doc-${docId}.bin`));
  writeFileSync(target, data);
  return path.relative(ctx.config.db.dataDir, target).split(path.sep).join('/');
}

/** 解析原文为纯文本 */
async function runParse(ctx: IngestContext, task: IngestTaskRow, input: {
  buffer: Buffer;
  fileName: string;
  ext: string | null;
}): Promise<{ text: string; title: string | null }> {
  updateIngestTask(ctx.db, task.user_id, task.id, {
    status: 'running',
    stage: INGEST_STAGE.PARSE,
    progress: 20,
  });

  if (input.ext === null) {
    // 纯文本入库：内容已是文本，无需解析器
    return { text: input.buffer.toString('utf8'), title: null };
  }
  const parsed = await parseDocument({ buffer: input.buffer, fileName: input.fileName, ext: input.ext });
  return { text: parsed.text, title: parsed.title };
}

/** 分块（结构感知：按标题/段落优先切割 + 章节路径） */
function runChunk(ctx: IngestContext, task: IngestTaskRow, text: string): TextChunk[] {
  updateIngestTask(ctx.db, task.user_id, task.id, { stage: INGEST_STAGE.CHUNK, progress: 45 });
  const rule = ctx.chunk ?? { strategy: 'structured', size: ctx.config.chunk.size, overlap: ctx.config.chunk.overlap, breakMode: 'sentence', preserveSectionPath: true };
  const chunkOptions = { size: rule.size, overlap: rule.overlap, breakMode: rule.breakMode, preserveSectionPath: rule.preserveSectionPath } as const;
  const chunks = rule.strategy === 'sliding' ? chunkText(text, chunkOptions) : chunkTextStructured(text, chunkOptions);
  if (chunks.length === 0) {
    throw ParseError.empty('文档中没有可检索的文本内容');
  }
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    throw ApiError.badRequest(
      `文档过大：切出 ${chunks.length} 个片段，超过单文档上限 ${MAX_CHUNKS_PER_DOC}`,
    );
  }
  return chunks;
}

/** 写入片段（FTS 由触发器自动同步） */
function runIndex(ctx: IngestContext, task: IngestTaskRow, docId: number, chunks: readonly TextChunk[]): number[] {
  updateIngestTask(ctx.db, task.user_id, task.id, { stage: INGEST_STAGE.INDEX, progress: 70 });
  return ctx.db.driver.transaction(() => {
    deleteChunksByDoc(ctx.db, task.user_id, docId);
    return insertChunks(ctx.db, task.user_id, docId, chunks);
  });
}

/** 可选向量化：不可用时返回 0，不抛错 */
async function runEmbed(
  ctx: IngestContext,
  task: IngestTaskRow,
  docId: number,
  chunkIds: readonly number[],
  chunks: readonly TextChunk[],
): Promise<number> {
  if (!ctx.embedding.available || !ctx.db.vecAvailable) return 0;
  if (chunkIds.length === 0) return 0;

  updateIngestTask(ctx.db, task.user_id, task.id, { stage: INGEST_STAGE.EMBED, progress: 85 });
  try {
    const vectors = await ctx.embedding.embed(chunks.map((chunk) => chunk.content));
    if (vectors.length !== chunkIds.length) return 0;
    const rows: VectorRow[] = chunkIds.map((chunkId, i) => ({
      chunkId,
      vector: vectors[i] ?? [],
    }));
    return ctx.db.driver.transaction(() => insertVectors(ctx.db, task.user_id, docId, rows));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(ctx, 'warn', `[ingest] 文档 ${docId} 向量化失败，降级为关键词检索：${message}`);
    return 0;
  }
}

/** 标记失败（文档 + 任务），并原样抛出异常供路由层返回 */
function markFailed(ctx: IngestContext, task: IngestTaskRow, docId: number, error: unknown): never {
  const apiError = toIngestError(error);
  try {
    updateDocument(ctx.db, task.user_id, docId, {
      status: 'failed',
      errorMessage: apiError.message,
    });
    updateIngestTask(ctx.db, task.user_id, task.id, {
      status: 'failed',
      stage: INGEST_STAGE.DONE,
      progress: 100,
      message: apiError.message,
    });
  } catch (inner) {
    log(ctx, 'error', `[ingest] 标记失败状态时出错：${inner instanceof Error ? inner.message : String(inner)}`);
  }
  throw apiError;
}

/** 入库主流程（上传文件与纯文本共用） */
async function runIngest(
  ctx: IngestContext,
  options: {
    userId: number;
    libraryId: number | null;
    sourceType: 'upload' | 'text';
    fileName: string;
    ext: string | null;
    buffer: Buffer;
    mimeType: string | null;
    defaultTitle: string;
    overrideTitle?: string | null;
  },
): Promise<IngestResult> {
  assertLibraryOwned(ctx, options.userId, options.libraryId);
  assertWithinQuota(ctx, options.userId);
  assertWithinStorageQuota(ctx, options.userId, options.buffer.byteLength);

  const doc: DocumentRow = createDocument(ctx.db, {
    userId: options.userId,
    libraryId: options.libraryId,
    title: options.overrideTitle?.trim() || options.defaultTitle,
    sourceType: options.sourceType,
    fileName: options.sourceType === 'upload' ? options.fileName : null,
    fileExt: options.ext,
    fileSize: options.buffer.byteLength,
    mimeType: options.mimeType,
    status: 'processing',
  });

  const task = createIngestTask(ctx.db, options.userId, doc.id);

  try {
    const storagePath = persistSourceFile(
      ctx,
      options.userId,
      doc.id,
      options.sourceType === 'upload' ? options.fileName : `${sanitizeFileName(options.defaultTitle, `doc-${doc.id}`)}.txt`,
      options.buffer,
    );

    updateDocument(ctx.db, options.userId, doc.id, { storagePath });
    const { text, title } = await runParse(ctx, task, {
      buffer: options.buffer,
      fileName: options.fileName,
      ext: options.ext,
    });

    const chunks = runChunk(ctx, task, text);
    const chunkIds = runIndex(ctx, task, doc.id, chunks);
    const vectorCount = await runEmbed(ctx, task, doc.id, chunkIds, chunks);

    const finalTitle = options.overrideTitle?.trim() || title?.trim() || options.defaultTitle;
    const updated = updateDocument(ctx.db, options.userId, doc.id, {
      status: 'ready',
      charCount: text.length,
      chunkCount: chunks.length,
      storagePath,
      errorMessage: null,
      title: finalTitle,
    });

    updateIngestTask(ctx.db, options.userId, task.id, {
      status: 'done',
      stage: INGEST_STAGE.DONE,
      progress: 100,
      message: `解析完成：${chunks.length} 个片段${vectorCount > 0 ? `，${vectorCount} 条向量` : ''}`,
    });

    log(
      ctx,
      'info',
      `[ingest] 文档 ${doc.id} 入库完成：chars=${text.length} chunks=${chunks.length} vectors=${vectorCount}`,
    );

    return {
      documentId: doc.id,
      taskId: task.id,
      title: finalTitle,
      status: updated?.status ?? 'ready',
      charCount: text.length,
      chunkCount: chunks.length,
      vectorCount,
      fileExt: options.ext,
      message: null,
    };
  } catch (error) {
    return markFailed(ctx, task, doc.id, error);
  }
}

/**
 * 上传文件入库。
 * @throws ApiError 40011 不支持类型 / 40012 无有效文本 / 40013 解析失败 / 409 超额
 */
export async function ingestUpload(ctx: IngestContext, input: IngestUploadInput): Promise<IngestResult> {
  const fileName = sanitizeFileName(input.fileName, 'unnamed');
  const ext = extOf(fileName);

  if (!isSupportedExt(ext)) {
    throw new ApiError('UNSUPPORTED_TYPE', `不支持的文件类型：${ext || '(无扩展名)'}`, 400, {
      errNo: 40011,
    });
  }

  const maxBytes = Math.max(1, ctx.config.quota.maxUploadMb) * 1024 * 1024;
  if (input.buffer.byteLength > maxBytes) {
    throw new ApiError(
      'FILE_TOO_LARGE',
      `文件超过大小上限 ${ctx.config.quota.maxUploadMb}MB`,
      413,
    );
  }
  if (input.buffer.byteLength === 0) {
    throw new ApiError('EMPTY_FILE', '文件内容为空', 400, { errNo: 40012 });
  }

  return runIngest(ctx, {
    userId: input.userId,
    libraryId: input.libraryId ?? null,
    sourceType: 'upload',
    fileName,
    ext,
    buffer: input.buffer,
    mimeType: input.mimeType ?? null,
    defaultTitle: titleFromFileName(fileName),
    overrideTitle: input.title ?? null,
  });
}

/** 纯文本入库（source_type='text'，落盘为 .txt 便于下载） */
export async function ingestText(ctx: IngestContext, input: IngestTextInput): Promise<IngestResult> {
  const content = (input.content ?? '').trim();
  const title = (input.title ?? '').trim();
  if (!title) throw ApiError.badRequest('缺少标题');
  if (!content) throw ApiError.badRequest('内容为空');

  const buffer = Buffer.from(content, 'utf8');
  return runIngest(ctx, {
    userId: input.userId,
    libraryId: input.libraryId ?? null,
    sourceType: 'text',
    fileName: `${sanitizeFileName(title, 'untitled')}.txt`,
    ext: null,
    buffer,
    mimeType: 'text/plain; charset=utf-8',
    defaultTitle: title,
    overrideTitle: title,
  });
}

/**
 * 删除文档及其全部派生数据（向量 -> 片段 -> 文档 -> 磁盘文件）。
 * 顺序不可颠倒：先删向量（rowid 关联 chunks.id），再删片段（触发器同步清理 FTS）。
 */
export function deleteDocumentCascade(ctx: IngestContext, userId: number, docId: number): boolean {
  const doc = findDocumentById(ctx.db, userId, docId);
  if (!doc) return false;

  const removed = ctx.db.driver.transaction(() => {
  if (ctx.db.vecAvailable) {
    const chunkIds = listChunks(ctx.db, userId, docId).map((row) => Number(row.id));
    if (chunkIds.length > 0) {
      deleteVectorsByChunkIds(ctx.db, chunkIds);
    }
  }

  deleteChunksByDoc(ctx.db, userId, docId);
  return deleteDocument(ctx.db, userId, docId);
  });

  if (doc.storage_path) {
    try {
      const expectedDir = userUploadDir(ctx.config.db.dataDir, userId, docId);
      const abs = safeJoin(ctx.config.db.dataDir, doc.storage_path.split('/').join(path.sep));
      if (path.dirname(path.resolve(abs)) !== path.resolve(expectedDir)) throw new Error('原文路径不属于此文档，拒绝清理');
      rmSync(expectedDir, { recursive: true, force: true });
    } catch (error) {
      log(ctx, 'warn', `[ingest] 清理磁盘文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return removed;
}

export interface ReplaceDocumentInput {
  userId: number;
  docId: number;
  buffer: Buffer;
  fileName: string;
  mimeType?: string | null;
  title?: string | null;
}

export interface ReplaceDocumentResult {
  docId: number;
  status: DocumentStatus;
  charCount: number;
  chunkCount: number;
  vectorCount: number;
  fileExt: string | null;
}

/**
 * 替换文档内容 + 失败回滚（DOC-05）。
 * 回滚的本质 = 先解析后换库：解析/分块失败发生在任何写库之前，旧文档原样可用。
 */
export async function replaceDocument(
  ctx: IngestContext,
  input: ReplaceDocumentInput,
): Promise<ReplaceDocumentResult> {
  const doc = findDocumentById(ctx.db, input.userId, input.docId);
  if (!doc) throw new ApiError('DOCUMENT_NOT_FOUND', '文档不存在或无权访问', 404);
  if (doc.status !== 'ready') throw new ApiError('DOC_NOT_READY', '文档尚未就绪，无法替换', 409);

  const fileName = sanitizeFileName(input.fileName, 'unnamed');
  const ext = extOf(fileName);
  if (!isSupportedExt(ext)) {
    throw new ApiError(
      'UNSUPPORTED_EXT',
      `不支持的文件类型：${ext || '(无扩展名)'}`,
      415,
      { errNo: 40011 },
    );
  }

  const maxBytes = Math.max(1, ctx.config.quota.maxUploadMb) * 1024 * 1024;
  if (input.buffer.byteLength > maxBytes) {
    throw new ApiError('FILE_TOO_LARGE', `文件超过大小上限 ${ctx.config.quota.maxUploadMb}MB`, 413);
  }
  if (input.buffer.byteLength === 0) {
    throw new ApiError('EMPTY_FILE', '文件内容为空', 400, { errNo: 40012 });
  }
  assertWithinStorageQuota(ctx, input.userId, input.buffer.byteLength, doc.file_size);

  const task = createIngestTask(ctx.db, input.userId, input.docId);

  // ---------- 事务外解析：失败直接抛错，旧文档原样可用（回滚的关键） ----------
  let text: string;
  let parsedTitle: string | null;
  let chunks: TextChunk[];
  try {
    const parsed = await runParse(ctx, task, { buffer: input.buffer, fileName, ext });
    text = parsed.text;
    parsedTitle = parsed.title;
    chunks = runChunk(ctx, task, text);
  } catch (error) {
    // 解析/分块失败统一映射为 415 FILE_TYPE_MISMATCH（内容与扩展名不符 / 文件损坏）
    const apiError =
      error instanceof ParseError
        ? new ApiError('FILE_TYPE_MISMATCH', error.message, 415, { errNo: error.errNo })
        : toIngestError(error);
    updateIngestTask(ctx.db, input.userId, task.id, {
      status: 'failed',
      stage: INGEST_STAGE.DONE,
      progress: 100,
      message: apiError.message,
    });
    throw apiError;
  }

  // 新文件使用不可变路径；写盘和向量准备失败时不改变旧正文/索引。
  let newStoragePath: string | null = null;
  let vectorCount = 0;
  try {
    newStoragePath = persistSourceFile(ctx, input.userId, input.docId, `revision-${randomUUID()}-${fileName}`, input.buffer);
    const vectors = await prepareReplacementVectors(ctx, chunks);
    ctx.db.driver.transaction(() => {
      assertUnchanged(ctx, doc);
      assertWithinStorageQuota(ctx, input.userId, input.buffer.byteLength, doc.file_size);
      const ids = swapChunks(ctx, doc, chunks, vectors);
      vectorCount = vectors.length ? ids.length : 0;
      updateDocument(ctx.db, input.userId, input.docId, {
        status: 'ready', charCount: text.length, chunkCount: chunks.length,
        title: input.title?.trim() || parsedTitle?.trim() || doc.title,
        storagePath: newStoragePath, fileName, fileExt: ext, fileSize: input.buffer.byteLength,
        mimeType: input.mimeType ?? null, sourceType: 'upload', errorMessage: null,
      });
      updateIngestTask(ctx.db, input.userId, task.id, {
        status: 'done', stage: INGEST_STAGE.DONE, progress: 100,
        message: `替换完成：${chunks.length} 个片段，${vectorCount} 条向量`,
      });
    });
  } catch (error) {
    if (newStoragePath) removeSourceFile(ctx, newStoragePath);
    const apiError = toIngestError(error);
    updateIngestTask(ctx.db, input.userId, task.id, {
      status: 'failed', stage: INGEST_STAGE.DONE, progress: 100, message: apiError.message,
    });
    throw apiError;
  }
  // 提交之后才清理旧文件；清理失败仅记日志，不能撤销已提交版本。
  if (doc.storage_path && doc.storage_path !== newStoragePath) removeSourceFile(ctx, doc.storage_path);

  log(ctx, 'info', `[replace] 文档 ${input.docId} 替换完成：chars=${text.length} chunks=${chunks.length}`);

  return {
    docId: input.docId,
    status: 'ready',
    charCount: text.length,
    chunkCount: chunks.length,
    vectorCount,
    fileExt: ext,
  };
}

export interface ReindexInput {
  /** null 表示跨用户（仅管理员全量重建） */
  userId?: number | null;
  libraryId?: number | null;
}

export interface ReindexResult {
  docs: number;
  reindexed: number;
  failed: Array<{ docId: number; error: string }>;
}

/**
 * 全量重建索引（IDX-06）：迭代 ready 文档，读回原文 -> parse -> chunk -> 换库 -> embed。
 * 同步循环，单篇先删后建；失败不影响其余文档。
 */
export async function reindexAll(ctx: IngestContext, input: ReindexInput): Promise<ReindexResult> {
  const docs = listReadyDocuments(ctx.db, input.userId ?? null, input.libraryId ?? null);
  const failed: Array<{ docId: number; error: string }> = [];
  let reindexed = 0;

  for (const doc of docs) {
    try {
      await reindexDocument(ctx, doc);
      reindexed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(ctx, 'warn', `[reindex] 文档 ${doc.id} 重建失败：${message}`);
      failed.push({ docId: doc.id, error: message });
    }
  }

  return { docs: docs.length, reindexed, failed };
}

/** 单文档重建：复用 parse/chunk/index/embed 管线，不新建文档行 */
async function reindexDocument(ctx: IngestContext, doc: DocumentRow): Promise<void> {
  const userId = doc.user_id;
  if (!doc.storage_path) throw new Error('文档缺少原文文件');

  const abs = safeJoin(ctx.config.db.dataDir, doc.storage_path.split('/').join(path.sep));
  const buffer = readFileSync(abs);
  const fileName = doc.file_name ?? `${doc.title}.txt`;
  const ext = doc.source_type === 'text' ? null : (doc.file_ext ?? extOf(fileName));

  const task = createIngestTask(ctx.db, userId, doc.id);

  try {
    const { text, title } = await runParse(ctx, task, { buffer, fileName, ext });
    const chunks = runChunk(ctx, task, text);
    const vectors = await prepareReplacementVectors(ctx, chunks);
    ctx.db.driver.transaction(() => {
      assertUnchanged(ctx, doc);
      swapChunks(ctx, doc, chunks, vectors);
      updateDocument(ctx.db, userId, doc.id, {
        status: 'ready', charCount: text.length, chunkCount: chunks.length,
        title: title?.trim() || doc.title, errorMessage: null,
      });
      updateIngestTask(ctx.db, userId, task.id, {
        status: 'done', stage: INGEST_STAGE.DONE, progress: 100,
        message: `重建完成：${chunks.length} 个片段，${vectors.length} 条向量`,
      });
    });
  } catch (error) {
    updateIngestTask(ctx.db, userId, task.id, {
      status: 'failed', stage: INGEST_STAGE.DONE, progress: 100,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export type { DocumentRow, IngestTaskRow };


/** 替换/重建不能在模型故障时毁掉仍可用的旧索引。 */
async function prepareReplacementVectors(ctx: IngestContext, chunks: readonly TextChunk[]): Promise<number[][]> {
  if (!ctx.embedding.available || !ctx.db.vecAvailable) return [];
  const vectors = await ctx.embedding.embed(chunks.map((chunk) => chunk.content));
  if (vectors.length !== chunks.length || vectors.some((v) =>
    v.length !== ctx.embedding.dim || !v.every(Number.isFinite) || !v.some((value) => value !== 0))) {
    throw new ApiError('EMBEDDING_FAILED', '向量生成失败，已保留旧文档与索引，请稍后重试', 503);
  }
  return vectors;
}

function assertUnchanged(ctx: IngestContext, original: DocumentRow): void {
  const current = findDocumentById(ctx.db, original.user_id, original.id);
  if (!current || current.storage_path !== original.storage_path || current.updated_at !== original.updated_at) {
    throw new ApiError('DOCUMENT_CHANGED', '文档已被修改或删除，请刷新后重试', 409);
  }
}

/** 必须在调用方的事务中执行。 */
function swapChunks(ctx: IngestContext, doc: DocumentRow, chunks: readonly TextChunk[], vectors: number[][]): number[] {
  const oldIds = listChunks(ctx.db, doc.user_id, doc.id).map((row) => Number(row.id));
  if (ctx.db.vecAvailable) deleteVectorsByChunkIds(ctx.db, oldIds);
  deleteChunksByDoc(ctx.db, doc.user_id, doc.id);
  const ids = insertChunks(ctx.db, doc.user_id, doc.id, chunks);
  if (vectors.length) insertVectors(ctx.db, doc.user_id, doc.id, ids.map((chunkId, i) => ({ chunkId, vector: vectors[i]! })));
  return ids;
}

function removeSourceFile(ctx: IngestContext, storagePath: string): void {
  try { unlinkSync(safeJoin(ctx.config.db.dataDir, storagePath.split('/').join(path.sep))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log(ctx, 'warn', `[ingest] 清理旧/暂存文件失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
