/**
 * 供应商目录聚合 + 凭据加密存储 + 连通性测试（三期 T04）。
 */
import type { ProviderId, ProviderInfo } from '@kb/shared';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { ModelGateway, ResolvedTarget } from '../llm/router.js';
import { PROVIDER_CATALOG } from '../llm/providers/index.js';
import { encryptSecret, decryptSecret } from '../util/secret-crypto.js';
import { ApiError } from '../http/errors.js';
import { validateProviderBaseUrl } from '../llm/endpoint.js';
import * as credentialRepo from '../repo/provider-credential.repo.js';

export interface ProviderServiceContext {
  db: DbHandle;
  config: AppConfig;
  gateway: ModelGateway;
}

function profileOf(providerId: string) {
  return PROVIDER_CATALOG[providerId as ProviderId];
}

/** 掩码：只显示尾 4 位 */
function maskKey(apiKeyEnc: string, secret: string): string {
  try {
    const key = decryptSecret(apiKeyEnc, secret);
    return `****${key.slice(-4)}`;
  } catch {
    return '****';
  }
}

export async function listProviders(ctx: ProviderServiceContext, userId: number): Promise<ProviderInfo[]> {
  const credentials = credentialRepo.listByUser(ctx.db, userId);
  const credMap = new Map(credentials.map((credential) => [credential.providerId, credential]));
  const health = ctx.gateway.healthSnapshot();

  return Object.values(PROVIDER_CATALOG).map((profile) => {
    const credential = credMap.get(profile.id as string);
    const configured = credential?.enabled === true;
    return {
      id: profile.id,
      displayName: profile.displayName,
      models: profile.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      })),
      configured,
      maskedKey: credential ? maskKey(credential.apiKeyEnc, ctx.config.secretsKey) : null,
      isDefault: credential?.isDefault === true,
      health: health[profile.id as string] ?? null,
      defaultModel: profile.models[0]?.id ?? '',
      docsUrl: profile.docsUrl,
      keyFormatHint: profile.keyFormatHint,
    };
  });
}

export function saveCredentials(
  ctx: ProviderServiceContext,
  userId: number,
  providerId: string,
  apiKey: string,
  baseUrlOverride?: string,
): { configured: boolean } {
  const profile = profileOf(providerId);
  if (!profile) throw new ApiError('PROVIDER_UNKNOWN', '未知供应商', 404);
  if (!apiKey || apiKey.trim().length === 0) throw ApiError.badRequest('API Key 不能为空');

  const apiKeyEnc = encryptSecret(apiKey.trim(), ctx.config.secretsKey);
  const isDefault = !credentialRepo.userHasAny(ctx.db, userId);
  credentialRepo.upsertCredential(ctx.db, userId, providerId, {
    apiKeyEnc,
    baseUrlOverride: baseUrlOverride?.trim() ? validateProviderBaseUrl(baseUrlOverride, ctx.config) : null,
    enabled: true,
    isDefault,
  });
  return { configured: true };
}

export function deleteCredentials(ctx: ProviderServiceContext, userId: number, providerId: string): { configured: boolean } {
  const profile = profileOf(providerId);
  if (!profile) throw new ApiError('PROVIDER_UNKNOWN', '未知供应商', 404);
  credentialRepo.deleteCredential(ctx.db, userId, providerId);
  return { configured: false };
}

/** 连通性测试：优先用传入 Key，否则用已保存凭据 */
export async function testConnection(
  ctx: ProviderServiceContext,
  userId: number,
  providerId: string,
  apiKey?: string,
  baseUrlOverride?: string,
): Promise<{ ok: boolean; error?: { kind: string; userMessage: string; retryable: boolean } }> {
  const profile = profileOf(providerId);
  if (!profile) throw new ApiError('PROVIDER_UNKNOWN', '未知供应商', 404);

  let key = apiKey?.trim();
  let baseUrl = baseUrlOverride?.trim();
  if (!key) {
    const credential = credentialRepo.getCredential(ctx.db, userId, providerId);
    if (credential) {
      key = decryptSecret(credential.apiKeyEnc, ctx.config.secretsKey);
      baseUrl ||= credential.baseUrlOverride ?? undefined;
    }
  }
  if (!key) throw ApiError.badRequest('请先填写 API Key');

  const result = await ctx.gateway.testConnection(providerId as ProviderId, key, baseUrl ? validateProviderBaseUrl(baseUrl, ctx.config) : undefined);
  return {
    ok: result.ok,
    ...(result.error ? { error: { kind: result.error.kind, userMessage: result.error.userMessage, retryable: result.error.retryable } } : {}),
  };
}

/** 解析目标供应商（用户凭据 + 会话 provider/model） */
export async function resolveTarget(
  ctx: ProviderServiceContext,
  userId: number,
  providerId: ProviderId,
  model: string,
): Promise<ResolvedTarget> {
  return ctx.gateway.resolve(userId, { kind: 'pinned', providerId, model });
}
