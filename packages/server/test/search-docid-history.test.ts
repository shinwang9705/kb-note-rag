/**
 * 文档级检索 + 检索历史用例（二期 S3）。
 *
 * 覆盖：POST/GET /api/search 的 docId 限定；越权 docId 404；
 *       检索历史记录（最近 50）、清空、多用户隔离。
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

const TMP = makeTempDir('search-docid');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('sd_a');
const userB = uniqueUsername('sd_b');
let tokenA = '';
let tokenB = '';
let docIdA = 0;

async function registerAndLogin(username: string): Promise<string> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return login.body.data.token as string;
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  tokenA = await registerAndLogin(userA);
  tokenB = await registerAndLogin(userB);

  const res = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '量子计算入门', content: '量子计算利用量子比特进行并行计算，涉及叠加态与纠缠。' },
  });
  assert.equal(res.status, 200);
  docIdA = res.body.data.item.id as number;
});

after(async () => {
  await ctx.close();
});

test('A 用 docId 限定检索：命中均来自该文档', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '量子计算', docId: docIdA, finalK: 10 },
  });
  assert.equal(res.status, 200);
  const hits = res.body.data.hits as Array<{ docId: number }>;
  assert.ok(hits.length > 0, '应命中');
  assert.ok(hits.every((h) => h.docId === docIdA), '所有命中都应来自指定文档');
});

test('GET /api/search 便捷入口支持 docId', async () => {
  const res = await call('GET', '/api/search', {
    token: tokenA,
    query: { q: '量子', docId: docIdA },
  });
  assert.equal(res.status, 200);
  assert.ok((res.body.data.hits as unknown[]).length > 0);
});

test('B 越权用 A 的 docId 检索：POST 返回 404', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenB,
    payload: { query: '量子计算', docId: docIdA },
  });
  assert.equal(res.status, 404);
});

test('B 越权用 A 的 docId 检索：GET 返回 404', async () => {
  const res = await call('GET', '/api/search', {
    token: tokenB,
    query: { q: '量子', docId: docIdA },
  });
  assert.equal(res.status, 404);
});

test('A 用不存在的 docId 检索返回 404', async () => {
  const res = await call('POST', '/api/search', {
    token: tokenA,
    payload: { query: '量子计算', docId: 999999 },
  });
  assert.equal(res.status, 404);
});

test('检索历史：搜索后记录、倒序返回、含命中数', async () => {
  await call('POST', '/api/search', { token: tokenA, payload: { query: '叠加态' } });
  await call('POST', '/api/search', { token: tokenA, payload: { query: '纠缠' } });

  const res = await call('GET', '/api/search/history', { token: tokenA });
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<{ query: string; hitCount: number }>;
  assert.ok(items.length >= 2, `history=${JSON.stringify(items)}`);
  assert.equal(items[0]!.query, '纠缠', '最新一条应排在最前');
  assert.ok(items.some((i) => i.query === '叠加态'));
});

test('检索历史：DELETE 清空', async () => {
  const del = await call('DELETE', '/api/search/history', { token: tokenA });
  assert.equal(del.status, 200);
  assert.ok(del.body.data.cleared >= 0);

  const res = await call('GET', '/api/search/history', { token: tokenA });
  assert.equal(res.status, 200);
  assert.equal((res.body.data.items as unknown[]).length, 0);
});

test('检索历史：B 的历史不含 A 的检索记录', async () => {
  await call('POST', '/api/search', { token: tokenA, payload: { query: 'A专属词条量子比特' } });
  await call('POST', '/api/search', { token: tokenB, payload: { query: 'B专属词条' } });

  const resB = await call('GET', '/api/search/history', { token: tokenB });
  assert.equal(resB.status, 200);
  const queriesB = (resB.body.data.items as Array<{ query: string }>).map((i) => i.query);
  assert.ok(queriesB.includes('B专属词条'));
  assert.ok(!queriesB.includes('A专属词条量子比特'), 'B 不应看到 A 的历史');
});
