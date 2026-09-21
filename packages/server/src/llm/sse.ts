/**
 * OpenAI 兼容 SSE 流解析（零依赖，手写）。
 *
 * 按 ProviderProfile.reasoning.mode 分流思考内容到 reasoning_delta；
 * content 到 content_delta；stream_options.include_usage 的 usage 块到 usage；
 * [DONE] -> finish(stop)。忽略 `: ...` 注释行（quirks.sseKeepAliveComment 的 keep-alive）。
 */
import type { ChatStreamEvent, ProviderProfile, TokenUsage } from './catalog.js';
import { LlmSseParseError } from './errors.js';

interface SseDelta {
  content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
  reasoning_content?: string;
  reasoning?: string;
}

interface SseChoice {
  delta?: SseDelta;
  finish_reason?: string | null;
}

interface SseChunk {
  id?: string;
  model?: string;
  choices?: SseChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 按 reasoning.mode 从 delta 中拆分 reasoning 与 content */
function extractDelta(delta: SseDelta, profile: ProviderProfile): { reasoning: string; content: string } {
  const mode = profile.reasoning.mode;
  if (mode === 'reasoning_content') {
    return { reasoning: asString(delta.reasoning_content), content: asString(delta.content) };
  }
  if (mode === 'reasoning') {
    return { reasoning: asString(delta.reasoning), content: asString(delta.content) };
  }
  if (mode === 'thinking_blocks') {
    let reasoning = '';
    let content = '';
    if (Array.isArray(delta.content)) {
      for (const block of delta.content) {
        if (block?.type === 'thinking') reasoning += block.thinking ?? '';
        else if (block?.type === 'text' || block?.type === undefined) content += block?.text ?? '';
      }
    } else {
      content = asString(delta.content);
    }
    return { reasoning, content };
  }
  if (mode === 'inline_tag') {
    // inline_tag 的 <think>…</think> 剥离在非流式 chat() 里整段处理；
    // 流式下保守并入 content（四家内置供应商均不采用此方言）。
    return { reasoning: '', content: asString(delta.content) };
  }
  return { reasoning: '', content: asString(delta.content) };
}

function toUsage(usage: SseChunk['usage']): TokenUsage {
  const u = usage ?? {};
  return {
    inputTokens: Number(u.prompt_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
  };
}

export async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  profile: ProviderProfile,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawDone = false;
  let sawFinish = false;
  const onAbort = (): void => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new LlmSseParseError('单帧过大');

      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length === 0 || line.startsWith(':')) {
          nl = buffer.indexOf('\n');
          continue;
        }
        if (!line.startsWith('data:')) {
          nl = buffer.indexOf('\n');
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          break;
        }
        if (!data) {
          nl = buffer.indexOf('\n');
          continue;
        }

        let chunk: SseChunk;
        try {
          chunk = JSON.parse(data) as SseChunk;
        } catch {
          throw new LlmSseParseError('非法 JSON 行');
        }

        if (chunk.usage) {
          yield { type: 'usage', usage: toUsage(chunk.usage) };
        }
        if (chunk.choices?.[0]?.finish_reason) sawFinish = true;

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          const { reasoning, content } = extractDelta(delta, profile);
          if (reasoning) yield { type: 'reasoning_delta', text: reasoning };
          if (content) yield { type: 'content_delta', text: content };
        }

        nl = buffer.indexOf('\n');
      }

      if (sawDone) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* 已释放则忽略 */
    }
  }

  if (!sawDone && !sawFinish) throw new LlmSseParseError('连接结束前未收到完成标记');
  yield { type: 'finish', finishReason: sawDone ? 'stop' : 'length' };
}
