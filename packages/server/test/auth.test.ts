/**
 * 鉴权用例：注册 / 登录 / 登出 / 当前用户。
 *
 * 覆盖：注册成功、弱密码、非法用户名、重复用户名、错误密码、
 *      无 token 访问 me、登出后 token 失效、登出不影响另一用户。
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

const TMP = makeTempDir('auth');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('auth_a');
const userB = uniqueUsername('auth_b');
let tokenA = '';
let tokenB = '';

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
});

after(async () => {
  await ctx.close();
});

test('注册成功返回 token 与 user', async () => {
  const res = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.ok(typeof res.body.data.token === 'string' && res.body.data.token.length > 0);
  assert.equal(res.body.data.user.username, userA);
  assert.equal(res.body.data.user.role, 'user');
  // 不得泄露密码哈希
  assert.equal(res.body.data.user.password_hash, undefined);
});

test('弱密码（<8）被拒绝', async () => {
  const res = await call('POST', '/api/auth/register', {
    payload: { username: uniqueUsername('weak'), password: '123' },
  });
  // 注册接口由 Fastify schema 校验（minLength=8），返回 422 VALIDATION_ERROR
  assert.ok(res.status >= 400 && res.status < 500, `实际 status=${res.status}`);
  assert.notEqual(res.body.code, 'OK');
});

test('非法用户名被拒绝', async () => {
  // 含非法字符
  const bad1 = await call('POST', '/api/auth/register', {
    payload: { username: 'bad!name', password: PASSWORD },
  });
  assert.ok(bad1.status >= 400 && bad1.status < 500, `实际 status=${bad1.status}`);

  // 长度不足
  const bad2 = await call('POST', '/api/auth/register', {
    payload: { username: 'ab', password: PASSWORD },
  });
  assert.ok(bad2.status >= 400 && bad2.status < 500, `实际 status=${bad2.status}`);
});

test('重复用户名返回 409', async () => {
  const res = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('登录成功拿到 token', async () => {
  const res = await call('POST', '/api/auth/login', { payload: { username: userA, password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'OK');
  assert.ok(typeof res.body.data.token === 'string' && res.body.data.token.length > 0);
  assert.equal(res.body.data.user.username, userA);
  tokenA = res.body.data.token;
});

test('错误密码返回 401', async () => {
  const res = await call('POST', '/api/auth/login', {
    payload: { username: userA, password: 'WrongPass-999' },
  });
  assert.equal(res.status, 401);
});

test('无 token 访问 me 返回 401', async () => {
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

test('me 返回当前用户', async () => {
  const res = await call('GET', '/api/auth/me', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user.username, userA);
  assert.ok(typeof res.body.data.expiresIn === 'number');
});

test('登出后该 token 立即失效', async () => {
  const logout = await call('POST', '/api/auth/logout', { token: tokenA });
  assert.equal(logout.status, 200);
  assert.equal(logout.body.data.revoked, true);

  const me = await call('GET', '/api/auth/me', { token: tokenA });
  assert.equal(me.status, 401);
});

test('登出不影响另一用户 token', async () => {
  // 注册并登录 B
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  const loginB = await call('POST', '/api/auth/login', { payload: { username: userB, password: PASSWORD } });
  assert.equal(loginB.status, 200);
  tokenB = loginB.body.data.token;

  // A 已在上一用例登出，B 的 token 应依然有效
  const meB = await call('GET', '/api/auth/me', { token: tokenB });
  assert.equal(meB.status, 200);
  assert.equal(meB.body.data.user.username, userB);
});
