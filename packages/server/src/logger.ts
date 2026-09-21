/**
 * 日志：pino（Fastify 内置）。开发环境可选 pino-pretty；生产为 JSON。
 */
import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';
import type { AppConfig } from './config.js';

/** 判断 pino-pretty 是否已安装（可选依赖，缺失时静默降级） */
function hasPinoPretty(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 logger 实例。
 * @param config 应用配置
 * @param overrides 额外 pino 选项（测试时可传 level: 'silent'）
 */
export function createLogger(config: AppConfig, overrides: Record<string, unknown> = {}): Logger {
  const usePretty = !config.isProduction && config.env !== 'test' && hasPinoPretty();

  const options: Record<string, unknown> = {
    level: config.log.level,
    base: { app: config.appName },
    ...overrides,
  };

  if (usePretty) {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,app',
        singleLine: false,
      },
    };
  } else if (config.log.file) {
    options.transport = {
      targets: [
        { target: 'pino/file', level: config.log.level, options: { destination: 1 } },
        { target: 'pino/file', level: config.log.level, options: { destination: config.log.file } },
      ],
    };
  }

  return pino(options as Parameters<typeof pino>[0]) as unknown as Logger;
}
