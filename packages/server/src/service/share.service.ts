/**
 * 知识库只读共享服务（四期 T04）。
 *
 * 隔离语义：share token 只解析出 (ownerUserId, libraryId)，检索仍以 owner 的 user_id 为边界，
 * 只是把「当前登录者」换成「token 声明的库主」，并锁定 library_id —— 不放松隔离，不重写检索。
 */
import type { ShareScope } from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { findLibraryById } from '../repo/library.repo.js';
import { findShareByToken } from '../repo/share.repo.js';
import { ApiError } from '../http/errors.js';
import { genShareToken } from '../util/crypto.js';

/** 生成分享 token（192bit，URL-safe） */
export function generateShareToken(): string {
  return genShareToken();
}

/** 拼接分享落地页 URL：${SHARE_BASE_URL}/#/share/${token} */
export function buildShareUrl(config: AppConfig, token: string): string {
  const base = config.shareBaseUrl.replace(/\/+$/, '');
  return `${base}/#/share/${token}`;
}

/**
 * 解析 token 为只读作用域。
 * token 不存在 / 已过期 / 库已被删除 -> 一律 404（不泄露存在性）。
 */
export function resolveShareScope(db: DbHandle, token: string): ShareScope {
  if (!token) throw ApiError.notFound('链接不存在或已失效');

  const row = findShareByToken(db, token);
  if (!row) throw ApiError.notFound('链接不存在或已失效');

  if (row.expires_at) {
    const expiredAt = Date.parse(row.expires_at);
    if (Number.isFinite(expiredAt) && expiredAt <= Date.now()) {
      throw ApiError.notFound('链接不存在或已失效');
    }
  }

  const library = findLibraryById(db, row.created_by, row.library_id);
  if (!library) throw ApiError.notFound('链接不存在或已失效');

  return {
    ownerUserId: row.created_by,
    libraryId: row.library_id,
    libraryName: library.name,
    libraryDescription: library.description,
  };
}
