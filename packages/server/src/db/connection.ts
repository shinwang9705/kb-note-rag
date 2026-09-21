/**
 * 数据库单例：打开连接 -> 设置 PRAGMA -> 装载 sqlite-vec -> 提供全局访问。
 *
 * PRAGMA 取值依据：
 *   journal_mode = WAL      ：读写并发，避免读阻塞写
 *   busy_timeout = 5000     ：多进程/多连接竞争时等待而非立即 SQLITE_BUSY
 *   synchronous = NORMAL    ：WAL 下兼顾性能与崩溃安全
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { extensionExists, openDatabase, type SqliteDriver } from './driver.js';

export interface DbHandle {
  driver: SqliteDriver;
  /** 数据库文件路径 */
  path: string;
  /** sqlite-vec 是否成功装载（决定检索模式能否升级为 hybrid） */
  vecAvailable: boolean;
  /** 实际装载的扩展路径，未装载为 null */
  vecPath: string | null;
  /** SQLite 版本字符串 */
  sqliteVersion: string;
  /** sqlite-vec 版本字符串，未装载为 null */
  vecVersion: string | null;
}

let handle: DbHandle | null = null;

/** 依次尝试候选扩展名，找到存在的文件 */
function resolveVecPath(configured: string): string | null {
  const candidates = [configured];
  if (!path.extname(configured)) {
    candidates.push(`${configured}.dll`, `${configured}.so`, `${configured}.dylib`);
  }
  for (const candidate of candidates) {
    if (extensionExists(candidate)) return candidate;
  }
  return null;
}

/** 初始化数据库（幂等：重复调用返回同一句柄） */
export async function initDatabase(config: AppConfig): Promise<DbHandle> {
  if (handle) return handle;

  mkdirSync(path.dirname(config.db.path), { recursive: true });
  mkdirSync(config.db.dataDir, { recursive: true });

  const driver = await openDatabase({
    path: config.db.path,
    allowExtension: true,
    driver: config.db.driver,
  });

  driver.exec('PRAGMA journal_mode = WAL;');
  driver.exec('PRAGMA synchronous = NORMAL;');
  driver.exec('PRAGMA busy_timeout = 5000;');
  driver.exec('PRAGMA foreign_keys = ON;');

  const versionRow = driver.get<{ v: string }>('SELECT sqlite_version() AS v');
  const sqliteVersion = versionRow?.v ?? 'unknown';

  // 装载 sqlite-vec：失败不阻断启动，降级为关键词检索
  let vecAvailable = false;
  let vecVersion: string | null = null;
  let vecPath: string | null = null;
  const candidate = resolveVecPath(config.db.vecPath);
  if (candidate) {
    try {
      driver.loadExtension(candidate);
      const row = driver.get<{ v: string }>('SELECT vec_version() AS v');
      vecVersion = row?.v ?? null;
      vecAvailable = vecVersion !== null;
      vecPath = candidate;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[db] 装载 sqlite-vec 失败（将降级为关键词检索）：${message}`);
      vecAvailable = false;
      vecPath = null;
    }
  } else {
    console.warn(`[db] 未找到 sqlite-vec 扩展（${config.db.vecPath}），将降级为关键词检索`);
  }

  handle = {
    driver,
    path: config.db.path,
    vecAvailable,
    vecPath,
    sqliteVersion,
    vecVersion,
  };
  return handle;
}

/** 获取已初始化的数据库句柄 */
export function getDb(): DbHandle {
  if (!handle) {
    throw new Error('数据库尚未初始化，请先调用 initDatabase(config)');
  }
  return handle;
}

/** 是否已初始化 */
export function isDbInitialized(): boolean {
  return handle !== null;
}

/** 关闭数据库（优雅退出时调用） */
export function closeDatabase(): void {
  if (!handle) return;
  try {
    handle.driver.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[db] 关闭数据库时出错：${message}`);
  }
  handle = null;
}
