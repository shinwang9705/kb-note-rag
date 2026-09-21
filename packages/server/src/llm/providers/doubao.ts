/**
 * 豆包（火山方舟 Ark）能力目录声明对象（OpenAI 兼容模式）。
 */
import type { ProviderProfile } from '../catalog.js';

export const doubaoProfile: ProviderProfile = {
  id: 'doubao',
  displayName: '豆包 Doubao',
  apiKind: 'openai-compat',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  authScheme: { header: 'Authorization', prefix: 'Bearer ' },
  reasoning: { mode: 'reasoning_content' },
  quirks: {
    streamOptionsUsage: true,
    supportsJsonMode: true,
    jsonModeNeedsKeyword: false,
    maxTokensField: 'max_tokens',
    forbidTemperatureWhenReasoning: true,
    requiresUserAlternation: false,
    sseKeepAliveComment: true,
  },
  models: [
    {
      id: 'doubao-pro-32k',
      displayName: 'Doubao Pro 32K',
      contextWindow: 32768,
      maxOutputTokens: 4096,
      supportsStreaming: true,
      supportsReasoning: false,
      supportsJsonMode: true,
      supportsStop: true,
      tags: ['chat'],
    },
  ],
  limits: { rpm: 60, tpm: 60000 },
  pricing: { inputPerMTokensCNY: 0.8, outputPerMTokensCNY: 2 },
  docsUrl: 'https://console.volcengine.com/ark',
  keyFormatHint: 'API Key（火山方舟控制台创建）',
};
