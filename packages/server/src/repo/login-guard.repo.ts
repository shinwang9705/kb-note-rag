/**
 * 登录限流数据访问层。
 *
 * key = lower(username)：登录前还没有 user_id，只能用用户名做唯一键（与设计蓝图一致）。
 * 时间一律 ISO-8601 UTC 字符串，与列默认值 strftime('%Y-%m-%dT%H:%M:%fZ','now') 对齐。
 */
import type { DbHandle } from '../db/connection.js';

export interface LoginGuardRow {
  user_key: string;
  fail_count: number;
  first_fail: string | null;
  locked_until: string | null;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** 计算 now + lockMinutes 分钟的 UTC ISO 字符串 */
function isoAfterMinutes(minutes: number): string {
  return new Date(Date.now() + Math.max(1, Math.trunc(minutes)) * 60 * 1000).toISOString();
}

/** 读取某个 user_key 的限流状态；不存在返回 undefined */
export function getGuard(db: DbHandle, key: string): LoginGuardRow | undefined {
  return db.driver.get<LoginGuardRow>('SELECT * FROM login_guard WHERE user_key = ?', [key]);
}

/**
 * 记录一次失败：fail_count+1；达到阈值（maxAttempts）后锁定 lockMinutes 分钟。
 * 返回更新后的记录，调用方据此决定抛 429 还是 401。
 */
export function recordFailure(
  db: DbHandle,
  key: string,
  maxAttempts: number,
  lockMinutes: number,
): LoginGuardRow {
  const existing = getGuard(db, key);
  const failCount = (existing?.fail_count ?? 0) + 1;
  const reachedThreshold = failCount >= Math.max(1, Math.trunc(maxAttempts));
  const lockedUntil = reachedThreshold ? isoAfterMinutes(lockMinutes) : null;

  db.driver.run(
    `INSERT INTO login_guard (user_key, fail_count, first_fail, locked_until, updated_at)
     VALUES (?, ?, ${NOW}, ?, ${NOW})
     ON CONFLICT(user_key) DO UPDATE SET
       fail_count = excluded.fail_count,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
    [key, failCount, lockedUntil],
  );
  return getGuard(db, key) as LoginGuardRow;
}

/** 清除某个 user_key 的限流状态（登录成功 / 锁过期时调用） */
export function resetGuard(db: DbHandle, key: string): void {
  db.driver.run('DELETE FROM login_guard WHERE user_key = ?', [key]);
}
