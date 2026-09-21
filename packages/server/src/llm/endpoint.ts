import type { AppConfig } from '../config.js';
import { PROVIDER_CATALOG } from './providers/index.js';
import { ApiError } from '../http/errors.js';

/** 用户不能把服务端模型调用当作任意 URL 代理；额外网关须由管理员在环境变量中授权。 */
export function validateProviderBaseUrl(raw: string, config: AppConfig): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw ApiError.badRequest('Base URL 格式无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw ApiError.badRequest('Base URL 仅允许无凭据、查询参数和片段的 HTTP(S) 地址');
  }
  const allowed = [...Object.values(PROVIDER_CATALOG).map(p => p.baseUrl), config.llm.apiBase, ...(config.providerAllowedOrigins ?? [])]
    .filter(Boolean).map(value => { try { return new URL(value).origin; } catch { return ''; } });
  if (!allowed.includes(url.origin)) throw ApiError.badRequest('此 Base URL 未获管理员授权，请配置 PROVIDER_ALLOWED_ORIGINS 后重试');
  return url.toString().replace(/\/+$/, '');
}
