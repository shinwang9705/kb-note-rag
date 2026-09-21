/**
 * LLM 层统一出口（三期 T04）。
 *
 * 二期 LlmProvider（单家）已被 ModelGateway（多厂商）取代；
 * 这里保留 llmEnabled 语义（旧 /api/chat/status 用），改为读 ModelGateway 可用性。
 */
import type { ProviderId } from '@kb/shared';
import { PROVIDER_CATALOG } from './providers/index.js';
import type { ModelGateway, ResolvedTarget } from './router.js';

export { createModelGateway, initModelGateway, ModelGatewayImpl } from './gateway.js';
export { ModelGatewayImpl as GatewayImpl } from './router.js';
export type { ModelGateway, GatewayLogger, RoutingPolicy, ResolvedTarget, ModelGatewayDeps } from './router.js';
export type { GatewayRequest } from './router.js';
export { normalizeError, LlmHttpError, LlmSseParseError } from './errors.js';
export type { ErrorKind, NormalizedError, SuggestedAction } from './errors.js';
export * from './catalog.js';
export { PROVIDER_CATALOG, resolveModelContextWindow, resolveModelMaxOutputTokens, defaultModelOf } from './providers/index.js';

const ALL_PROVIDERS = Object.keys(PROVIDER_CATALOG) as ProviderId[];

/** 默认供应商解析：优先 chain 全部内置厂商，任意一家有凭据即返回 */
export async function resolveDefaultProvider(gateway: ModelGateway, userId: number): Promise<ResolvedTarget | null> {
  try {
    return await gateway.resolve(userId, {
      kind: 'priority',
      chain: ALL_PROVIDERS.map((providerId) => ({ providerId, model: '' })),
    });
  } catch {
    return null;
  }
}

/** 问答/对话是否可用（有任一可用 provider 凭据即 enabled） */
export async function llmEnabled(gateway: ModelGateway, userId: number): Promise<boolean> {
  return (await resolveDefaultProvider(gateway, userId)) !== null;
}
