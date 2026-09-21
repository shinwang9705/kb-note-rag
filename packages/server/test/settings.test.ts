/**
 * 用户设置用例（三期 T04）。
 *
 * 覆盖（对照 P0-04/P0-18/P1-05）：
 *   1. 默认值合并：未 PATCH 时返回 shared/config 默认；
 *   2. 读写往返：PATCH 后 GET 返回修改值，未覆盖项保留；
 *   3. 多用户隔离：B 的设置独立于 A（各自 user_settings 行）；
 *   4. 未登录 401。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempDir,
  setTestEnv,
  createTestApp,
  makeCall,
  uniqueUsername,
  PASSWORD,
  type TestApp,
  type Caller,
} from './harness.ts';

const TMP = makeTempDir('settings');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('set_a');
const userB = uniqueUsername('set_b');
let tokenA = '';
let tokenB = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('默认值合并：未 PATCH 时返回 shared/config 默认', async () => {
  const res = await call('GET', '/api/settings', { token: tokenA });
  assert.equal(res.status, 200);
  const s = res.body.data as Record<string, any>;
  assert.equal(s.generation.temperature, 0.7);
  assert.equal(s.generation.topP, 0.95);
  assert.equal(s.generation.maxTokens, 2048);
  assert.equal(s.generation.thinkingRounds, 3);
  assert.equal(s.thinking.maxRounds, 3);
  assert.equal(s.ui.themeId, 'light');
  assert.equal(s.wizardCompleted, false);
});

test('读写往返：PATCH 后 GET 返回修改值，未覆盖项保留', async () => {
  const patch = await call('PATCH', '/api/settings', {
    token: tokenA,
    payload: { generation: { temperature: 1.2 }, ui: { themeId: 'dark' }, wizardCompleted: true },
  });
  assert.equal(patch.status, 200);
  const s = patch.body.data.settings as Record<string, any>;
  assert.equal(s.generation.temperature, 1.2);
  assert.equal(s.generation.topP, 0.95, '未覆盖的 topP 应保留');
  assert.equal(s.ui.themeId, 'dark');
  assert.equal(s.wizardCompleted, true);

  const got = await call('GET', '/api/settings', { token: tokenA });
  assert.equal(got.status, 200);
  assert.equal(got.body.data.generation.temperature, 1.2);
  assert.equal(got.body.data.ui.themeId, 'dark');
  assert.equal(got.body.data.wizardCompleted, true);
});

test('多用户隔离：B 的设置独立于 A（不含 A 的修改）', async () => {
  const gotB = await call('GET', '/api/settings', { token: tokenB });
  assert.equal(gotB.status, 200);
  const s = gotB.body.data as Record<string, any>;
  assert.equal(s.ui.themeId, 'light', 'B 不应继承 A 的 dark 主题');
  assert.equal(s.wizardCompleted, false, 'B 不应继承 A 的向导完成态');
  assert.equal(s.generation.temperature, 0.7, 'B 不应继承 A 的 1.2 温度');
});

test('未登录访问 /api/settings 返回 401', async () => {
  const res = await call('GET', '/api/settings');
  assert.equal(res.status, 401);
});
