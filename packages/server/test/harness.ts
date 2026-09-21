/**
 * 测试夹具（harness）：内存方式起 app + 独立临时 DB。
 *
 * 关键点：
 *   1. 环境变量必须在动态 import config/connection 之前设置；
 *   2. config.ts 有缓存（resetConfigCache），connection.ts 是单例（closeDatabase），
 *      每次 createTestApp 都先复位，避免不同测试文件之间串味；
 *   3. 一律用 EMBEDDING_PROVIDER=none，检索稳定降级为 keyword，不依赖本地模型。
 *
 * 注意：本文件命名不以 *.test.ts 结尾，不会被 node --test 当作用例收集。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** monorepo 根目录 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 每次运行一个唯一临时目录，避免并发/重复运行串库 */
export function makeTempDir(prefix: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(ROOT, 'data', 'tmp', `${prefix}-${id}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在 import config 之前注入测试所需环境变量 */
export function setTestEnv(tmpDir: string): void {
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = tmpDir;
  process.env.DB_PATH = path.join(tmpDir, 'kb.db');
  process.env.JWT_SECRET = 'qa-test-secret-0123456789abcdef';
  process.env.EMBEDDING_PROVIDER = 'none';
  // 不继承开发者 .env 中的付费凭据；模型测试必须显式注入 mock。
  process.env.LLM_PROVIDER = 'none';
  process.env.LLM_API_KEY = '';
  process.env.CHUNK_SIZE = '400';
  process.env.CHUNK_OVERLAP = '80';
  process.env.ALLOW_REGISTER = 'true';
  process.env.LOG_LEVEL = 'silent';
  process.env.LOG_FILE = '';
  process.env.MAX_UPLOAD_MB = '20';
}

export interface TestApp {
  app: {
    inject: (opts: unknown) => Promise<{ statusCode: number; payload: string }>;
    close: () => Promise<void>;
  };
  db: {
    driver: {
      all: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T[];
      get: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T | undefined;
    };
  };
  config: { embedding: { dim: number } };
  close: () => Promise<void>;
}

/** 复位配置缓存与 DB 单例，然后装配完整 app（不监听端口） */
export async function createTestApp(): Promise<TestApp> {
  const { resetConfigCache, loadConfig } = await import('../src/config.ts');
  const { initDatabase, closeDatabase } = await import('../src/db/connection.ts');
  const { runMigrations } = await import('../src/db/migrate.ts');
  const { createLogger } = await import('../src/logger.ts');
  const { buildApp } = await import('../src/app.ts');
  const { initEmbeddingProvider } = await import('../src/embedding/index.ts');

  closeDatabase();
  resetConfigCache();

  const config = loadConfig({ reload: true });
  const logger = createLogger(config, { level: 'silent' });
  const db = await initDatabase(config);
  runMigrations(db, { embeddingDim: config.embedding.dim });
  const embedding = await initEmbeddingProvider({ config, logger: null });
  const app = await buildApp({ config, logger, db, startedAt: Date.now(), embedding });

  return {
    app: app as unknown as TestApp['app'],
    db: db as unknown as TestApp['db'],
    config: config as unknown as TestApp['config'],
    close: async () => {
      await app.close();
      closeDatabase();
    },
  };
}

export interface CallResult {
  status: number;
  body: Record<string, any>;
}

export interface CallOptions {
  payload?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

/** 封装 app.inject：自动附 Bearer token、序列化 JSON body、解析响应 JSON */
export function makeCall(app: TestApp['app']) {
  return async function call(
    method: string,
    url: string,
    options: CallOptions = {},
  ): Promise<CallResult> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    let payload: unknown = options.payload;
    if (payload !== undefined && typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      payload = JSON.stringify(payload);
    }

    let fullUrl = url;
    if (options.query) {
      const qs = Object.entries(options.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      if (qs) fullUrl += (url.includes('?') ? '&' : '?') + qs;
    }

    const response = await app.inject({ method, url: fullUrl, headers, payload });

    let body: Record<string, any>;
    try {
      body = JSON.parse(response.payload);
    } catch {
      body = { raw: response.payload };
    }
    return { status: response.statusCode, body };
  };
}

export type Caller = ReturnType<typeof makeCall>;

/** 生成一次运行内唯一的用户名 */
export function uniqueUsername(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const PASSWORD = 'QaTest12345';
