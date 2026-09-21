/**
 * 历史管理用例（三期 T04）。
 *
 * 覆盖（对照 P0-10/11/12）：
 *   1. 关键词搜索（FTS5 trigram，>=3 字）；
 *   2. 短词 LIKE 兜底（1-2 字中文）；
 *   3. 时间筛选（from/to）；
 *   4. 导出三格式（md/json/txt）+ 非法格式 400；
 *   5. 批量导出 + 越权（B 导出 A 的会话 404、B 搜不到 A 的消息）。
 *
 * 消息通过 conversation 消息流写入（mock LLM），走真实 messages 表 + FTS 触发器。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, setTestEnv, makeCall, uniqueUsername, PASSWORD, type Caller } from './harness.ts';
import { createMockGateway, createTestAppWithGateway, parseSse, type MockGateway } from './mock-gateway.ts';

const TMP = makeTempDir('history');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let mock: MockGateway;
let ctx: Awaited<ReturnType<typeof createTestAppWithGateway>>;
let call: Caller;

const userA = uniqueUsername('his_a');
const userB = uniqueUsername('his_b');
let tokenA = '';
let tokenB = '';
let convA = 0;
let convB2 = 0;

before(async () => {
  mock = createMockGateway();
  ctx = await createTestAppWithGateway(mock.gateway);
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;

  // 会话 1：含独特关键词「量子纠缠态」
  const c1 = await call('POST', '/api/conversations', { token: tokenA, payload: { title: '量子物理讨论', mode: 'chat' } });
  convA = c1.body.data.item.id as number;
  const m1 = await call('POST', `/api/conversations/${convA}/messages`, {
    token: tokenA,
    payload: { content: '量子纠缠态与叠加原理是什么' },
  });
  assert.equal(m1.status, 200);
  assert.ok(parseSse(m1.body.raw as string).some((e) => e.type === 'done'));

  // 会话 2：含独特短词「备份」
  const c2 = await call('POST', '/api/conversations', { token: tokenA, payload: { title: '数据库运维', mode: 'chat' } });
  convB2 = c2.body.data.item.id as number;
  const m2 = await call('POST', `/api/conversations/${convB2}/messages`, {
    token: tokenA,
    payload: { content: '数据库备份策略分为全量备份与增量备份' },
  });
  assert.equal(m2.status, 200);
  assert.ok(parseSse(m2.body.raw as string).some((e) => e.type === 'done'));
});

after(async () => {
  await ctx.close();
});

test('关键词搜索：FTS5 trigram（>=3 字）命中会话 1 的消息', async () => {
  const res = await call('POST', '/api/history/search', { token: tokenA, payload: { keyword: '量子纠缠' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.total >= 1, `应命中：${JSON.stringify(res.body.data)}`);
  const items = res.body.data.items as Array<{ conversationId: number; snippet: string; highlightStart: number; highlightEnd: number }>;
  assert.ok(items.some((i) => i.conversationId === convA), '应命中会话 1');
  const hit = items.find((i) => i.conversationId === convA)!;
  assert.ok(hit.snippet.includes('量子纠缠'), `snippet 应含关键词：${hit.snippet}`);
  assert.ok(hit.highlightEnd > hit.highlightStart, '应返回高亮偏移区间');
});

test('短词 LIKE 兜底：2 字中文「备份」命中会话 2', async () => {
  const res = await call('POST', '/api/history/search', { token: tokenA, payload: { keyword: '备份' } });
  assert.equal(res.status, 200);
  const items = res.body.data.items as Array<{ conversationId: number }>;
  assert.ok(items.some((i) => i.conversationId === convB2), `短词 LIKE 应命中会话 2：${JSON.stringify(items)}`);
});

test('时间筛选：from/to 范围过滤结果准确', async () => {
  const future = '2099-01-01T00:00:00.000Z';
  const past = '2000-01-01T00:00:00.000Z';

  const none = await call('POST', '/api/history/search', { token: tokenA, payload: { keyword: '量子', from: future } });
  assert.equal(none.status, 200);
  assert.equal(none.body.data.total, 0, 'from=未来应 0 命中');

  const none2 = await call('POST', '/api/history/search', { token: tokenA, payload: { keyword: '量子', to: past } });
  assert.equal(none2.status, 200);
  assert.equal(none2.body.data.total, 0, 'to=过去应 0 命中');

  const yes = await call('POST', '/api/history/search', { token: tokenA, payload: { keyword: '量子', from: past, to: future } });
  assert.equal(yes.status, 200);
  assert.ok(yes.body.data.total >= 1, '合法区间应命中');
});

test('导出三格式：md / json / txt 内容正确', async () => {
  const md = await call('GET', `/api/conversations/${convA}/export`, { token: tokenA, query: { format: 'md' } });
  assert.equal(md.status, 200);
  const mdText = md.body.raw as string;
  assert.ok(mdText.startsWith('# 量子物理讨论'), `md 应含标题：${mdText.slice(0, 40)}`);
  assert.ok(mdText.includes('## user'));
  assert.ok(mdText.includes('量子纠缠态与叠加原理是什么'));

  const json = await call('GET', `/api/conversations/${convA}/export`, { token: tokenA, query: { format: 'json' } });
  assert.equal(json.status, 200);
  // 注意：format=json 的导出内容本身是合法 JSON，makeCall 会直接解析进 body（而非 raw）
  const parsed = json.body as { title: string; messages: Array<{ role: string; content: string }> };
  assert.equal(parsed.title, '量子物理讨论');
  assert.ok(parsed.messages.some((m) => m.role === 'user' && m.content.includes('量子纠缠态')));

  const txt = await call('GET', `/api/conversations/${convA}/export`, { token: tokenA, query: { format: 'txt' } });
  assert.equal(txt.status, 200);
  assert.ok((txt.body.raw as string).includes('user: 量子纠缠态与叠加原理是什么'));
});

test('非法导出格式 -> 400 BAD_FORMAT', async () => {
  const res = await call('GET', `/api/conversations/${convA}/export`, { token: tokenA, query: { format: 'xml' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BAD_FORMAT');
});

test('批量导出：POST /api/history/export 合并两个会话', async () => {
  const res = await call('POST', '/api/history/export', {
    token: tokenA,
    payload: { conversationIds: [convA, convB2], format: 'json' },
  });
  assert.equal(res.status, 200);
  const parsed = res.body as Array<{ title: string; messages: unknown[] }>;
  assert.equal(parsed.length, 2);
  assert.ok(parsed.some((s) => s.title === '量子物理讨论'));
  assert.ok(parsed.some((s) => s.title === '数据库运维'));
});

test('越权：B 导出 A 的会话 404、B 搜不到 A 的消息', async () => {
  const exp = await call('GET', `/api/conversations/${convA}/export`, { token: tokenB, query: { format: 'md' } });
  assert.equal(exp.status, 404);
  assert.equal(exp.body.code, 'CONVERSATION_NOT_FOUND');

  const search = await call('POST', '/api/history/search', { token: tokenB, payload: { keyword: '量子纠缠' } });
  assert.equal(search.status, 200);
  assert.equal(search.body.data.total, 0, 'B 不应搜到 A 的消息');
});
