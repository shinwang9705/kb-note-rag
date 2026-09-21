#!/usr/bin/env node
/**
 * 冒烟测试：注册 -> 登录 -> me -> 隔离验证 -> 登出。
 * 用法（需后端已启动）：node scripts/smoke.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const suffix = Math.random().toString(36).slice(2, 8);
const userA = { username: `smoke_a_${suffix}`, password: 'SmokeTest123' };
const userB = { username: `smoke_b_${suffix}`, password: 'SmokeTest123' };

let failures = 0;

function check(name, condition, extra = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${name}${extra ? ` -> ${extra}` : ''}`);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`=== smoke: ${BASE} ===`);

  console.log('\n1) 健康检查');
  const health = await call('/api/health');
  check('GET /api/health 200', health.status === 200, JSON.stringify(health.json));
  check('health.data.status = ok', health.json?.data?.status === 'ok');

  const meta = await call('/api/meta');
  check('GET /api/meta 200', meta.status === 200, JSON.stringify(meta.json?.data));

  console.log('\n2) 注册用户 A / B');
  const regA = await call('/api/auth/register', { method: 'POST', body: userA });
  check('注册 A 成功', regA.status === 200 && regA.json?.code === 'OK', JSON.stringify(regA.json));
  const regB = await call('/api/auth/register', { method: 'POST', body: userB });
  check('注册 B 成功', regB.status === 200 && regB.json?.code === 'OK');

  const dup = await call('/api/auth/register', { method: 'POST', body: userA });
  check('重复用户名返回 409', dup.status === 409, `status=${dup.status}`);

  console.log('\n3) 登录');
  const loginA = await call('/api/auth/login', { method: 'POST', body: userA });
  check('登录 A 成功并拿到 token', loginA.status === 200 && typeof loginA.json?.data?.token === 'string');
  const tokenA = loginA.json?.data?.token;
  const loginB = await call('/api/auth/login', { method: 'POST', body: userB });
  const tokenB = loginB.json?.data?.token;
  check('登录 B 成功并拿到 token', loginB.status === 200 && typeof tokenB === 'string');

  const badLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { username: userA.username, password: 'wrong-password' },
  });
  check('错误密码返回 401', badLogin.status === 401, `status=${badLogin.status}`);

  console.log('\n4) 当前用户');
  const meA = await call('/api/auth/me', { token: tokenA });
  check('me(A) 返回 A 自己', meA.json?.data?.user?.username === userA.username, JSON.stringify(meA.json?.data?.user));
  const meAnonymous = await call('/api/auth/me');
  check('无 token 访问 me 返回 401', meAnonymous.status === 401, `status=${meAnonymous.status}`);

  console.log('\n5) 多用户隔离');
  const libA = await call('/api/libraries', {
    method: 'POST',
    body: { name: `A的知识库-${suffix}` },
    token: tokenA,
  });
  check('A 创建知识库成功', libA.status === 200, JSON.stringify(libA.json));
  const libAId = libA.json?.data?.item?.id;

  const listA = await call('/api/libraries', { token: tokenA });
  const listB = await call('/api/libraries', { token: tokenB });
  const aIds = (listA.json?.data?.items ?? []).map((i) => i.id);
  const bIds = (listB.json?.data?.items ?? []).map((i) => i.id);
  check('A 的列表包含自己创建的知识库', aIds.includes(libAId), `aIds=${JSON.stringify(aIds)}`);
  check('B 的列表不含 A 的知识库', !bIds.includes(libAId), `bIds=${JSON.stringify(bIds)}`);

  const crossRead = await call(`/api/libraries/${libAId}`, { token: tokenB });
  check('B 越权读取 A 的知识库返回 404', crossRead.status === 404, `status=${crossRead.status}`);

  const crossDelete = await call(`/api/libraries/${libAId}`, { method: 'DELETE', token: tokenB });
  check('B 越权删除 A 的知识库返回 404', crossDelete.status === 404, `status=${crossDelete.status}`);

  console.log('\n6) 登出');
  const logoutA = await call('/api/auth/logout', { method: 'POST', token: tokenA });
  check('登出 A 成功', logoutA.status === 200 && logoutA.json?.data?.revoked === true);
  const meAfterLogout = await call('/api/auth/me', { token: tokenA });
  check('登出后 token 立即失效', meAfterLogout.status === 401, `status=${meAfterLogout.status}`);
  const meB = await call('/api/auth/me', { token: tokenB });
  check('B 的 token 不受 A 登出影响', meB.status === 200, `status=${meB.status}`);

  console.log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke 执行失败：', err);
  process.exit(1);
});
