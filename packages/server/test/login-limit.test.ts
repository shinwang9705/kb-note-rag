/**
 * 登录限流用例（二期 S2 / ACC-06）。
 *
 * 覆盖：连续失败达阈值(5) -> 429 LOGIN_LOCKED；锁定期内正确密码也 429；
 *       locked_until 落在未来；不同用户名互不影响；登录成功重置计数。
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

const TMP = makeTempDir('login-limit');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const user = uniqueUsername('lock');

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const reg = await call('POST', '/api/auth/register', { payload: { username: user, password: PASSWORD } });
  assert.equal(reg.status, 200);
});

after(async () => {
  await ctx.close();
});

test('连续错 4 次返回 401，第 5 次触发 429 LOGIN_LOCKED', async () => {
  for (let i = 0; i < 4; i += 1) {
    const res = await call('POST', '/api/auth/login', {
      payload: { username: user, password: 'WrongPass-1' },
    });
    assert.equal(res.status, 401, `第 ${i + 1} 次应 401，实际 ${res.status}`);
    assert.equal(res.body.code, 'INVALID_CREDENTIALS');
  }

  const fifth = await call('POST', '/api/auth/login', {
    payload: { username: user, password: 'WrongPass-1' },
  });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.code, 'LOGIN_LOCKED');
});

test('锁定期内即使密码正确也返回 429，且 locked_until 在未来、fail_count=5', async () => {
  const res = await call('POST', '/api/auth/login', {
    payload: { username: user, password: PASSWORD },
  });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, 'LOGIN_LOCKED');

  const guard = ctx.db.driver.get<{ locked_until: string; fail_count: number }>(
    'SELECT locked_until, fail_count FROM login_guard WHERE user_key = ?',
    [user.toLowerCase()],
  );
  assert.ok(guard, 'login_guard 应有记录');
  assert.ok(new Date(guard!.locked_until).getTime() > Date.now(), 'locked_until 应在未来');
  assert.equal(Number(guard!.fail_count), 5);
});

test('不同用户名之间锁互不影响', async () => {
  const other = uniqueUsername('lock_b');
  const reg = await call('POST', '/api/auth/register', { payload: { username: other, password: PASSWORD } });
  assert.equal(reg.status, 200);

  const login = await call('POST', '/api/auth/login', { payload: { username: other, password: PASSWORD } });
  assert.equal(login.status, 200, '其他用户不应受 A 的锁影响');
});

test('登录成功会重置失败计数', async () => {
  const third = uniqueUsername('lock_c');
  await call('POST', '/api/auth/register', { payload: { username: third, password: PASSWORD } });

  // 先错 2 次
  for (let i = 0; i < 2; i += 1) {
    const res = await call('POST', '/api/auth/login', {
      payload: { username: third, password: 'WrongPass-1' },
    });
    assert.equal(res.status, 401);
  }

  // 正确登录 -> 成功并清除计数
  const okLogin = await call('POST', '/api/auth/login', { payload: { username: third, password: PASSWORD } });
  assert.equal(okLogin.status, 200);

  const guard = ctx.db.driver.get<{ fail_count: number }>(
    'SELECT fail_count FROM login_guard WHERE user_key = ?',
    [third.toLowerCase()],
  );
  assert.equal(guard, undefined, '登录成功后限流记录应被清除');
});
