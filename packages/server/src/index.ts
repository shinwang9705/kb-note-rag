/**
 * 进程入口：读配置 -> 初始化数据库 -> 执行迁移 -> 引导管理员 -> 监听端口。
 */
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { initDatabase, closeDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { createBootstrapAdmin, hasAnyUser } from './bootstrap.js';
import { initEmbeddingProvider, embeddingModeOf } from './embedding/index.js';
import type { EmbeddingLogger } from './embedding/types.js';
import { initRerankProvider } from './rerank/index.js';
import type { RerankLogger } from './rerank/types.js';
import { initModelGateway, type GatewayLogger } from './llm/gateway.js';

const startedAt = Date.now();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const db = await initDatabase(config);
  const migration = runMigrations(db, { embeddingDim: config.embedding.dim });

  logger.info(
    {
      db: db.path,
      sqlite: db.sqliteVersion,
      vec: db.vecAvailable ? db.vecVersion : false,
      migrations: migration.applied,
      version: migration.version,
    },
    'database ready',
  );

  const admin = await createBootstrapAdmin({ db, config, logger });
  if (admin) {
    logger.warn({ username: admin.username }, '已创建初始管理员，请尽快修改密码');
  }
  if (!hasAnyUser(db)) {
    logger.warn('系统中还没有任何用户，请通过 /api/auth/register 或 scripts/create-admin.mjs 创建');
  }

  const embeddingLogger: EmbeddingLogger = {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
    debug: (message: string) => logger.debug(message),
  };
  const embedding = await initEmbeddingProvider({ config, logger: embeddingLogger });

  const rerankLogger: RerankLogger = {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
    debug: (message: string) => logger.debug(message),
  };
  const rerank = await initRerankProvider({ config, logger: rerankLogger });

  const gatewayLogger: GatewayLogger = {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (message: string) => logger.error(message),
    debug: (message: string) => logger.debug(message),
  };
  const gateway = await initModelGateway({ db, config, logger: gatewayLogger });

  const app = await buildApp({ config, logger, db, startedAt, embedding, rerank, gateway });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
    } catch (error) {
      logger.error({ err: error }, '关闭 HTTP 服务时出错');
    }
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    {
      url: `http://${config.server.host}:${config.server.port}`,
      env: config.env,
      embeddingMode: embeddingModeOf(embedding),
      rerankProvider: rerank.kind,
      rerankEnabled: rerank.available,
      vecAvailable: db.vecAvailable,
    },
    `${config.appName} listening`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] ${message}`);
  if (error instanceof Error && error.stack && process.env.NODE_ENV !== 'production') {
    console.error(error.stack);
  }
  closeDatabase();
  process.exit(1);
});
