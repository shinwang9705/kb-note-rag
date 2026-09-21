/**
 * SQLite 驱动统一封装。
 *
 * 设计要点：
 *   1. 接口只暴露最小可用集（exec / run / get / all / loadExtension / close），
 *      上层 repository 不感知底层是 node:sqlite 还是 better-sqlite3。
 *   2. 返回值统一收敛：node:sqlite 会把 INTEGER 列读成 BigInt，这里统一 Number()。
 *   3. 参数绑定统一收敛：boolean -> 1/0，undefined -> null，Date -> ISO 字符串；
 *      需要 BigInt 的地方（vec0 的 rowid / integer metadata）由调用方显式传 BigInt。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/** 支持的绑定参数类型 */
export type SqlParam = string | number | bigint | Buffer | Uint8Array | null;

/** 单行结果 */
export type Row = Record<string, unknown>;

export interface RunResult {
  /** 受影响行数 */
  changes: number;
  /** 最后插入的主键 */
  lastInsertRowid: number;
}

export interface SqliteDriver {
  readonly kind: 'node' | 'better';
  /** 执行多条语句（DDL / PRAGMA / 批量脚本） */
  exec(sql: string): void;
  /** 执行单条写语句 */
  run(sql: string, params?: readonly SqlParam[]): RunResult;
  /** 查询单行 */
  get<T = Row>(sql: string, params?: readonly SqlParam[]): T | undefined;
  /** 查询多行 */
  all<T = Row>(sql: string, params?: readonly SqlParam[]): T[];
  /** 装载扩展（必须在打开数据库时已声明 allowExtension） */
  loadExtension(path: string): void;
  /** 事务包装：回调内所有语句在同一事务中，抛错自动回滚 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type SqliteDriverKind = 'node' | 'better' | 'auto';

export interface OpenDatabaseOptions {
  /** 数据库文件路径；`:memory:` 表示内存库 */
  path: string;
  /** 是否允许装载扩展（sqlite-vec 需要） */
  allowExtension?: boolean;
  /** 驱动选择：node（内置）/ better（better-sqlite3）/ auto */
  driver?: SqliteDriverKind;
}

/** 把 JS 值收敛为 SQLite 能接受的参数 */
function toBindable(value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint' || typeof value === 'number') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 把查询结果行里的 BigInt 收敛为 number，避免 JSON 序列化失败 */
function normalizeRow<T>(row: unknown): T | undefined {
  if (row === undefined || row === null) return undefined;
  const obj = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    out[key] = typeof value === 'bigint' ? Number(value) : value;
  }
  return out as T;
}

/**
 * node:sqlite 实现。
 * 注意：Node 22.22 起开关名是 allowExtension；旧版本是 enableLoadExtension。
 * 二者都必须在构造时传入，事后调用 db.enableLoadExtension(true) 会抛错。
 */
class NodeSqliteDriver implements SqliteDriver {
  readonly kind = 'node' as const;
  private readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlParam[] = []): RunResult {
    const stmt = this.prepare(sql);
    const result = stmt.run(...params.map(toBindable)) as {
      changes?: number | bigint;
      lastInsertRowid?: number | bigint;
    };
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  get<T = Row>(sql: string, params: readonly SqlParam[] = []): T | undefined {
    const stmt = this.prepare(sql);
    return normalizeRow<T>(stmt.get(...params.map(toBindable)));
  }

  all<T = Row>(sql: string, params: readonly SqlParam[] = []): T[] {
    const stmt = this.prepare(sql);
    const rows = stmt.all(...params.map(toBindable)) as unknown[];
    return rows.map((row) => normalizeRow<T>(row) as T);
  }

  loadExtension(path: string): void {
    this.db.loadExtension(path);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败不覆盖原始错误 */
      }
      throw error;
    }
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }

  private prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }
}

/**
 * better-sqlite3 实现（预留）。
 * 只有在显式指定 driver=better 且该依赖已安装时才使用；本机无 native 编译环境时不会走到这里。
 */
class BetterSqlite3Driver implements SqliteDriver {
  readonly kind = 'better' as const;
  // 使用结构化字段保存底层实例，避免引入未安装的 peer 类型
  private readonly db: {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    loadExtension(path: string): void;
    close(): void;
  };

  constructor(db: BetterSqlite3Driver['db']) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: readonly SqlParam[] = []): RunResult {
    const result = this.db.prepare(sql).run(...params.map(toBindable));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  get<T = Row>(sql: string, params: readonly SqlParam[] = []): T | undefined {
    return normalizeRow<T>(this.db.prepare(sql).get(...params.map(toBindable)));
  }

  all<T = Row>(sql: string, params: readonly SqlParam[] = []): T[] {
    const rows = this.db.prepare(sql).all(...params.map(toBindable)) as unknown[];
    return rows.map((row) => normalizeRow<T>(row) as T);
  }

  loadExtension(path: string): void {
    this.db.loadExtension(path);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 忽略 */
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** node:sqlite 在 Node < 22.5 不存在，需要探测 */
export function isNodeSqliteAvailable(): boolean {
  try {
    return typeof DatabaseSync === 'function';
  } catch {
    return false;
  }
}

function openNodeSqlite(filePath: string, allowExtension: boolean): DatabaseSync {
  if (!allowExtension) return new DatabaseSync(filePath);
  // 两个开关名都试一次；用 unknown 中转避免旧 @types/node 不认识新字段名
  try {
    return new DatabaseSync(filePath, { allowExtension: true } as unknown as ConstructorParameters<
      typeof DatabaseSync
    >[1]);
  } catch {
    return new DatabaseSync(filePath, { enableLoadExtension: true } as unknown as ConstructorParameters<
      typeof DatabaseSync
    >[1]);
  }
}

async function openBetterSqlite3(filePath: string, _allowExtension: boolean): Promise<SqliteDriver> {
  // 用变量做 specifier，避免 TS 在依赖未安装时报错（该依赖是可选依赖）
  const specifier = 'better-sqlite3';
  const mod = (await import(specifier)) as unknown as {
    default?: new (p: string, o?: { fileMustExist?: boolean }) => BetterSqlite3Driver['db'];
  };
  const Ctor = mod.default ?? (mod as unknown as new (p: string) => BetterSqlite3Driver['db']);
  const db = new Ctor(filePath);
  return new BetterSqlite3Driver(db);
}

/**
 * 打开数据库。
 * auto 策略：优先 node:sqlite（零安装），不可用时回退 better-sqlite3。
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<SqliteDriver> {
  const driverKind = options.driver ?? 'auto';
  const allowExtension = options.allowExtension ?? false;
  const filePath = options.path;

  const canUseNode = isNodeSqliteAvailable() && (driverKind === 'node' || driverKind === 'auto');
  if (canUseNode) {
    try {
      return new NodeSqliteDriver(openNodeSqlite(filePath, allowExtension));
    } catch (error) {
      if (driverKind === 'node') throw error;
      // auto 模式继续尝试 better-sqlite3
    }
  }

  if (driverKind === 'better' || driverKind === 'auto') {
    return openBetterSqlite3(filePath, allowExtension);
  }

  throw new Error(`无法打开数据库：没有可用的 SQLite 驱动（driver=${driverKind}）`);
}

/** 同步版打开（仅 node:sqlite 可用时使用，供 CLI 脚本简化调用） */
export function openDatabaseSync(options: OpenDatabaseOptions): SqliteDriver {
  if (!isNodeSqliteAvailable()) {
    throw new Error('当前 Node 版本不支持 node:sqlite（需 >= 22.5），请安装 better-sqlite3 并使用异步 API');
  }
  return new NodeSqliteDriver(openNodeSqlite(options.path, options.allowExtension ?? false));
}

/** 判断扩展文件是否存在且非空 */
export function extensionExists(path: string | null | undefined): boolean {
  if (!path) return false;
  return existsSync(path);
}

export { toBindable, normalizeRow };
