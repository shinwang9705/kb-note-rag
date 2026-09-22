import type { RagModelCapability, RagModelConfigView, SaveRagModelConfigInput } from '@kb/shared';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { ApiEmbeddingProvider } from '../embedding/api.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import { ApiRerankProvider } from '../rerank/api.js';
import type { RerankProvider } from '../rerank/types.js';
import { ApiError } from '../http/errors.js';
import { decryptSecret, encryptSecret } from '../util/secret-crypto.js';
import { deleteRagModelCredential, getRagModelCredential, upsertRagModelCredential } from '../repo/rag-model-credential.repo.js';

export interface RagModelServiceContext { db: DbHandle; config: AppConfig; logger?: Logger | null }

function validateCapability(value: string): RagModelCapability {
  if (value !== 'embedding' && value !== 'rerank') throw ApiError.badRequest('未知的 RAG 模型能力');
  return value;
}

function validateApiUrl(raw: string, ctx: RagModelServiceContext): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw ApiError.badRequest('API 地址格式无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw ApiError.badRequest('API 地址仅允许无凭据、查询参数和片段的 HTTP(S) URL');
  const allowed = [ctx.config.embedding.apiBase, ctx.config.rerank.apiBase, ctx.config.llm.apiBase, ...(ctx.config.providerAllowedOrigins ?? [])].map((item) => { try { return new URL(item).origin; } catch { return ''; } });
  if (!allowed.includes(url.origin)) throw ApiError.badRequest('此 API 域名未获管理员授权，请先加入 PROVIDER_ALLOWED_ORIGINS');
  return url.toString().replace(/\/+$/, '');
}

function maskEncrypted(value: string, secret: string): string {
  try { const key = decryptSecret(value, secret); return `****${key.slice(-4)}`; } catch { return '****'; }
}

export function ragModelConfigs(ctx: RagModelServiceContext, userId: number): RagModelConfigView[] {
  return (['embedding', 'rerank'] as const).map((capability) => {
    const row = getRagModelCredential(ctx.db, userId, capability);
    if (row) return { capability, enabled: row.enabled === 1, configured: true, source: 'user' as const, apiBase: row.api_base, model: row.model, maskedKey: maskEncrypted(row.api_key_enc, ctx.config.secretsKey), timeoutMs: row.timeout_ms, ...(capability === 'embedding' ? { dim: row.dim ?? ctx.config.embedding.dim, batchSize: row.batch_size ?? ctx.config.embedding.batchSize } : {}) };
    if (capability === 'embedding') return { capability, enabled: ctx.config.embedding.provider !== 'none', configured: Boolean(ctx.config.embedding.apiKey) || ctx.config.embedding.provider === 'local', source: ctx.config.embedding.provider === 'none' ? 'none' as const : 'system' as const, apiBase: ctx.config.embedding.apiBase, model: ctx.config.embedding.provider === 'local' ? ctx.config.embedding.model : ctx.config.embedding.apiModel, maskedKey: ctx.config.embedding.apiKey ? '系统环境变量' : null, timeoutMs: ctx.config.embedding.timeoutMs, dim: ctx.config.embedding.dim, batchSize: ctx.config.embedding.batchSize };
    return { capability, enabled: ctx.config.rerank.provider !== 'none', configured: Boolean(ctx.config.rerank.apiKey), source: ctx.config.rerank.provider === 'none' ? 'none' as const : 'system' as const, apiBase: ctx.config.rerank.apiBase, model: ctx.config.rerank.model, maskedKey: ctx.config.rerank.apiKey ? '系统环境变量' : null, timeoutMs: ctx.config.rerank.timeoutMs };
  });
}

export function saveRagModelConfig(ctx: RagModelServiceContext, userId: number, rawCapability: string, input: SaveRagModelConfigInput): RagModelConfigView[] {
  const capability = validateCapability(rawCapability);
  const existing = getRagModelCredential(ctx.db, userId, capability);
  const key = input.apiKey?.trim();
  if (!key && !existing) throw ApiError.badRequest('首次配置必须填写 API Key');
  if (!input.model?.trim()) throw ApiError.badRequest('模型名称不能为空');
  const timeoutMs = Math.min(120_000, Math.max(1_000, Math.trunc(input.timeoutMs)));
  const dim = capability === 'embedding' ? Math.trunc(input.dim ?? ctx.config.embedding.dim) : null;
  if (capability === 'embedding' && dim !== ctx.config.embedding.dim) throw ApiError.badRequest(`当前向量索引维度为 ${ctx.config.embedding.dim}，Embedding 维度必须一致`);
  upsertRagModelCredential(ctx.db, { userId, capability, apiKeyEnc: key ? encryptSecret(key, ctx.config.secretsKey) : existing!.api_key_enc, apiBase: validateApiUrl(input.apiBase, ctx), model: input.model.trim(), enabled: input.enabled, timeoutMs, dim, batchSize: capability === 'embedding' ? Math.min(128, Math.max(1, Math.trunc(input.batchSize ?? 16))) : null });
  return ragModelConfigs(ctx, userId);
}

export function resetRagModelConfig(ctx: RagModelServiceContext, userId: number, rawCapability: string): RagModelConfigView[] {
  deleteRagModelCredential(ctx.db, userId, validateCapability(rawCapability));
  return ragModelConfigs(ctx, userId);
}

export class RagProviderResolver {
  constructor(private readonly ctx: RagModelServiceContext) {}
  embeddingFor(userId: number, fallback: EmbeddingProvider): EmbeddingProvider {
    const row = getRagModelCredential(this.ctx.db, userId, 'embedding');
    if (!row) return fallback;
    if (row.enabled !== 1) return new ApiEmbeddingProvider({ apiBase: row.api_base, apiKey: '', apiModel: row.model, timeoutMs: row.timeout_ms, batchSize: row.batch_size ?? 16, dim: row.dim ?? this.ctx.config.embedding.dim });
    return new ApiEmbeddingProvider({ apiBase: row.api_base, apiKey: decryptSecret(row.api_key_enc, this.ctx.config.secretsKey), apiModel: row.model, timeoutMs: row.timeout_ms, batchSize: row.batch_size ?? 16, dim: row.dim ?? this.ctx.config.embedding.dim });
  }
  rerankFor(userId: number, fallback: RerankProvider): RerankProvider {
    const row = getRagModelCredential(this.ctx.db, userId, 'rerank');
    if (!row) return fallback;
    return new ApiRerankProvider({ apiBase: row.api_base, apiKey: row.enabled === 1 ? decryptSecret(row.api_key_enc, this.ctx.config.secretsKey) : '', model: row.model, timeoutMs: row.timeout_ms, returnDocuments: false });
  }
}

export async function testRagModelConfig(ctx: RagModelServiceContext, userId: number, rawCapability: string, input: Partial<SaveRagModelConfigInput>): Promise<{ ok: boolean; message: string }> {
  const capability = validateCapability(rawCapability);
  const existing = getRagModelCredential(ctx.db, userId, capability);
  const apiKey = input.apiKey?.trim() || (existing ? decryptSecret(existing.api_key_enc, ctx.config.secretsKey) : '');
  if (!apiKey) throw ApiError.badRequest('请先填写 API Key');
  const apiBase = validateApiUrl(input.apiBase || existing?.api_base || (capability === 'embedding' ? ctx.config.embedding.apiBase : ctx.config.rerank.apiBase), ctx);
  const model = input.model || existing?.model || (capability === 'embedding' ? ctx.config.embedding.apiModel : ctx.config.rerank.model);
  if (capability === 'embedding') {
    const provider = new ApiEmbeddingProvider({ apiBase, apiKey, apiModel: model, timeoutMs: input.timeoutMs ?? 10_000, batchSize: 1, dim: ctx.config.embedding.dim });
    const vectors = await provider.embed(['连接测试']);
    if (vectors.length === 1 && vectors[0]?.some((value) => value !== 0)) return { ok: true, message: 'Embedding API 连接正常' };
    return { ok: false, message: provider.lastError ? `Embedding API 请求失败：${provider.lastError}` : '未获得有效向量，请检查地址、模型和 Key' };
  }
  const provider = new ApiRerankProvider({ apiBase, apiKey, model, timeoutMs: input.timeoutMs ?? 10_000, returnDocuments: false });
  const result = await provider.rerank('连接测试', ['知识库连接测试', '无关文本']);
  return result.length > 0 ? { ok: true, message: 'Rerank API 连接正常' } : { ok: false, message: '未获得排序结果，请检查地址、模型和 Key' };
}
