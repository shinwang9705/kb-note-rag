/**
 * 通义千问能力目录声明对象（OpenAI 兼容模式）。
 */
import type { ProviderProfile } from '../catalog.js';

export const qwenProfile: ProviderProfile = {
  id: 'qwen',
  displayName: '通义千问 Qwen',
  apiKind: 'openai-compat',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  authScheme: { header: 'Authorization', prefix: 'Bearer ' },
  reasoning: { mode: 'reasoning_content' },
  quirks: {
    streamOptionsUsage: true,
    supportsJsonMode: true,
    jsonModeNeedsKeyword: false,
    maxTokensField: 'max_tokens',
    forbidTemperatureWhenReasoning: false,
    requiresUserAlternation: false,
    sseKeepAliveComment: false,
  },
  models: [
    {
      id: 'qwen-plus',
      displayName: 'Qwen Plus',
      contextWindow: 131072,
      maxOutputTokens: 8192,
      supportsStreaming: true,
      supportsReasoning: false,
      supportsJsonMode: true,
      supportsStop: true,
      tags: ['chat', 'long-context'],
    },
  ],
  limits: { rpm: 60, tpm: 60000 },
  pricing: { inputPerMTokensCNY: 0.8, outputPerMTokensCNY: 2 },
  docsUrl: 'https://bailian.console.aliyun.com/',
  keyFormatHint: 'sk- 开头（DashScope API Key）',
};
