/**
 * 智谱 GLM 能力目录声明对象（OpenAI 兼容模式）。
 */
import type { ProviderProfile } from '../catalog.js';

export const glmProfile: ProviderProfile = {
  id: 'glm',
  displayName: '智谱 GLM',
  apiKind: 'openai-compat',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  authScheme: { header: 'Authorization', prefix: 'Bearer ' },
  reasoning: { mode: 'reasoning_content' },
  quirks: {
    streamOptionsUsage: false,
    supportsJsonMode: true,
    jsonModeNeedsKeyword: false,
    maxTokensField: 'max_tokens',
    forbidTemperatureWhenReasoning: false,
    requiresUserAlternation: true,
    sseKeepAliveComment: false,
  },
  models: [
    {
      id: 'glm-4',
      displayName: 'GLM-4',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsStreaming: true,
      supportsReasoning: false,
      supportsJsonMode: true,
      supportsStop: true,
      tags: ['chat', 'long-context'],
    },
  ],
  limits: { rpm: 60, tpm: 60000 },
  pricing: { inputPerMTokensCNY: 0.1, outputPerMTokensCNY: 0.1 },
  docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  keyFormatHint: 'API Key（带 . 后缀的密钥对）',
};
