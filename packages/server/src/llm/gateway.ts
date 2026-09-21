/**
 * ModelGateway 组合根（装配 Router + Adapter + 凭据仓储）。
 *
 * 网关本身在构造时不抛错、不发网络请求；无凭据时由 resolve() 抛
 * LLM_NOT_CONFIGURED，调用方据此降级/隐藏入口。故 init 失败即不可用、不阻断启动。
 */
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import { ModelGatewayImpl, type GatewayLogger, type ModelGateway } from './router.js';

export interface InitGatewayOptions {
  db: DbHandle;
  config: AppConfig;
  logger?: GatewayLogger | null;
}

export function createModelGateway(options: InitGatewayOptions): ModelGateway {
  return new ModelGatewayImpl({ db: options.db, config: options.config, logger: options.logger ?? null });
}

/** 初始化（组合根）；始终返回非空网关，不抛错 */
export async function initModelGateway(options: InitGatewayOptions): Promise<ModelGateway> {
  return createModelGateway(options);
}

export type { ModelGateway, GatewayLogger, RoutingPolicy, ResolvedTarget, ModelGatewayDeps } from './router.js';
export { ModelGatewayImpl } from './router.js';
