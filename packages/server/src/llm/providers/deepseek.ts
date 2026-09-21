/**
 * DeepSeek 能力目录声明对象。
 * 只描述「这家厂商能干什么」，不含任何业务逻辑；T04 的 adapter 依据它发请求。
 */
import type { ProviderProfile } from '../catalog.js';

export const deepseekProfile: ProviderProfile = {
  id: 'deepseek',
  displayName: '深度求索 DeepSeek',
  apiKind: 'openai-compat',
  baseUrl: 'https://api.deepseek.com/v1',
  authScheme: { header: 'Authorization', prefix: 'Bearer ' },
  reasoning: { mode: 'reasoning_content' },
  quirks: {
    streamOptionsUsage: false,
    supportsJsonMode: true,
    jsonModeNeedsKeyword: true,
    maxTokensField: 'max_tokens',
    forbidTemperatureWhenReasoning: true,
    requiresUserAlternation: false,
    sseKeepAliveComment: false,
  },
  models: [
    {
      id: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsStreaming: true,
      supportsReasoning: false,
      supportsJsonMode: true,
      supportsStop: true,
      tags: ['chat', 'long-context'],
    },
  ],
  limits: { rpm: 60, tpm: 60000 },
  // 指示性价格（元/百万 token），以官网实时价格为准
  pricing: { inputPerMTokensCNY: 1, outputPerMTokensCNY: 4 },
  docsUrl: 'https://platform.deepseek.com/api_keys',
  keyFormatHint: 'sk- 开头',
};
