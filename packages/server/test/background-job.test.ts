import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeCall, makeTempDir, PASSWORD, setTestEnv, uniqueUsername, type TestApp } from './harness.ts';
import type { DbHandle } from '../src/db/connection.ts';
import { cancelJob, claimJob, enqueueJob, finishJob, listJobs, renewJobLease } from '../src/repo/background-job.repo.ts';

setTestEnv(makeTempDir('background-job'));
let ctx: TestApp;
let db: DbHandle;
let userId = 0;

before(async () => {
  ctx = await createTestApp();
  db = ctx.db as unknown as DbHandle;
  const username = uniqueUsername('job_user');
  const response = await makeCall(ctx.app)('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  userId = Number(response.body.data.user.id);
});
after(async () => { await ctx.close(); });

test('后台任务可持久化认领、续租并完成', () => {
  const queued = enqueueJob(db, { userId, kind: 'reindex', payload: { userId, libraryId: null } });
  assert.equal(queued.status, 'queued');
  const claimed = claimJob(db, 'worker-test');
  assert.equal(claimed?.id, queued.id);
  assert.equal(claimed?.attempts, 1);
  assert.equal(renewJobLease(db, queued.id, 'worker-test'), true);
  finishJob(db, queued.id, { docs: 2 });
  const stored = listJobs(db, userId)[0];
  assert.equal(stored?.status, 'succeeded');
  assert.equal(stored?.progress, 100);
});

test('排队任务可以安全取消且不会再被认领', () => {
  const queued = enqueueJob(db, { userId, kind: 'reindex', payload: { userId } });
  assert.equal(cancelJob(db, userId, queued.id), true);
  assert.equal(listJobs(db, userId).find((item) => item.id === queued.id)?.status, 'cancelled');
});
