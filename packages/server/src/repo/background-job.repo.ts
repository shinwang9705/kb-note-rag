import type { DbHandle } from '../db/connection.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface BackgroundJobRow { id: number; user_id: number | null; kind: string; payload_json: string; status: JobStatus; priority: number; attempts: number; max_attempts: number; next_run_at: string; lease_owner: string | null; lease_until: string | null; progress: number; stage: string; message: string | null; result_json: string | null; idempotency_key: string | null; created_at: string; updated_at: string; finished_at: string | null }

export function enqueueJob(db: DbHandle, input: { userId: number | null; kind: string; payload: unknown; idempotencyKey?: string | null; priority?: number }): BackgroundJobRow {
  const key = input.idempotencyKey ?? null;
  if (key) {
    const existing = db.driver.get<BackgroundJobRow>('SELECT * FROM background_jobs WHERE user_id IS ? AND kind = ? AND idempotency_key = ?', [input.userId, input.kind, key]);
    if (existing) return existing;
  }
  const result = db.driver.run('INSERT INTO background_jobs (user_id, kind, payload_json, priority, idempotency_key) VALUES (?, ?, ?, ?, ?)', [input.userId, input.kind, JSON.stringify(input.payload ?? {}), input.priority ?? 0, key]);
  return db.driver.get<BackgroundJobRow>('SELECT * FROM background_jobs WHERE id = ?', [result.lastInsertRowid])!;
}

export function listJobs(db: DbHandle, userId: number, limit = 30): BackgroundJobRow[] {
  return db.driver.all<BackgroundJobRow>('SELECT * FROM background_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, Math.min(100, Math.max(1, limit))]);
}

export function cancelJob(db: DbHandle, userId: number, id: number): boolean {
  return db.driver.run("UPDATE background_jobs SET status='cancelled', lease_owner=NULL, lease_until=NULL, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND user_id=? AND status='queued'", [id, userId]).changes > 0;
}

export function claimJob(db: DbHandle, workerId: string, leaseSeconds = 90): BackgroundJobRow | null {
  return db.driver.transaction(() => {
    db.driver.run("UPDATE background_jobs SET status='queued', lease_owner=NULL, lease_until=NULL, message='任务租约过期，已自动恢复', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='running' AND lease_until < strftime('%Y-%m-%dT%H:%M:%fZ','now') AND attempts < max_attempts");
    db.driver.run("UPDATE background_jobs SET status='failed', message='超过最大重试次数', finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='running' AND lease_until < strftime('%Y-%m-%dT%H:%M:%fZ','now') AND attempts >= max_attempts");
    const job = db.driver.get<BackgroundJobRow>("SELECT * FROM background_jobs WHERE status='queued' AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY priority DESC, created_at LIMIT 1");
    if (!job) return null;
    const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const changed = db.driver.run("UPDATE background_jobs SET status='running', attempts=attempts+1, lease_owner=?, lease_until=?, stage='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='queued'", [workerId, until, job.id]).changes;
    return changed ? db.driver.get<BackgroundJobRow>('SELECT * FROM background_jobs WHERE id=?', [job.id]) ?? null : null;
  });
}

export function finishJob(db: DbHandle, id: number, result: unknown): void {
  db.driver.run("UPDATE background_jobs SET status='succeeded', progress=100, stage='done', result_json=?, lease_owner=NULL, lease_until=NULL, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [JSON.stringify(result ?? null), id]);
}

export function renewJobLease(db: DbHandle, id: number, workerId: string, leaseSeconds = 90): boolean {
  const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.driver.run("UPDATE background_jobs SET lease_until=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running' AND lease_owner=?", [until, id, workerId]).changes > 0;
}

export function failJob(db: DbHandle, job: BackgroundJobRow, message: string): void {
  if (job.attempts < job.max_attempts) {
    const next = new Date(Date.now() + Math.min(60_000, 2 ** job.attempts * 2_000)).toISOString();
    db.driver.run("UPDATE background_jobs SET status='queued', stage='retrying', message=?, next_run_at=?, lease_owner=NULL, lease_until=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [message, next, job.id]);
  } else {
    db.driver.run("UPDATE background_jobs SET status='failed', stage='failed', message=?, lease_owner=NULL, lease_until=NULL, finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [message, job.id]);
  }
}
