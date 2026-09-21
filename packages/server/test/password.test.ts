/**
 * 修改密码用例（二期 S2）。
 *
 * 覆盖：旧密码错误 400 INVALID_OLD_PASSWORD；改密后旧密码失效、新密码可登录；
 *       弱新密码被拒；未登录改密 401。
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

const TMP = makeTempDir('password');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const user = uniqueUsername('pwd');
const NEW_PASSWORD = 'NewPass456!';
let token = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const reg = await call('POST', '/api/auth/register', { payload: { username: user, password: PASSWORD } });
  assert.equal(reg.status, 200);
  token = reg.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('旧密码错误返回 400 INVALID_OLD_PASSWORD', async () => {
  const res = await call('PATCH', '/api/auth/password', {
    token,
    payload: { oldPassword: 'WrongOld-999', newPassword: NEW_PASSWORD },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_OLD_PASSWORD');
});

test('改密成功后旧密码失效、新密码可登录', async () => {
  const change = await call('PATCH', '/api/auth/password', {
    token,
    payload: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(change.status, 200);
  assert.equal(change.body.data.changed, true);

  const oldLogin = await call('POST', '/api/auth/login', { payload: { username: user, password: PASSWORD } });
  assert.equal(oldLogin.status, 401, '旧密码应失效');

  const newLogin = await call('POST', '/api/auth/login', { payload: { username: user, password: NEW_PASSWORD } });
  assert.equal(newLogin.status, 200, '新密码应可登录');
});

test('弱新密码（<8 位）被拒绝', async () => {
  const res = await call('PATCH', '/api/auth/password', {
    token,
    payload: { oldPassword: NEW_PASSWORD, newPassword: '123' },
  });
  assert.ok(res.status === 400 || res.status === 422, `实际 status=${res.status}`);
  assert.notEqual(res.body.code, 'OK');
});

test('未登录改密返回 401', async () => {
  const res = await call('PATCH', '/api/auth/password', {
    payload: { oldPassword: PASSWORD, newPassword: NEW_PASSWORD },
  });
  assert.equal(res.status, 401);
});
