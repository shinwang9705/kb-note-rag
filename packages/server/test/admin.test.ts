/**
 * 管理员用户管理用例（二期 S2）。
 *
 * 覆盖：普通用户调 admin 接口 403；admin 分页列表含 docCount；
 *       防自禁 409 CANNOT_DISABLE_SELF；防禁最后 admin 409 CANNOT_DISABLE_LAST_ADMIN；
 *       重置密码返回一次性密码；建号（无密码生成一次性密码）；禁用后登录 403。
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
import { hashPassword } from '../src/util/crypto.ts';
import { createUser } from '../src/repo/user.repo.ts';

const TMP = makeTempDir('admin');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

const ADMIN_PASSWORD = 'AdminPass123!';

let ctx: TestApp;
let call: Caller;

const userU = uniqueUsername('adm_u'); // 普通用户
const adminName = uniqueUsername('adm_root');
let tokenU = '';
let tokenAdmin = '';
let adminId = 0;
let userIdU = 0;

async function seedAdmin(username: string, password: string): Promise<number> {
  const passwordHash = await hashPassword(password);
  const row = createUser(ctx.db as never, { username, passwordHash, role: 'admin', status: 'active' });
  return row.id;
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { payload: { username, password } });
  assert.equal(res.status, 200);
  return res.body.data.token as string;
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  // 普通用户 + 一篇文档（供 docCount 校验）
  const regU = await call('POST', '/api/auth/register', { payload: { username: userU, password: PASSWORD } });
  assert.equal(regU.status, 200);
  userIdU = regU.body.data.user.id as number;
  tokenU = regU.body.data.token as string;
  const doc = await call('POST', '/api/documents/text', {
    token: tokenU,
    payload: { title: '管理员测试文档', content: '这篇文档属于普通用户，用于校验 docCount 聚合。' },
  });
  assert.equal(doc.status, 200);

  // 管理员（直接入库，绕过注册的 role='user' 限制）
  adminId = await seedAdmin(adminName, ADMIN_PASSWORD);
  tokenAdmin = await loginAs(adminName, ADMIN_PASSWORD);
});

after(async () => {
  await ctx.close();
});

test('普通用户调 GET /api/admin/users 返回 403 FORBIDDEN', async () => {
  const res = await call('GET', '/api/admin/users', { token: tokenU });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('admin 分页列表返回用户且含 docCount', async () => {
  const res = await call('GET', '/api/admin/users', { token: tokenAdmin });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.total >= 2, `total=${res.body.data.total}`);
  const items = res.body.data.items as Array<{ id: number; username: string; docCount: number }>;
  const uItem = items.find((i) => i.id === userIdU);
  assert.ok(uItem, '列表应包含普通用户');
  assert.equal(uItem!.docCount, 1);
  assert.ok(items.some((i) => i.id === adminId), '列表应包含 admin');
  // 不泄露密码哈希
  assert.ok(items.every((i) => !('password_hash' in i)));
});

test('admin 不能禁用自己：409 CANNOT_DISABLE_SELF', async () => {
  const res = await call('PATCH', `/api/admin/users/${adminId}/status`, {
    token: tokenAdmin,
    payload: { status: 'disabled' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CANNOT_DISABLE_SELF');
});

test('admin 建号（不给密码）返回一次性密码且可用', async () => {
  const newUser = uniqueUsername('adm_new');
  const res = await call('POST', '/api/admin/users', {
    token: tokenAdmin,
    payload: { username: newUser },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user.username, newUser);
  assert.ok(typeof res.body.data.initialPassword === 'string', '应返回一次性密码');
  assert.ok(res.body.data.initialPassword.length >= 12);

  const login = await call('POST', '/api/auth/login', {
    payload: { username: newUser, password: res.body.data.initialPassword },
  });
  assert.equal(login.status, 200, '一次性密码应可登录');
});

test('重置密码返回一次性密码、重置后可登录且恢复 active', async () => {
  // 先禁用目标用户，验证重置后恢复 active
  const target = uniqueUsername('adm_rst');
  await call('POST', '/api/auth/register', { payload: { username: target, password: PASSWORD } });
  const list = await call('GET', '/api/admin/users', { token: tokenAdmin, query: { q: target } });
  const targetId = (list.body.data.items as Array<{ id: number }>)[0]!.id;
  await call('PATCH', `/api/admin/users/${targetId}/status`, {
    token: tokenAdmin,
    payload: { status: 'disabled' },
  });

  const reset = await call('POST', `/api/admin/users/${targetId}/reset-password`, { token: tokenAdmin, payload: {} });
  assert.equal(reset.status, 200);
  assert.ok(typeof reset.body.data.initialPassword === 'string', '应返回一次性密码');

  const login = await call('POST', '/api/auth/login', {
    payload: { username: target, password: reset.body.data.initialPassword },
  });
  assert.equal(login.status, 200, '重置后一次性密码应可登录（恢复 active）');
});

test('防禁最后一个启用状态的管理员：409 CANNOT_DISABLE_LAST_ADMIN', async () => {
  // 再造一个活跃 admin，先禁用成功（此时还有 2 个活跃 admin），再次禁用触发守护
  const admin2Name = uniqueUsername('adm_second');
  const admin2Id = await seedAdmin(admin2Name, ADMIN_PASSWORD);

  const disable1 = await call('PATCH', `/api/admin/users/${admin2Id}/status`, {
    token: tokenAdmin,
    payload: { status: 'disabled' },
  });
  assert.equal(disable1.status, 200, '存在 2 个活跃 admin 时应可禁用');

  const disable2 = await call('PATCH', `/api/admin/users/${admin2Id}/status`, {
    token: tokenAdmin,
    payload: { status: 'disabled' },
  });
  assert.equal(disable2.status, 409, '仅剩 1 个活跃 admin 时再禁应被守护');
  assert.equal(disable2.body.code, 'CANNOT_DISABLE_LAST_ADMIN');
});

test('被禁用用户登录返回 403 USER_DISABLED', async () => {
  const victim = uniqueUsername('adm_dis');
  await call('POST', '/api/auth/register', { payload: { username: victim, password: PASSWORD } });
  const list = await call('GET', '/api/admin/users', { token: tokenAdmin, query: { q: victim } });
  const victimId = (list.body.data.items as Array<{ id: number }>)[0]!.id;

  const disable = await call('PATCH', `/api/admin/users/${victimId}/status`, {
    token: tokenAdmin,
    payload: { status: 'disabled' },
  });
  assert.equal(disable.status, 200);

  const login = await call('POST', '/api/auth/login', { payload: { username: victim, password: PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal(login.body.code, 'USER_DISABLED');
});
