/**
 * 五期 QA 独立补充边界（严过关）：标签覆盖式 set 幂等性。
 * 工程师既有 tags.test.ts 覆盖了「二次设置替换旧标签」，但未覆盖：
 *   1) 重复设置相同 tagIds 不产生重复关联（幂等）
 *   2) 空 tagIds 清空全部标签
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

const TMP = makeTempDir('tag-idempotency');
setTestEnv(TMP);

let ctx: TestApp;
let call: Caller;
let token = '';
let docId = 0;

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  const username = uniqueUsername('tagidem');
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  token = reg.body.data.token as string;

  const doc = await call('POST', '/api/documents/text', {
    token,
    payload: { title: '幂等测试文档', content: '这是用于幂等校验的正文内容。'.repeat(6) },
  });
  docId = doc.body.data.item.id as number;
});

after(async () => {
  await ctx.close();
});

test('覆盖式 set 幂等：重复设置相同 tagIds 不产生重复关联', async () => {
  const tag = await call('POST', '/api/documents/tags', { token, payload: { name: '幂等标签' } });
  const tagId = tag.body.data.item.id as number;

  const first = await call('POST', `/api/documents/${docId}/tags`, { token, payload: { tagIds: [tagId] } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data.tags, ['幂等标签']);

  // 再次设置完全相同的 tagIds
  const second = await call('POST', `/api/documents/${docId}/tags`, { token, payload: { tagIds: [tagId] } });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.tags, ['幂等标签']);

  // 详情侧确认无重复
  const detail = await call('GET', `/api/documents/${docId}`, { token });
  assert.deepEqual(detail.body.data.item.tags, ['幂等标签']);
});

test('覆盖式 set 空 tagIds 清空全部标签', async () => {
  const tag = await call('POST', '/api/documents/tags', { token, payload: { name: '将被清空' } });
  const tagId = tag.body.data.item.id as number;

  await call('POST', `/api/documents/${docId}/tags`, { token, payload: { tagIds: [tagId] } });
  const before = await call('GET', `/api/documents/${docId}`, { token });
  assert.deepEqual(before.body.data.item.tags, ['将被清空']);

  const cleared = await call('POST', `/api/documents/${docId}/tags`, { token, payload: { tagIds: [] } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.data.tags, []);

  const afterDetail = await call('GET', `/api/documents/${docId}`, { token });
  assert.deepEqual(afterDetail.body.data.item.tags, []);
});
