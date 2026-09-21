/**
 * ModelGateway 接口 + 实现（路由 + 熔断 + 故障转移）。
 *
 * 故障转移硬规则（写死，避免维护时想太多）：
 *   1. 只转移 1 次（chain 长度 ≤2）。
 *   2. 只在未产出任何 content_delta 之前转移。
 *   3. 深度思考轮次内不跨厂商（由 thinking/engine 自行同厂商重试，不走这里）。
 *   4. 熔断阈值：60s 窗口失败 ≥3 次 -> 熔断 5 分钟（进程内内存，重启清零）。
 *   5. 熔断不持久化。
 */
import type { ProviderId, ProviderProfile, ChatRequest, ChatStreamEvent, TokenUsage } from './catalog.js';
import { PROVIDER_CATALOG } from './providers/index.js';
import type { NormalizedError } from './errors.js';
import { GatewayError, normalizeError } from './errors.js';
import { OpenAICompatAdapter } from './openai-compat.js';
import { parseOpenAiSse } from './sse.js';
import { retryDecisionOf, withRetry } from './retry.js';
import { decryptSecret } from '../util/secret-crypto.js';
import type { DbHandle } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import { validateProviderBaseUrl } from './endpoint.js';
import * as credentialRepo from '../repo/provider-credential.repo.js';

export interface GatewayLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface ResolvedTarget {
  providerId: ProviderId;
  model: string;
  profile: ProviderProfile;
  apiKey: string;
  baseUrl: string;
}

export type RoutingPolicy =
  | { kind: 'pinned'; providerId: ProviderId; model: string }
  | { kind: 'priority'; chain: Array<{ providerId: ProviderId; model: string }> };

export interface RouterHealth {
  isOpen(providerId: ProviderId): boolean;
  record(providerId: ProviderId, ok: boolean, latencyMs: number): void;
  snapshot(): Record<string, { okRate: number; p95Ms: number; openUntil?: number }>;
}

export interface GatewayRequest extends ChatRequest {
  userId: number;
}

export interface ModelGateway {
  resolve(userId: number, policy: RoutingPolicy): Promise<ResolvedTarget>;
  chatStream(req: GatewayRequest, signal: AbortSignal): AsyncIterable<ChatStreamEvent>;
  chat(req: GatewayRequest, signal: AbortSignal): Promise<{ content: string; usage?: TokenUsage }>;
  testConnection(providerId: ProviderId, apiKey: string, baseUrlOverride?: string): Promise<{ ok: boolean; error?: NormalizedError }>;
  healthSnapshot(): Record<string, { okRate: number; p95Ms: number; openUntil?: number }>;
}

export interface ModelGatewayDeps {
  db: DbHandle;
  config: AppConfig;
  logger?: GatewayLogger | null;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return Math.round(sorted[index] ?? 0);
}

class CircuitBreaker implements RouterHealth {
  private history = new Map<string, Array<{ ok: boolean; at: number; latencyMs: number }>>();
  private openUntil = new Map<string, number>();

  isOpen(providerId: ProviderId): boolean {
    const until = this.openUntil.get(providerId);
    return until != null && until > Date.now();
  }

  record(providerId: ProviderId, ok: boolean, latencyMs: number): void {
    const now = Date.now();
    const entries = this.history.get(providerId) ?? [];
    entries.push({ ok, at: now, latencyMs });
    if (entries.length > 200) entries.shift();
    this.history.set(providerId, entries);

    const recentFailures = entries.filter((entry) => !entry.ok && now - entry.at < 60000).length;
    if (recentFailures >= 3) {
      this.openUntil.set(providerId, now + 5 * 60 * 1000);
    }
  }

  snapshot(): Record<string, { okRate: number; p95Ms: number; openUntil?: number }> {
    const now = Date.now();
    const out: Record<string, { okRate: number; p95Ms: number; openUntil?: number }> = {};
    for (const providerId of Object.keys(PROVIDER_CATALOG)) {
      const entries = this.history.get(providerId) ?? [];
      const recent = entries.filter((entry) => now - entry.at < 60000);
      const okCount = recent.filter((entry) => entry.ok).length;
      const okRate = recent.length === 0 ? 1 : okCount / recent.length;
      const openUntil = this.openUntil.get(providerId);
      out[providerId] = {
        okRate: Number(okRate.toFixed(3)),
        p95Ms: p95(recent.map((entry) => entry.latencyMs)),
        ...(openUntil && openUntil > now ? { openUntil } : {}),
      };
    }
    return out;
  }
}

export class ModelGatewayImpl implements ModelGateway {
  private readonly health: CircuitBreaker = new CircuitBreaker();
  private readonly adapter = new OpenAICompatAdapter();
  private readonly logger: GatewayLogger | null;

  constructor(private readonly deps: ModelGatewayDeps) {
    this.logger = deps.logger ?? null;
  }

  private globalFallback(): { providerId: ProviderId; model: string; apiKey: string } | null {
    const { llm } = this.deps.config;
    if (llm.provider !== 'none' && llm.apiKey) {
      return { providerId: llm.provider as ProviderId, model: llm.model, apiKey: llm.apiKey };
    }
    return null;
  }

  private resolveOne(userId: number, providerId: ProviderId, model: string): ResolvedTarget | null {
    const profile = PROVIDER_CATALOG[providerId as string];
    if (!profile) return null;
    const resolvedModel = model || profile.models[0]?.id || '';

    const credential = credentialRepo.getCredential(this.deps.db, userId, providerId as string);
    if (credential && credential.enabled) {
      return {
        providerId,
        model: resolvedModel,
        profile,
        apiKey: decryptSecret(credential.apiKeyEnc, this.deps.config.secretsKey),
        baseUrl: credential.baseUrlOverride ? validateProviderBaseUrl(credential.baseUrlOverride, this.deps.config) : profile.baseUrl,
      };
    }

    const global = this.globalFallback();
    if (global && global.providerId === providerId) {
      return { providerId, model: resolvedModel, profile, apiKey: global.apiKey, baseUrl: this.deps.config.llm.apiBase || profile.baseUrl };
    }
    return null;
  }

  async resolve(userId: number, policy: RoutingPolicy): Promise<ResolvedTarget> {
    if (policy.kind === 'pinned') {
      const target = this.resolveOne(userId, policy.providerId, policy.model);
      if (!target) throw new ApiError('LLM_NOT_CONFIGURED', '未配置可用的模型供应商', 404);
      return target;
    }
    for (const entry of policy.chain) {
      const target = this.resolveOne(userId, entry.providerId, entry.model);
      if (target && !this.health.isOpen(target.providerId)) return target;
    }
    throw new ApiError('LLM_NOT_CONFIGURED', '未配置可用的模型供应商', 404);
  }

  /** 故障转移候选：用户默认供应商（排除当前），否则任意其它已配置且未熔断的供应商 */
  private async resolveFallback(userId: number, exclude: ProviderId, model: string): Promise<ResolvedTarget | null> {
    const credentials = credentialRepo.listByUser(this.deps.db, userId);
    const ordered = [...credentials].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    for (const credential of ordered) {
      if (credential.providerId === exclude || !credential.enabled) continue;
      const target = this.resolveOne(userId, credential.providerId as ProviderId, '');
      if (target && !this.health.isOpen(target.providerId)) return target;
    }
    return null;
  }

  async *chatStream(req: GatewayRequest, signal: AbortSignal): AsyncGenerator<ChatStreamEvent, void, void> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.deps.config.llm.timeoutMs)]);
    signal.throwIfAborted();
    const target = await this.resolve(req.userId, { kind: 'pinned', providerId: req.providerId, model: req.model });
    yield* this.streamWithFailover(target, req, signal);
  }

  private async *streamWithFailover(
    initial: ResolvedTarget,
    req: GatewayRequest,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    let current = initial;
    let transferred = false;
    const canTransfer = req.meta?.purpose !== 'thinking';
    const isServiceFailure = (error: unknown): boolean =>
      ['server', 'network', 'timeout', 'parse'].includes(normalizeError(error, current.providerId).kind);

    for (;;) {
      if (signal.aborted) {
        yield { type: 'error', error: normalizeError(signal.reason, current.providerId) };
        return;
      }
      if (this.health.isOpen(current.providerId)) {
        const fallback = canTransfer && !transferred ? await this.resolveFallback(req.userId, current.providerId, '') : null;
        if (fallback) {
          this.logger?.warn(`[gateway] ${current.providerId} 已熔断，故障转移到 ${fallback.providerId}`);
          current = fallback;
          transferred = true;
          continue;
        }
        yield { type: 'error', error: { kind: 'server', userMessage: `${current.providerId} 暂不可用`, retryable: true } };
        return;
      }

      const start = Date.now();
      let emittedContent = false;

      let response: Response;
      try {
        response = await withRetry(
          () => this.adapter.requestStream({ ...req, model: current.model, providerId: current.providerId }, current.profile, current.apiKey, current.baseUrl, signal),
          (error) => retryDecisionOf(normalizeError(error, current.providerId).kind),
          signal,
        );
      } catch (error) {
        if (!signal.aborted && isServiceFailure(error)) this.health.record(current.providerId, false, Date.now() - start);
        const fallback = canTransfer && !signal.aborted && isServiceFailure(error) && !transferred ? await this.resolveFallback(req.userId, current.providerId, '') : null;
        if (fallback) {
          this.logger?.warn(`[gateway] ${current.providerId} 请求失败，故障转移到 ${fallback.providerId}`);
          current = fallback;
          transferred = true;
          continue;
        }
        yield { type: 'error', error: normalizeError(error, current.providerId) };
        return;
      }

      yield { type: 'start', responseId: randomId('resp'), model: current.model, providerId: current.providerId };

      try {
        if (!response.body) {
          this.health.record(current.providerId, true, Date.now() - start);
          yield { type: 'finish', finishReason: 'stop' };
          return;
        }
        for await (const event of parseOpenAiSse(response.body, current.profile, signal)) {
          if (event.type === 'content_delta' || event.type === 'reasoning_delta') emittedContent = true;
          yield event;
        }
        this.health.record(current.providerId, true, Date.now() - start);
        return;
      } catch (error) {
        if (!signal.aborted && isServiceFailure(error)) this.health.record(current.providerId, false, Date.now() - start);
        if (canTransfer && !signal.aborted && isServiceFailure(error) && !emittedContent && !transferred) {
          const fallback = await this.resolveFallback(req.userId, current.providerId, req.model);
          if (fallback) {
            this.logger?.warn(`[gateway] ${current.providerId} 流中断，故障转移到 ${fallback.providerId}`);
            current = fallback;
            transferred = true;
            continue;
          }
        }
        yield { type: 'error', error: normalizeError(error, current.providerId) };
        return;
      }
    }
  }

  async chat(req: GatewayRequest, signal: AbortSignal): Promise<{ content: string; usage?: TokenUsage }> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.deps.config.llm.timeoutMs)]);
    const target = await this.resolve(req.userId, { kind: 'pinned', providerId: req.providerId, model: req.model });
    const start = Date.now();
    try {
      const result = await withRetry(
        () => this.adapter.chat(req, target.profile, target.apiKey, target.baseUrl, signal),
        (error) => retryDecisionOf(normalizeError(error, target.providerId).kind),
        signal,
      );
      this.health.record(target.providerId, true, Date.now() - start);
      return result;
    } catch (error) {
      if (!signal.aborted && ['server', 'network', 'timeout', 'parse'].includes(normalizeError(error, target.providerId).kind)) {
        this.health.record(target.providerId, false, Date.now() - start);
      }
      throw new GatewayError(normalizeError(error, target.providerId));
    }
  }

  async testConnection(
    providerId: ProviderId,
    apiKey: string,
    baseUrlOverride?: string,
  ): Promise<{ ok: boolean; error?: NormalizedError }> {
    const profile = PROVIDER_CATALOG[providerId as string];
    if (!profile) {
      return { ok: false, error: { kind: 'invalid_request', userMessage: '未知供应商', retryable: false } };
    }
    const model = profile.models[0]?.id ?? '';
    const req: ChatRequest = {
      providerId,
      model,
      messages: [{ role: 'user', content: 'ping' }],
      params: { temperature: 0, topP: 1, maxTokens: 8 },
      meta: { purpose: 'chat' },
    };
    try {
      await this.adapter.chat(req, profile, apiKey, baseUrlOverride || profile.baseUrl, AbortSignal.timeout(this.deps.config.llm.timeoutMs));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: normalizeError(error, providerId) };
    }
  }

  healthSnapshot(): Record<string, { okRate: number; p95Ms: number; openUntil?: number }> {
    return this.health.snapshot();
  }
}
