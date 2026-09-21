/**
 * 单一 OpenAICompatAdapter（四家厂商共用，零依赖）。
 *
 * 原生 fetch + 手写 SSE 流解析；按 ProviderProfile.quirks 适配方言：
 *   - maxTokensField：max_tokens 或 max_completion_tokens
 *   - forbidTemperatureWhenReasoning：reasoning 模型不带 temperature
 *   - streamOptionsUsage：带 stream_options:{include_usage:true}
 *   - supportsJsonMode：response_format:{type:'json_object'}
 */
import type { ChatRequest, ChatStreamEvent, ProviderProfile, TokenUsage } from './catalog.js';
import { LlmHttpError } from './errors.js';
import { parseOpenAiSse } from './sse.js';

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function modelOf(profile: ProviderProfile, model: string) {
  return profile.models.find((candidate) => candidate.id === model);
}

/** 组装 OpenAI 兼容请求体 */
function buildBody(req: ChatRequest, profile: ProviderProfile, stream: boolean): Record<string, unknown> {
  const selected = modelOf(profile, req.model);
  const isReasoning = selected?.supportsReasoning === true;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream,
  };
  body[profile.quirks.maxTokensField] = req.params.maxTokens;

  if (!(profile.quirks.forbidTemperatureWhenReasoning && isReasoning)) {
    body.temperature = req.params.temperature;
  }
  if (req.params.topP !== undefined) body.top_p = req.params.topP;
  if (req.params.stop && req.params.stop.length > 0) body.stop = req.params.stop;
  if (stream && profile.quirks.streamOptionsUsage) {
    body.stream_options = { include_usage: true };
  }
  if (req.responseFormat === 'json_object' && profile.quirks.supportsJsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

interface OpenAICompatOptions {
  req: ChatRequest;
  profile: ProviderProfile;
  apiKey: string;
  baseUrl: string;
  signal: AbortSignal;
}

async function doFetch(options: OpenAICompatOptions, stream: boolean): Promise<Response> {
  const { req, profile, apiKey, baseUrl, signal } = options;
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error', // 禁止已授权模型端点通过重定向访问其它地址。
    headers: {
      'Content-Type': 'application/json',
      Authorization: `${profile.authScheme.prefix}${apiKey}`,
    },
    body: JSON.stringify(buildBody(req, profile, stream)),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let providerCode: string | undefined;
    try {
      providerCode = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
    } catch {
      /* 忽略 */
    }
    throw new LlmHttpError(response.status, text, providerCode);
  }
  return response;
}

export class OpenAICompatAdapter {
  /** 流式请求：仅发请求并返回 Response（供网关做重试/熔断/故障转移） */
  requestStream(
    req: ChatRequest,
    profile: ProviderProfile,
    apiKey: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return doFetch({ req, profile, apiKey, baseUrl, signal }, true);
  }

  /** 非流式请求：返回 Response（供网关/连通性测试用） */
  request(
    req: ChatRequest,
    profile: ProviderProfile,
    apiKey: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return doFetch({ req, profile, apiKey, baseUrl, signal }, false);
  }

  /** 流式对话：归一化 ChatStreamEvent 流（start/reasoning_delta/content_delta/usage/finish） */
  async *chatStream(
    req: ChatRequest,
    profile: ProviderProfile,
    apiKey: string,
    baseUrl: string,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    const response = await doFetch({ req, profile, apiKey, baseUrl, signal }, true);
    yield { type: 'start', responseId: randomId('resp'), model: req.model, providerId: profile.id };

    if (!response.body) {
      const text = await response.text();
      if (text) yield { type: 'content_delta', text };
      yield { type: 'finish', finishReason: 'stop' };
      return;
    }

    for await (const event of parseOpenAiSse(response.body, profile, signal)) {
      yield event;
    }
  }

  /** 非流式（摘要/连通性测试用） */
  async chat(
    req: ChatRequest,
    profile: ProviderProfile,
    apiKey: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<{ content: string; usage?: TokenUsage }> {
    const response = await doFetch({ req, profile, apiKey, baseUrl, signal }, false);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const content = payload?.choices?.[0]?.message?.content ?? '';
    const usage = payload?.usage
      ? {
          inputTokens: Number(payload.usage.prompt_tokens ?? 0),
          outputTokens: Number(payload.usage.completion_tokens ?? 0),
          reasoningTokens: Number(payload.usage.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
        }
      : undefined;
    return { content, usage };
  }
}
