/**
 * 文档替换 + 回滚用例（二期 S3 / DOC-05）。
 *
 * 覆盖：成功替换后新内容可检索、旧内容 0 命中；
 *       不支持扩展名回滚（415）、解析失败回滚（415），旧文档仍可检索；
 *       B 越权替换 A 的文档返回 404。
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
import { buildMultipart } from './multipart.ts';

const TMP = makeTempDir('replace');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let ctx: TestApp;
let call: Caller;

const userA = uniqueUsername('rep_a');
const userB = uniqueUsername('rep_b');
let tokenA = '';
let tokenB = '';
let docOld = 0; // 成功替换场景
let docExe = 0; // 不支持扩展名回滚
let docPdf = 0; // 解析失败回滚

async function registerAndLogin(username: string): Promise<string> {
  const reg = await call('POST', '/api/auth/register', { payload: { username, password: PASSWORD } });
  assert.equal(reg.status, 200);
  const login = await call('POST', '/api/auth/login', { payload: { username, password: PASSWORD } });
  assert.equal(login.status, 200);
  return login.body.data.token as string;
}

async function createText(token: string, title: string, content: string): Promise<number> {
  const res = await call('POST', '/api/documents/text', { token, payload: { title, content } });
  assert.equal(res.status, 200);
  return res.body.data.item.id as number;
}

async function replace(token: string, docId: number, filename: string, buffer: Buffer, contentType: string) {
  const { body, contentType: ct } = buildMultipart([
    { field: 'file', filename, contentType, buffer },
  ]);
  return call('PUT', `/api/documents/${docId}/replace`, {
    token,
    headers: { 'content-type': ct },
    payload: body,
  });
}

async function hitsFor(token: string, query: string): Promise<number> {
  const res = await call('POST', '/api/search', { token, payload: { query } });
  assert.equal(res.status, 200);
  return (res.body.data.hits as unknown[]).length;
}

before(async () => {
  ctx = await createTestApp();
  call = makeCall(ctx.app);
  tokenA = await registerAndLogin(userA);
  tokenB = await registerAndLogin(userB);

  docOld = await createText(tokenA, '苹果文档', '旧文档讲苹果种植技术，与香蕉无关。');
  docExe = await createText(tokenA, '特斯拉文档', '旧文档讲特斯拉电动车，与蔚来无关。');
  docPdf = await createText(tokenA, '光伏文档', '旧文档讲光伏发电技术，与风电无关。');
});

after(async () => {
  await ctx.close();
});

test('成功替换：新内容可检索、旧内容 0 命中', async () => {
  const newContent = '新文档讲香蕉运输物流。';
  const res = await replace(tokenA, docOld, '新文档.md', Buffer.from(newContent, 'utf8'), 'text/markdown');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'ready');

  assert.ok((await hitsFor(tokenA, '香蕉')) > 0, '新内容应可检索');
  assert.equal(await hitsFor(tokenA, '苹果'), 0, '旧内容应 0 命中');
});

test('不支持扩展名回滚：415 且旧文档仍可检索', async () => {
  const res = await replace(tokenA, docExe, 'bad.exe', Buffer.from('whatever', 'utf8'), 'application/octet-stream');
  assert.equal(res.status, 415);
  assert.equal(res.body.code, 'UNSUPPORTED_EXT');

  assert.ok((await hitsFor(tokenA, '特斯拉')) > 0, '旧内容应仍可检索');
});

test('解析失败回滚：415 FILE_TYPE_MISMATCH 且旧文档仍可检索', async () => {
  const garbage = Buffer.from('%PDF-1.7\nthis is not a real pdf content', 'utf8');
  const res = await replace(tokenA, docPdf, 'broken.pdf', garbage, 'application/pdf');
  assert.equal(res.status, 415);
  assert.equal(res.body.code, 'FILE_TYPE_MISMATCH');

  assert.ok((await hitsFor(tokenA, '光伏发电')) > 0, '旧内容应仍可检索');
});

test('B 越权替换 A 的文档返回 404', async () => {
  const res = await replace(tokenB, docOld, 'new.md', Buffer.from('劫持内容', 'utf8'), 'text/markdown');
  assert.equal(res.status, 404);
});
