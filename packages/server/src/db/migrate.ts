/**
 * 版本化迁移执行器（user_version 驱动，可重复执行）。
 *
 * 约定：
 *   - 迁移文件命名 0001_xxx.sql、0002_xxx.sql …，按文件名升序执行
 *   - 每个文件在单个事务里执行，失败整体回滚
 *   - 文件中的 {{EMBEDDING_DIM}} 会被替换为配置的向量维度
 *   - >>>VEC_ONLY / <<<VEC_ONLY 之间的语句仅在向量扩展可用时执行
 *   - 所有 SQL 语句本身也写成幂等形式，便于 setup 脚本在无 tsx 环境下直接执行
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../config.js';
import type { DbHandle } from './connection.js';

export interface MigrateOptions {
  /** 向量维度，替换 {{EMBEDDING_DIM}} */
  embeddingDim: number;
  /** 自定义迁移目录（默认自动探测 src/db/migrations 或 dist/db/migrations） */
  dir?: string;
}

export interface MigrateResult {
  applied: string[];
  version: number;
  skippedVec: boolean;
}

/** 探测迁移目录：优先源码目录，其次是编译产物目录 */
export function resolveMigrationsDir(): string {
  const root = packageRoot();
  const candidates = [
    path.join(root, 'src', 'db', 'migrations'),
    path.join(root, 'dist', 'db', 'migrations'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`未找到迁移目录，已尝试：${candidates.join(' | ')}`);
}

/** VEC_ONLY 段标记：必须独占一行，避免误伤正文注释 */
const VEC_ONLY_START = /^[ \t]*--[ \t]*>>>VEC_ONLY[ \t]*$/gm;
const VEC_ONLY_END = /^[ \t]*--[ \t]*<<<VEC_ONLY[ \t]*$/gm;

/** 处理占位符与条件段 */
export function prepareMigrationSql(sql: string, embeddingDim: number, vecAvailable: boolean): string {
  const withVec = vecAvailable
    ? sql.replace(VEC_ONLY_START, '').replace(VEC_ONLY_END, '')
    : sql.replace(/^[ \t]*--[ \t]*>>>VEC_ONLY[ \t]*$[\s\S]*?^[ \t]*--[ \t]*<<<VEC_ONLY[ \t]*$/gm, '');
  return withVec.replace(/\{\{EMBEDDING_DIM\}\}/g, String(embeddingDim));
}

function currentVersion(db: DbHandle): number {
  const row = db.driver.get<{ user_version: number }>('PRAGMA user_version');
  return Number(row?.user_version ?? 0);
}

function setVersion(db: DbHandle, version: number): void {
  // PRAGMA 不支持参数绑定，版本号来自受控的迁移序号，可安全拼接
  db.driver.exec(`PRAGMA user_version = ${Math.max(0, Math.trunc(version))};`);
}

/**
 * 执行迁移。
 * @returns 本次实际应用的迁移文件列表与最终版本号
 */
export function runMigrations(db: DbHandle, options: MigrateOptions): MigrateResult {
  const dir = options.dir ?? resolveMigrationsDir();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const version = currentVersion(db);
  const applied: string[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const target = index + 1;
    if (target <= version) continue;

    const raw = readFileSync(path.join(dir, file), 'utf8');
    const sql = prepareMigrationSql(raw, options.embeddingDim, db.vecAvailable);

    db.driver.transaction(() => {
      db.driver.exec(sql);
      setVersion(db, target);
    });
    applied.push(file);
  }

  return {
    applied,
    version: currentVersion(db),
    skippedVec: !db.vecAvailable,
  };
}
