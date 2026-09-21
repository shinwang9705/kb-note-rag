/**
 * 文档路由：上传入库、纯文本入库、列表、详情、片段、下载、删除、任务查询。
 *
 * 隔离铁律：所有 handler 一律用 request.userId 作为数据边界，
 * 且 repository 层再次强制 WHERE user_id = ? —— 越权一律表现为 404，不泄露存在性。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import { createRequireAdminHook, createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { EXT_MIME } from '@kb/shared';
import { safeJoin } from '../../util/fs.js';
import {
  countChunks,
  listChunks,
  type ChunkRow,
} from '../../repo/chunk.repo.js';
import {
  findDocumentById,
  countDocuments,
  listDocuments,
  updateDocument,
  type DocumentRow,
} from '../../repo/document.repo.js';
import {
  createTag,
  deleteTag,
  listTags,
  listTagsForDocs,
  setDocTags,
} from '../../repo/tag.repo.js';
import { findLatestTaskByDoc } from '../../repo/ingest-task.repo.js';
import {
  deleteDocumentCascade,
  ingestText,
  ingestUpload,
  replaceDocument,
  reindexAll,
  toIngestError,
  type IngestContext,
} from '../../service/ingest.service.js';

export interface DocumentRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
}

interface DocIdParams {
  id: string;
}

interface ListQuery {
  libraryId?: number;
  status?: string;
  tagId?: number;
  favorite?: string;
  limit?: number;
  offset?: number;
}

interface UploadQuery {
  libraryId?: number;
  title?: string;
}

interface TextBody {
  title: string;
  content: string;
  libraryId?: number | null;
}

/** 把 FastifyRequest 上的 id 参数解析为正整数；非法返回 null */
function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/** 文档行 -> DTO（下划线转驼峰，不暴露内部字段）；tags 由调用方批量聚合后传入 */
function toDto(row: DocumentRow, tags: string[] = []) {
  return {
    id: row.id,
    userId: row.user_id,
    libraryId: row.library_id,
    title: row.title,
    sourceType: row.source_type,
    fileName: row.file_name,
    fileExt: row.file_ext,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    status: row.status,
    errorMessage: row.error_message,
    isFavorite: row.is_favorite === 1,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChunkDto(row: ChunkRow) {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end,
    ...(row.section_path ? { sectionPath: row.section_path } : {}),
  };
}

/** 构造入库上下文（日志桥接 Fastify 的 request.log） */
function ingestContextOf(ctx: DocumentRouteContext, request: FastifyRequest): IngestContext {
  return {
    db: ctx.db,
    config: ctx.config,
    embedding: ctx.embedding,
    logger: {
      info: (message: string) => request.log.info(message),
      warn: (message: string) => request.log.warn(message),
      error: (message: string) => request.log.error(message),
      debug: (message: string) => request.log.debug(message),
    },
  };
}

export function createDocumentRoutes(ctx: DocumentRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);
  const requireAdmin = createRequireAdminHook();

  return async function documentRoutes(app) {
    const maxBytes = Math.max(1, ctx.config.quota.maxUploadMb) * 1024 * 1024;

    await app.register(multipart, {
      limits: {
        fileSize: maxBytes,
        files: Math.max(1, ctx.config.quota.maxFilesPerUpload),
        fields: 10,
        fieldNameSize: 200,
      },
    });

    /** POST /api/documents/upload —— 批量上传（单文件失败不影响其余） */
    app.post<{ Querystring: UploadQuery }>(
      '/api/documents/upload',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Querystring: UploadQuery }>) => {
        const query = request.query ?? {};
        const accepted: Array<{ docId: number; title: string; status: string }> = [];
        const rejected: Array<{ fileName: string; code: string; message: string }> = [];
        let fileCount = 0;

        for await (const part of request.parts()) {
          if (part.type !== 'file') continue;
          fileCount += 1;
          const fileName = part.filename || 'unnamed';
          try {
            const buffer = await part.toBuffer();
            const result = await ingestUpload(ingestContextOf(ctx, request), {
              userId: request.userId,
              libraryId: query.libraryId ?? null,
              fileName,
              buffer,
              mimeType: part.mimetype || null,
              title: null,
            });
            accepted.push({ docId: result.documentId, title: result.title, status: result.status });
          } catch (error) {
            const apiError = toIngestError(error);
            rejected.push({ fileName, code: apiError.code, message: apiError.message });
          }
        }

        if (fileCount === 0) throw ApiError.badRequest('缺少上传文件');
        return ok({ accepted, rejected });
      },
    );

    /** POST /api/documents/text —— 纯文本入库 */
    app.post<{ Body: TextBody }>(
      '/api/documents/text',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['title', 'content'],
            additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              content: { type: 'string', minLength: 1 },
              libraryId: { type: ['integer', 'null'], minimum: 1, default: null },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: TextBody }>) => {
        const result = await ingestText(ingestContextOf(ctx, request), {
          userId: request.userId,
          libraryId: request.body.libraryId ?? null,
          title: request.body.title,
          content: request.body.content,
        });
        const doc = findDocumentById(ctx.db, request.userId, result.documentId);
        return ok({ item: doc ? toDto(doc) : null, ingest: result });
      },
    );

    /** GET /api/documents —— 列表（可按知识库 / 状态过滤） */
    app.get<{ Querystring: ListQuery }>(
      '/api/documents',
      {
        onRequest: [requireAuth],
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: {
              libraryId: { type: 'integer', minimum: 1 },
              status: { type: 'string', enum: ['pending', 'processing', 'ready', 'failed'] },
              tagId: { type: 'integer', minimum: 1 },
              favorite: { type: 'string', enum: ['true', 'false', '1', '0'] },
              limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
              offset: { type: 'integer', minimum: 0, default: 0 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Querystring: ListQuery }>) => {
        const query = request.query ?? {};
        const status = (query.status as DocumentRow['status'] | undefined) ?? null;
        const tagId = query.tagId !== undefined ? Number(query.tagId) : null;
        const favoriteOnly = query.favorite === 'true' || query.favorite === '1';
        const rows = listDocuments(ctx.db, request.userId, {
          libraryId: query.libraryId ?? null,
          status,
          tagId,
          favoriteOnly,
          limit: query.limit ?? 50,
          offset: query.offset ?? 0,
        });
        const tagsMap = listTagsForDocs(ctx.db, request.userId, rows.map((row) => row.id));
        // total 取该过滤条件下的总数（而非当前页条数），否则前端分页会算错
        const total = countDocuments(ctx.db, request.userId, {
          status: status ?? undefined,
          libraryId: query.libraryId ?? null,
          tagId,
          favoriteOnly,
        });
        return ok({ items: rows.map((row) => toDto(row, tagsMap.get(row.id) ?? [])), total });
      },
    );

    /** GET /api/documents/:id */
    app.get<{ Params: DocIdParams }>(
      '/api/documents/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = findDocumentById(ctx.db, request.userId, id);
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        const tagsMap = listTagsForDocs(ctx.db, request.userId, [id]);
        return ok({ item: toDto(doc, tagsMap.get(id) ?? []) });
      },
    );

    /** GET /api/documents/:id/chunks —— 查看切片结果与偏移 */
    app.get<{ Params: DocIdParams }>(
      '/api/documents/:id/chunks',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = findDocumentById(ctx.db, request.userId, id);
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        const rows = listChunks(ctx.db, request.userId, id);
        return ok({ items: rows.map(toChunkDto), total: rows.length });
      },
    );

    /** GET /api/documents/:id/task —— 查看最近一次入库任务 */
    app.get<{ Params: DocIdParams }>(
      '/api/documents/:id/task',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = findDocumentById(ctx.db, request.userId, id);
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        const task = findLatestTaskByDoc(ctx.db, request.userId, id);
        if (!task) throw ApiError.notFound('该文档没有入库任务记录');
        return ok({
          item: {
            id: task.id,
            docId: task.doc_id,
            status: task.status,
            stage: task.stage,
            progress: task.progress,
            message: task.message,
            createdAt: task.created_at,
            updatedAt: task.updated_at,
          },
        });
      },
    );

    /** GET /api/documents/:id/download —— 下载原始文件 */
    app.get<{ Params: DocIdParams }>(
      '/api/documents/:id/download',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>, reply: FastifyReply) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = findDocumentById(ctx.db, request.userId, id);
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        if (!doc.storage_path) throw ApiError.notFound('该文档没有留存原始文件');

        const abs = safeJoin(ctx.config.db.dataDir, doc.storage_path.split('/').join(path.sep));
        if (!existsSync(abs)) throw ApiError.notFound('原始文件已丢失');

        const fileName = doc.file_name || `${doc.title}.${doc.file_ext ?? 'txt'}`;
        const mime = doc.mime_type || EXT_MIME[doc.file_ext ?? ''] || 'application/octet-stream';
        void reply
          .header('Content-Type', mime)
          .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        return reply.send(readFileSync(abs));
      },
    );

    /** DELETE /api/documents/:id —— 级联删除向量 / 片段 / 文档 / 磁盘文件 */
    app.delete<{ Params: DocIdParams }>(
      '/api/documents/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const removed = deleteDocumentCascade(
          { db: ctx.db, config: ctx.config, embedding: ctx.embedding },
          request.userId,
          id,
        );
        if (!removed) throw ApiError.notFound('文档不存在或无权访问');
        return ok({ id, removed, chunkCount: countChunks(ctx.db, request.userId, id) });
      },
    );

    /** GET /api/documents/tags —— 列出本人标签 */
    app.get('/api/documents/tags', { onRequest: [requireAuth] }, async (request) => {
      return ok({ items: listTags(ctx.db, request.userId) });
    });

    /** POST /api/documents/tags —— 创建标签（同名幂等返回既有） */
    app.post<{ Body: { name: string } }>(
      '/api/documents/tags',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
          },
        },
      },
      async (request: FastifyRequest<{ Body: { name: string } }>) => {
        const name = (request.body?.name ?? '').trim();
        if (!name) throw ApiError.badRequest('标签名不能为空');
        const tag = createTag(ctx.db, request.userId, name);
        if (!tag) throw new ApiError('INTERNAL_ERROR', '创建标签失败', 500);
        return ok({ item: tag });
      },
    );

    /** DELETE /api/documents/tags/:id —— 删除标签（关联自动级联） */
    app.delete<{ Params: DocIdParams }>(
      '/api/documents/tags/:id',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const removed = deleteTag(ctx.db, request.userId, id);
        if (!removed) throw ApiError.notFound('标签不存在或无权访问');
        return ok({ id, removed });
      },
    );

    /** POST /api/documents/:id/tags —— 覆盖式设置文档标签（{tagIds}） */
    app.post<{ Params: DocIdParams; Body: { tagIds: number[] } }>(
      '/api/documents/:id/tags',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['tagIds'],
            additionalProperties: false,
            properties: {
              tagIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: DocIdParams; Body: { tagIds: number[] } }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = findDocumentById(ctx.db, request.userId, id);
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        setDocTags(ctx.db, request.userId, id, request.body?.tagIds ?? []);
        const tagsMap = listTagsForDocs(ctx.db, request.userId, [id]);
        return ok({ tags: tagsMap.get(id) ?? [] });
      },
    );

    /** PATCH /api/documents/:id/favorite —— 收藏/取消收藏 */
    app.patch<{ Params: DocIdParams; Body: { isFavorite: boolean } }>(
      '/api/documents/:id/favorite',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            required: ['isFavorite'],
            additionalProperties: false,
            properties: { isFavorite: { type: 'boolean' } },
          },
        },
      },
      async (request: FastifyRequest<{ Params: DocIdParams; Body: { isFavorite: boolean } }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const doc = updateDocument(
          ctx.db,
          request.userId,
          id,
          { isFavorite: request.body?.isFavorite === true },
        );
        if (!doc) throw ApiError.notFound('文档不存在或无权访问');
        const tagsMap = listTagsForDocs(ctx.db, request.userId, [id]);
        return ok({ item: toDto(doc, tagsMap.get(id) ?? []) });
      },
    );

    /** PUT /api/documents/:id/replace —— 替换文档内容（先解析后换库，失败回滚） */
    app.put<{ Params: DocIdParams; Querystring: UploadQuery }>(
      '/api/documents/:id/replace',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: DocIdParams; Querystring: UploadQuery }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');
        const data = await request.file();
        if (!data) throw ApiError.badRequest('缺少上传文件（表单字段名应为 file）');

        const buffer = await data.toBuffer();
        const query = request.query ?? {};
        const result = await replaceDocument(ingestContextOf(ctx, request), {
          userId: request.userId,
          docId: id,
          buffer,
          fileName: data.filename || 'unnamed',
          mimeType: data.mimetype || null,
          title: query.title ?? null,
        });
        return ok(result);
      },
    );

    /** POST /api/reindex —— 重建本人索引（可限定知识库） */
    app.post<{ Body: { libraryId?: number | null } }>(
      '/api/reindex',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Body: { libraryId?: number | null } }>) => {
        const result = await reindexAll(ingestContextOf(ctx, request), {
          userId: request.userId,
          libraryId: request.body?.libraryId ?? null,
        });
        return ok(result);
      },
    );

    /** POST /api/admin/reindex —— 管理员全量重建（可选 userId 限定某用户） */
    app.post<{ Body: { userId?: number | null } }>(
      '/api/admin/reindex',
      { onRequest: [requireAuth, requireAdmin] },
      async (request: FastifyRequest<{ Body: { userId?: number | null } }>) => {
        const result = await reindexAll(ingestContextOf(ctx, request), {
          userId: request.body?.userId ?? null,
        });
        return ok(result);
      },
    );
  };
}
