/**
 * 四期 T04：知识库只读共享用例。
 *
 * 覆盖：
 *   1. 生成分享得 token/url；重复生成续期同 token；
 *   2. 无登录可用 token 访问 meta/documents/search；
 *   3. search 结果限定该库（搜不到库外文档）；
 *   4. 越权：B 不能撤销 A 的分享；share token 非 JWT 不能用于写接口（401）；
 *   5. DELETE 撤销后 token 404；伪造 token 404；
 *   6. documents 脱敏（不含 storage_path/userId/mimeType/fileName）。
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

const TMP = makeTempDir('share');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let tokenA = '';
let tokenB = '';
let libraryId = 0;
let shareToken = '';

const userA = uniqueUsername('share_a');
const userB = uniqueUsername('share_b');

async function registerAndLogin(username: string): Promise<{ token: string; id: number }> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.body.data.token as string, id: login.body.data.user.id as number };
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);

  const a = await registerAndLogin(userA);
  tokenA = a.token;
  const b = await registerAndLogin(userB);
  tokenB = b.token;

  // A 建库 + 两篇文档：一篇在库内，一篇无归属（库外），内容含同一独特词
  const lib = await call('POST', '/api/libraries', {
    token: tokenA,
    payload: { name: '共享库', description: '只读共享测试' },
  });
  assert.equal(lib.status, 200);
  libraryId = lib.body.data.item.id as number;

  const inDoc = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '共享文档A', content: '共享专用词：数据备份策略分为全量、增量与差异备份。', libraryId },
  });
  assert.equal(inDoc.status, 200);

  const outDoc = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '库外文档', content: '共享专用词：这段内容不属于任何知识库，仅用于验证库边界。' },
  });
  assert.equal(outDoc.status, 200);
});

after(async () => {
  await ctx.close();
});

test('生成分享得 token/url，重复生成续期同 token', async () => {
  const first = await call('POST', `/api/libraries/${libraryId}/share`, { token: tokenA });
  assert.equal(first.status, 200);
  assert.ok(typeof first.body.data.token === 'string' && first.body.data.token.length >= 32);
  assert.ok((first.body.data.url as string).includes('#/share/'));
  shareToken = first.body.data.token as string;

  const second = await call('POST', `/api/libraries/${libraryId}/share`, { token: tokenA });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.token, shareToken);
});

test('无登录 GET /api/share/:token 返回库名/描述/文档数', async () => {
  const res = await call('GET', `/api/share/${shareToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.library.name, '共享库');
  assert.equal(res.body.data.library.description, '只读共享测试');
  assert.ok((res.body.data.library.docCount as number) >= 1);
});

test('无登录 GET /api/share/:token/documents 返回脱敏白名单', async () => {
  const res = await call('GET', `/api/share/${shareToken}/documents`);
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<Record<string, unknown>>;
  assert.ok(items.length >= 1);
  for (const item of items) {
    assert.ok('id' in item && 'title' in item && 'fileExt' in item && 'charCount' in item);
    assert.ok('chunkCount' in item && 'status' in item && 'updatedAt' in item);
    // 脱敏：不得泄露内部字段
    assert.ok(!('storage_path' in item), '不得泄露 storage_path');
    assert.ok(!('error_message' in item), '不得泄露 error_message');
    assert.ok(!('userId' in item), '不得泄露 userId');
    assert.ok(!('mimeType' in item), '不得泄露 mimeType');
    assert.ok(!('fileName' in item), '不得泄露 fileName');
  }
  // 库外文档（libraryId=null）不应出现在该库的文档列表里
  assert.ok(items.every((item) => item.title === '共享文档A'));
});

test('无登录 POST /api/share/:token/search 只读检索且限定该库', async () => {
  const res = await call('POST', `/api/share/${shareToken}/search`, { payload: { query: '共享专用词' } });
  assert.equal(res.status, 200);
  const hits = res.body.data.hits as Array<{ docTitle: string; docId: number }>;
  assert.ok(hits.length >= 1);
  // 只命中库内文档，搜不到库外文档（库边界由 libraryId 过滤保证）
  assert.ok(hits.every((hit) => hit.docTitle === '共享文档A'));
});

test('越权：B 不能撤销 A 的分享（404，不泄露存在性）', async () => {
  const res = await call('DELETE', `/api/libraries/${libraryId}/share`, { token: tokenB });
  assert.equal(res.status, 404);
});

test('share token 非 JWT，不能用于写接口（401）', async () => {
  const res = await call('POST', '/api/documents/text', {
    headers: { authorization: `Bearer ${shareToken}` },
    payload: { title: '越权写入', content: '这段不应被写入' },
  });
  assert.equal(res.status, 401);
});

test('伪造 token -> 404', async () => {
  const res = await call('GET', '/api/share/forged-token-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('DELETE 撤销后 token 404（meta 与 search 均失效）', async () => {
  const del = await call('DELETE', `/api/libraries/${libraryId}/share`, { token: tokenA });
  assert.equal(del.status, 200);
  assert.equal(del.body.data.revoked, true);

  const meta = await call('GET', `/api/share/${shareToken}`);
  assert.equal(meta.status, 404);

  const search = await call('POST', `/api/share/${shareToken}/search`, { payload: { query: '共享专用词' } });
  assert.equal(search.status, 404);
});
