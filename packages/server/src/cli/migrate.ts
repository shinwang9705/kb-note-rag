/**
 * CLI：执行数据库迁移（setup 脚本与手动运维共用）。
 * 用法：node --import tsx packages/server/src/cli/migrate.ts
 */
import { loadConfig } from '../config.js';
import { initDatabase, closeDatabase } from '../db/connection.js';
import { runMigrations, resolveMigrationsDir } from '../db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[migrate] db=${config.db.path}`);
  console.log(`[migrate] dir=${resolveMigrationsDir()}`);

  const db = await initDatabase(config);
  const result = runMigrations(db, { embeddingDim: config.embedding.dim });

  if (result.applied.length === 0) {
    console.log(`[migrate] 已是最新（user_version=${result.version}），无需执行`);
  } else {
    for (const file of result.applied) {
      console.log(`[migrate] 已应用 ${file} -> user_version=${result.version}`);
    }
  }
  console.log(
    `[migrate] sqlite=${db.sqliteVersion} vec=${db.vecAvailable ? db.vecVersion : 'unavailable'}`,
  );
  if (result.skippedVec) {
    console.log('[migrate] 向量扩展不可用，已跳过 vec0 虚表（检索将降级为关键词模式）');
  }
  closeDatabase();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[migrate] 失败：${message}`);
  closeDatabase();
  process.exit(1);
});
