/**
 * 能力目录注册表：ProviderId -> ProviderProfile。
 * 新增厂商只需在此追加一条，业务代码零改动（T04 adapter 依据此表发请求）。
 */
import type { ProviderId, ProviderProfile } from '../catalog.js';
import { deepseekProfile } from './deepseek.js';
import { qwenProfile } from './qwen.js';
import { doubaoProfile } from './doubao.js';
import { glmProfile } from './glm.js';

export const PROVIDER_CATALOG: Record<ProviderId, ProviderProfile> = {
  deepseek: deepseekProfile,
  qwen: qwenProfile,
  doubao: doubaoProfile,
  glm: glmProfile,
};

/** 按 model id 反查上下文窗口；未知模型返回 undefined */
export function resolveModelContextWindow(model: string): number | undefined {
  for (const provider of Object.values(PROVIDER_CATALOG)) {
    const found = provider.models.find((candidate) => candidate.id === model);
    if (found) return found.contextWindow;
  }
  return undefined;
}

/** 按 model id 反查最大输出 token 数；未知模型返回 undefined */
export function resolveModelMaxOutputTokens(model: string): number | undefined {
  for (const provider of Object.values(PROVIDER_CATALOG)) {
    const found = provider.models.find((candidate) => candidate.id === model);
    if (found) return found.maxOutputTokens;
  }
  return undefined;
}

/** 供应商默认模型 id */
export function defaultModelOf(providerId: string): string {
  const profile = PROVIDER_CATALOG[providerId as ProviderId];
  return profile?.models[0]?.id ?? '';
}

export * from './deepseek.js';
export * from './qwen.js';
export * from './doubao.js';
export * from './glm.js';
