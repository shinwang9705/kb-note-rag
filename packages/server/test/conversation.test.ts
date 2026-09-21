/**
 * 多轮对话引擎用例（三期 T02）。
 *
 * 覆盖：
 *   1. 会话 CRUD + 参数面板（temperature/topP/maxTokens/thinkingRounds）持久化往返；
 *   2. 越权 404（B 访问 A 的会话 get/patch/delete/messages）；
 *   3. 多轮上下文不丢（第二轮请求携带第一轮 user + assistant）；
 *   4. abort 中断生成（streaming 期间停止，assistant 消息标记 aborted）；
 *   5. 参数面板 schema 校验（越界 thinkingRounds -> 422）。
 *
 * LLM 用 mock ModelGateway（createTestAppWithGateway），不依赖外网。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, setTestEnv, makeCall, uniqueUsername, PASSWORD, type Caller } from './harness.ts';
import {
  createMockGateway,
  createTestAppWithGateway,
  textStream,
  parseSse,
  sleep,
  type MockGateway,
  type StreamFactory,
} from './mock-gateway.ts';

const TMP = makeTempDir('conv');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let mock: MockGateway;
let ctx: Awaited<ReturnType<typeof createTestAppWithGateway>>;
let call: Caller;

const userA = uniqueUsername('conv_a');
const userB = uniqueUsername('conv_b');
let tokenA = '';
let tokenB = '';
let convId = 0;

before(async () => {
  mock = createMockGateway({ defaultStream: (async function* () { yield { type: 'content_delta', text: 'mock 回答' }; yield { type: 'finish', finishReason: 'stop' }; }) as StreamFactory });
  ctx = await createTestAppWithGateway(mock.gateway);
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

test('创建会话并持久化参数面板（4 项参数往返）', async () => {
  const res = await call('POST', '/api/conversations', {
    token: tokenA,
    payload: { title: '参数面板测试', mode: 'agent', params: { temperature: 1.3, topP: 0.5, maxTokens: 4096, thinkingRounds: 5 } },
  });
  assert.equal(res.status, 200);
  const item = res.body.data.item as Record<string, any>;
  convId = item.id as number;
  assert.equal(item.mode, 'agent');
  assert.equal(item.params.temperature, 1.3);
  assert.equal(item.params.topP, 0.5);
  assert.equal(item.params.maxTokens, 4096);
  assert.equal(item.params.thinkingRounds, 5);

  // GET 往返校验
  const got = await call('GET', `/api/conversations/${convId}`, { token: tokenA });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.data.item.params, { temperature: 1.3, topP: 0.5, maxTokens: 4096, thinkingRounds: 5 });
});

test('PATCH 修改参数面板与 title/pinned/archived，未覆盖项保留', async () => {
  const res = await call('PATCH', `/api/conversations/${convId}`, {
    token: tokenA,
    payload: { title: '改名后的会话', pinned: true, archived: true, params: { temperature: 0.2 } },
  });
  assert.equal(res.status, 200);
  const item = res.body.data.item as Record<string, any>;
  assert.equal(item.title, '改名后的会话');
  assert.equal(item.pinned, true);
  assert.equal(item.archived, true);
  assert.equal(item.params.temperature, 0.2);
  assert.equal(item.params.topP, 0.5, '未覆盖的 topP 应保留');
  assert.equal(item.params.maxTokens, 4096);
  assert.equal(item.params.thinkingRounds, 5);
});

test('列表分页返回创建的会话', async () => {
  const res = await call('GET', '/api/conversations', { token: tokenA });
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<{ id: number }>;
  assert.ok(items.some((i) => i.id === convId), `列表应包含会话 ${convId}`);
  assert.ok(res.body.data.total >= 1);
});

test('参数面板 schema 校验：thinkingRounds 越界 -> 422', async () => {
  const res = await call('POST', '/api/conversations', {
    token: tokenA,
    payload: { title: '非法参数', params: { thinkingRounds: 11 } },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('多轮上下文不丢：第二轮请求携带第一轮 user + assistant', async () => {
  const c = await call('POST', '/api/conversations', { token: tokenA, payload: { title: '多轮上下文', mode: 'chat' } });
  assert.equal(c.status, 200);
  const id = c.body.data.item.id as number;

  const m1 = await call('POST', `/api/conversations/${id}/messages`, { token: tokenA, payload: { content: '第一问' } });
  assert.equal(m1.status, 200);
  const ev1 = parseSse(m1.body.raw as string);
  assert.ok(ev1.some((e) => e.type === 'done'), `第一轮应发 done 帧：${m1.body.raw}`);

  const m2 = await call('POST', `/api/conversations/${id}/messages`, { token: tokenA, payload: { content: '第二问' } });
  assert.equal(m2.status, 200);
  assert.ok(parseSse(m2.body.raw as string).some((e) => e.type === 'done'));

  // 找到第二轮请求（最后一条 user 消息是「第二问」）
  const req2 = mock.streamRequests.find((r) => {
    const last = r.messages[r.messages.length - 1];
    return last?.role === 'user' && last.content === '第二问';
  });
  assert.ok(req2, '应捕获到第二轮的 chatStream 请求');
  const roles = req2!.messages.map((m) => m.content);
  assert.ok(roles.includes('第一问'), `第二轮上下文应包含第一问：${JSON.stringify(roles)}`);
  assert.ok(roles.includes('mock 回答'), `第二轮上下文应包含第一轮 assistant 回答：${JSON.stringify(roles)}`);
  assert.equal(roles[roles.length - 1], '第二问');
});

test('abort：streaming 期间停止生成，assistant 消息标记 aborted', async () => {
  const c = await call('POST', '/api/conversations', { token: tokenA, payload: { title: 'abort测试', mode: 'chat' } });
  assert.equal(c.status, 200);
  const id = c.body.data.item.id as number;

  // 阻塞流：吐一段后一直等 abort 信号
  mock.pushStream((async function* (_req, signal) {
    yield { type: 'content_delta', text: '生成中…' };
    while (!signal.aborted) {
      await sleep(10);
    }
  }) as StreamFactory);

  const msgPromise = call('POST', `/api/conversations/${id}/messages`, { token: tokenA, payload: { content: '开始生成' } });
  await sleep(150); // 等流进入 activeRuns 且吐出首段

  const abortRes = await call('POST', `/api/conversations/${id}/abort`, { token: tokenA });
  assert.equal(abortRes.status, 200);
  assert.equal(abortRes.body.data.aborted, true);

  const msgRes = await msgPromise;
  const events = parseSse(msgRes.body.raw as string);
  assert.ok(events.some((e) => e.type === 'error' && e.code === 'ABORTED'), `应发 ABORTED error 帧：${msgRes.body.raw}`);

  // 消息列表应包含 aborted 的 assistant 消息
  const list = await call('GET', `/api/conversations/${id}/messages`, { token: tokenA });
  assert.equal(list.status, 200);
  const msgs = list.body.data.items as Array<{ role: string; status: string; content: string }>;
  const assistant = msgs.find((m) => m.role === 'assistant');
  assert.ok(assistant, '应存在 assistant 消息');
  assert.equal(assistant!.status, 'aborted');
  assert.equal(assistant!.content, '生成中…');
});

test('越权：B 访问 A 的会话（get/patch/delete/messages）一律 404', async () => {
  const cases: Array<[string, string, unknown?]> = [
    ['GET', `/api/conversations/${convId}`],
    ['PATCH', `/api/conversations/${convId}`, { title: 'hack' }],
    ['DELETE', `/api/conversations/${convId}`],
    ['GET', `/api/conversations/${convId}/messages`],
  ];
  for (const [method, url, payload] of cases) {
    const res = await call(method, url, { token: tokenB, ...(payload !== undefined ? { payload } : {}) });
    assert.equal(res.status, 404, `${method} ${url} 越权应 404，实际 ${res.status}`);
  }

  // A 自己仍可访问（未被 B 的 DELETE 影响）
  const still = await call('GET', `/api/conversations/${convId}`, { token: tokenA });
  assert.equal(still.status, 200);
});
