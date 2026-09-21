/**
 * 四期 T04 补强（QA 独立补充，非 rubber-stamp 复核）：
 *   既有 share.test.ts 已覆盖「生成/续期/公开读/脱敏/越权撤销/伪造 token/撤销后 404」，
 *   本文件补齐其未覆盖的边界：
 *     1. share token 过期 -> 404（meta 与 search 均失效）；
 *     2. B 越权生成 A 库的分享 -> 404（写路径 owner 边界）；
 *     3. share search 越权：token 有效但检索严格限定该库，库外文档（term 仅在库外）搜不到。
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

const TMP = makeTempDir('share-edge');
setTestEnv(TMP);

/** 运行期真实 driver 含 run（harness 的类型收敛为 all/get），此处取最小可用面 */
interface RawDriver {
  run: (sql: string, params?: unknown[]) => { changes: number; lastInsertRowid: number };
}

let ctx: TestApp;
let call: Caller;
let tokenA = '';
let tokenB = '';
let libraryId = 0;

const userA = uniqueUsername('sh_edge_a');
const userB = uniqueUsername('sh_edge_b');

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

  const lib = await call('POST', '/api/libraries', {
    token: tokenA,
    payload: { name: '共享库·边界', description: '只读共享边界测试' },
  });
  assert.equal(lib.status, 200);
  libraryId = lib.body.data.item.id as number;

  // 库内文档：只含 ASCII 唯一词「alpha」
  const inDoc = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '库内文档', content: 'alpha：数据备份分为全量备份与增量备份。', libraryId },
  });
  assert.equal(inDoc.status, 200);

  // 库外文档（libraryId=null）：只含 ASCII 唯一词「beta」
  const outDoc = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '库外文档', content: 'beta：这段内容仅存在于未归属任何知识库的文档中。' },
  });
  assert.equal(outDoc.status, 200);
});

after(async () => {
  await ctx.close();
});

test('share token 过期 -> meta 与 search 均 404', async () => {
  const created = await call('POST', `/api/libraries/${libraryId}/share`, { token: tokenA });
  assert.equal(created.status, 200);
  const token = created.body.data.token as string;

  // 直接把 expires_at 改成过去，模拟过期（绕开 API 无法创建已过期链接的限制）
  const raw = ctx.db.driver as unknown as RawDriver;
  const upd = raw.run('UPDATE library_shares SET expires_at = ? WHERE token = ?', [
    '2000-01-01T00:00:00.000Z',
    token,
  ]);
  assert.equal(upd.changes, 1);

  const meta = await call('GET', `/api/share/${token}`);
  assert.equal(meta.status, 404);
  assert.equal(meta.body.code, 'NOT_FOUND');

  const search = await call('POST', `/api/share/${token}/search`, { payload: { query: 'alpha' } });
  assert.equal(search.status, 404);
  assert.equal(search.body.code, 'NOT_FOUND');
});

test('B 越权生成 A 库的分享 -> 404（不泄露存在性）', async () => {
  const res = await call('POST', `/api/libraries/${libraryId}/share`, { token: tokenB });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('share search 越权：token 有效但检索限定该库，库外文档搜不到', async () => {
  const created = await call('POST', `/api/libraries/${libraryId}/share`, { token: tokenA });
  assert.equal(created.status, 200);
  const token = created.body.data.token as string;

  // 「beta」只存在于库外文档；share search 限定 libraryId，应 0 命中
  const res = await call('POST', `/api/share/${token}/search`, { payload: { query: 'beta' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.hits.length, 0);

  // 对照：库内词「alpha」应能命中，证明 token 有效而非空转
  const inRes = await call('POST', `/api/share/${token}/search`, { payload: { query: 'alpha' } });
  assert.equal(inRes.status, 200);
  assert.ok(inRes.body.data.hits.length >= 1);
  assert.ok(inRes.body.data.hits.every((hit: { docTitle: string }) => hit.docTitle === '库内文档'));
});
