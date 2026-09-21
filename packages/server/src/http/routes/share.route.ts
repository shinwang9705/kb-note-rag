/**
 * 知识库只读共享路由（四期 T04）。
 *
 *   POST   /api/libraries/:id/share    -> { token, url }（requireAuth，owner；已分享则续期同 token）
 *   DELETE /api/libraries/:id/share    -> { id, revoked: true }（requireAuth，owner）
 *   GET    /api/share/:token           -> { library:{ name, description, docCount } }（公开）
 *   GET    /api/share/:token/documents -> { items: ShareDoc[] }（公开，脱敏白名单）
 *   POST   /api/share/:token/search    -> SearchResult（公开，只读检索，限定该库 + owner 边界）
 *
 * 只读边界：本文件不提供 upload/delete/patch/replace/text 等任何写入口；
 * 写接口的 requireAuth 不认 share token（share token 非 JWT，optionalAuth 解析不出 userId，自然 401）。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ShareDoc } from '@kb/shared';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import type { EmbeddingProvider } from '../../embedding/types.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ApiError, ok } from '../errors.js';
import { findLibraryById } from '../../repo/library.repo.js';
import { countDocuments, listDocuments, type DocumentRow } from '../../repo/document.repo.js';
import {
  createShare,
  deleteShareByLibrary,
  findActiveShareByLibrary,
} from '../../repo/share.repo.js';
import { buildShareUrl, generateShareToken, resolveShareScope } from '../../service/share.service.js';
import { search } from '../../service/search.service.js';

export interface ShareRouteContext {
  db: DbHandle;
  config: AppConfig;
  embedding: EmbeddingProvider;
}

interface LibraryIdParams {
  id: string;
}

interface TokenParams {
  token: string;
}

interface CreateShareBody {
  expiresInDays?: number | null;
}

interface ShareSearchBody {
  query: string;
  topK?: number;
  finalK?: number;
}

function parseId(raw: string | undefined): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

/** expiresInDays 校验 + 转 ISO-8601 UTC；null/缺省/0 = 永久；非有限数或 <0 -> 400 */
function parseExpiresAt(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new ApiError('VALIDATION_ERROR', 'expiresInDays 必须为非负整数', 400);
  }
  if (days <= 0) return null;
  return new Date(Date.now() + Math.trunc(days) * 86400_000).toISOString();
}

/** 文档行 -> 脱敏白名单 DTO（不含 storage_path/error_message/userId/mimeType/fileName） */
function toShareDocDto(row: DocumentRow): ShareDoc {
  return {
    id: row.id,
    title: row.title,
    fileExt: row.file_ext,
    charCount: row.char_count,
    chunkCount: row.chunk_count,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function createShareRoutes(ctx: ShareRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function shareRoutes(app) {
    /** POST /api/libraries/:id/share —— 生成/续期分享链接（owner） */
    app.post<{ Params: LibraryIdParams; Body: CreateShareBody }>(
      '/api/libraries/:id/share',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: LibraryIdParams; Body: CreateShareBody }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');

        const library = findLibraryById(ctx.db, request.userId, id);
        if (!library) throw ApiError.notFound('知识库不存在或无权访问');

        const existing = findActiveShareByLibrary(ctx.db, id);
        if (existing) {
          return ok({ token: existing.token, url: buildShareUrl(ctx.config, existing.token) });
        }

        const token = generateShareToken();
        createShare(ctx.db, id, request.userId, token, parseExpiresAt(request.body?.expiresInDays));
        return ok({ token, url: buildShareUrl(ctx.config, token) });
      },
    );

    /** DELETE /api/libraries/:id/share —— 撤销分享（owner） */
    app.delete<{ Params: LibraryIdParams }>(
      '/api/libraries/:id/share',
      { onRequest: [requireAuth] },
      async (request: FastifyRequest<{ Params: LibraryIdParams }>) => {
        const id = parseId(request.params.id);
        if (id === null) throw ApiError.badRequest('非法的 id');

        const library = findLibraryById(ctx.db, request.userId, id);
        if (!library) throw ApiError.notFound('知识库不存在或无权访问');

        deleteShareByLibrary(ctx.db, id);
        return ok({ id, revoked: true });
      },
    );

    /** GET /api/share/:token —— 公开元信息（库名/描述/文档数） */
    app.get<{ Params: TokenParams }>(
      '/api/share/:token',
      async (request: FastifyRequest<{ Params: TokenParams }>) => {
        const scope = resolveShareScope(ctx.db, request.params.token);
        const docCount = countDocuments(ctx.db, scope.ownerUserId, { libraryId: scope.libraryId });
        return ok({
          library: { name: scope.libraryName, description: scope.libraryDescription, docCount },
        });
      },
    );

    /** GET /api/share/:token/documents —— 公开文档列表（脱敏白名单） */
    app.get<{ Params: TokenParams }>(
      '/api/share/:token/documents',
      async (request: FastifyRequest<{ Params: TokenParams }>) => {
        const scope = resolveShareScope(ctx.db, request.params.token);
        const rows = listDocuments(ctx.db, scope.ownerUserId, { libraryId: scope.libraryId });
        return ok({ items: rows.map(toShareDocDto), total: rows.length });
      },
    );

    /** POST /api/share/:token/search —— 公开只读检索（复用 search，owner+库边界） */
    app.post<{ Params: TokenParams; Body: ShareSearchBody }>(
      '/api/share/:token/search',
      {
        schema: {
          body: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 2000 },
              topK: { type: 'integer', minimum: 1, maximum: 50 },
              finalK: { type: 'integer', minimum: 1, maximum: 50 },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: TokenParams; Body: ShareSearchBody }>) => {
        const scope = resolveShareScope(ctx.db, request.params.token);
        const query = (request.body?.query ?? '').trim();
        if (!query) throw ApiError.badRequest('查询不能为空');

        const result = await search(
          { db: ctx.db, config: ctx.config, embedding: ctx.embedding },
          {
            userId: scope.ownerUserId,
            query,
            libraryId: scope.libraryId,
            docId: null,
            mode: 'auto',
            topK: request.body?.topK,
            finalK: request.body?.finalK,
          },
        );
        return ok(result);
      },
    );
  };
}
