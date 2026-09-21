/**
 * 批量上传用例（二期 S3）。
 *
 * 覆盖：多文件混合（有效+无效）-> accepted/rejected 分离、单文件失败不影响其余；
 *       ≤10 个文件全部 accepted 边界。
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
import { buildMultipart, type MultipartFile } from './multipart.ts';

const TMP = makeTempDir('batch-upload');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const user = uniqueUsername('batch');
let token = '';

function upload(files: MultipartFile[]) {
  const { body, contentType } = buildMultipart(files);
  return call('POST', '/api/documents/upload', {
    token,
    headers: { 'content-type': contentType },
    payload: body,
  });
}

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

test('混合文件批量上传：有效入 accepted、无效入 rejected、互不影响', async () => {
  const res = await upload([
    { field: 'file', filename: 'a.md', contentType: 'text/markdown', buffer: Buffer.from('# 甲\n批量上传有效文档甲。') },
    { field: 'file', filename: 'bad.exe', contentType: 'application/octet-stream', buffer: Buffer.from('exe') },
    { field: 'file', filename: 'b.txt', contentType: 'text/plain', buffer: Buffer.from('批量上传有效文档乙。') },
  ]);
  assert.equal(res.status, 200);

  const accepted = res.body.data.accepted as Array<{ docId: number; status: string; title: string }>;
  const rejected = res.body.data.rejected as Array<{ fileName: string; code: string }>;
  assert.equal(accepted.length, 2, `accepted=${JSON.stringify(accepted)}`);
  assert.ok(accepted.every((a) => a.status === 'ready'));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.fileName, 'bad.exe');
  assert.equal(rejected[0]!.code, 'UNSUPPORTED_TYPE');

  // 有效的两个文件应可检索（验证失败未拖累其余）
  const search = await call('POST', '/api/search', { token, payload: { query: '批量上传有效文档' } });
  assert.equal(search.status, 200);
  assert.ok((search.body.data.hits as unknown[]).length > 0);
});

test('10 个文件全部 accepted（≤10 边界）', async () => {
  const files: MultipartFile[] = [];
  for (let i = 1; i <= 10; i += 1) {
    files.push({
      field: 'file',
      filename: `f${i}.txt`,
      contentType: 'text/plain',
      buffer: Buffer.from(`批量边界文档 ${i} 号内容。`),
    });
  }
  const res = await upload(files);
  assert.equal(res.status, 200);
  assert.equal((res.body.data.accepted as unknown[]).length, 10);
  assert.equal((res.body.data.rejected as unknown[]).length, 0);
});

test('无文件上传返回 400', async () => {
  const { body, contentType } = buildMultipart([]);
  const res = await call('POST', '/api/documents/upload', {
    token,
    headers: { 'content-type': contentType },
    payload: body,
  });
  assert.equal(res.status, 400);
});
