/**
 * 四期 T05：驾驶舱聚合接口测试（stats）。
 *
 * 覆盖：
 *   1. GET /api/stats/trend?days=N —— 天数补零、日期逐日连续、今日检索/入库计数正确；
 *   2. GET /api/stats/top?kind=query —— 热门检索词按计数降序；
 *   3. GET /api/stats/top?kind=doc —— 被引用文档按 citations_json 聚合计数；
 *   4. GET /api/documents/stats —— 增强返回 typeDist / statusDist / libraryDist 且数值正确；
 *   5. 越权隔离：B 查不到 A 的 trend / top / documents.stats。
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

const TMP = makeTempDir('stats');
setTestEnv(TMP);

interface RawDriver {
  run: (sql: string, params?: unknown[]) => { changes: number; lastInsertRowid: number };
}

let ctx: TestApp;
let call: Caller;
let tokenA = '';
let tokenB = '';
let userAId = 0;
let libraryId = 0;
let docId1 = 0;
let docId2 = 0;

const userA = uniqueUsername('stats_a');
const userB = uniqueUsername('stats_b');

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
  userAId = a.id;
  const b = await registerAndLogin(userB);
  tokenB = b.token;

  // A 建库 + 两篇文本文档：一篇在库内，一篇未归属
  const lib = await call('POST', '/api/libraries', {
    token: tokenA,
    payload: { name: '驾驶舱库', description: '统计聚合测试' },
  });
  assert.equal(lib.status, 200);
  libraryId = lib.body.data.item.id as number;

  const d1 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '文档一', content: '备份策略：全量备份与增量备份的区别。', libraryId },
  });
  assert.equal(d1.status, 200);
  docId1 = d1.body.data.item.id as number;

  const d2 = await call('POST', '/api/documents/text', {
    token: tokenA,
    payload: { title: '文档二', content: '向量检索：语义相似度与关键词检索的对比。' },
  });
  assert.equal(d2.status, 200);
  docId2 = d2.body.data.item.id as number;

  // 制造检索历史：'备份' 3 次、'向量' 1 次
  for (let i = 0; i < 3; i += 1) {
    const s = await call('POST', '/api/search', { token: tokenA, payload: { query: '备份' } });
    assert.equal(s.status, 200);
  }
  const s2 = await call('POST', '/api/search', { token: tokenA, payload: { query: '向量' } });
  assert.equal(s2.status, 200);

  // 种子 assistant 消息（citations_json），用于 topDocs 聚合：
  // 文档一被引用 2 次、文档二被引用 1 次
  const raw = ctx.db.driver as unknown as RawDriver;
  const conv = raw.run('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [
    userAId,
    '统计种子会话',
  ]);
  const convId = conv.lastInsertRowid;
  assert.ok(convId > 0);

  raw.run(
    "INSERT INTO messages (user_id, conversation_id, seq, role, content, status, citations_json) VALUES (?, ?, 1, 'assistant', ?, 'done', ?)",
    [userAId, convId, '回答一', JSON.stringify([{ docId: docId1, docTitle: '文档一' }])],
  );
  raw.run(
    "INSERT INTO messages (user_id, conversation_id, seq, role, content, status, citations_json) VALUES (?, ?, 2, 'assistant', ?, 'done', ?)",
    [
      userAId,
      convId,
      '回答二',
      JSON.stringify([
        { docId: docId1, docTitle: '文档一' },
        { docId: docId2, docTitle: '文档二' },
      ]),
    ],
  );
});

after(async () => {
  await ctx.close();
});

test('trend 天数补零：series 长度=days、逐日连续、今日有检索/入库计数', async () => {
  const res = await call('GET', '/api/stats/trend', { token: tokenA, query: { days: 7 } });
  assert.equal(res.status, 200);

  const days = res.body.data.days as number;
  const series = res.body.data.series as Array<{ date: string; search: number; chat: number; ingest: number }>;
  assert.equal(days, 7);
  assert.equal(series.length, 7);

  // 逐日连续（相邻两天相差 1 天）
  for (let i = 0; i < series.length; i += 1) {
    assert.match(series[i]!.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (let i = 1; i < series.length; i += 1) {
    const prev = new Date(`${series[i - 1]!.date}T00:00:00Z`).getTime();
    const curr = new Date(`${series[i]!.date}T00:00:00Z`).getTime();
    assert.equal(curr - prev, 86400_000, `日期应逐日连续：${series[i - 1]!.date} -> ${series[i]!.date}`);
  }

  // 补零：今日之前的日子（无活动）应为 0
  const today = new Date().toISOString().slice(0, 10);
  const last = series[series.length - 1]!;
  assert.equal(last.date, today);
  assert.ok(last.search >= 3, `今日检索应>=3，实际 ${last.search}`);
  assert.ok(last.ingest >= 2, `今日入库应>=2，实际 ${last.ingest}`);
  for (let i = 0; i < series.length - 1; i += 1) {
    assert.equal(series[i]!.search, 0, `第 ${i} 天无检索活动应为 0`);
    assert.equal(series[i]!.ingest, 0, `第 ${i} 天无入库活动应为 0`);
  }
});

test('top?kind=query 返回热门检索词且按计数降序', async () => {
  const res = await call('GET', '/api/stats/top', { token: tokenA, query: { kind: 'query' } });
  assert.equal(res.status, 200);

  const items = res.body.data.items as Array<{ key: string; title: string; count: number }>;
  assert.ok(items.length >= 2);
  assert.equal(items[0]!.key, '备份');
  assert.equal(items[0]!.count, 3);
  assert.equal(items[1]!.key, '向量');
  assert.equal(items[1]!.count, 1);
});

test('top?kind=doc 按被引用次数聚合且降序', async () => {
  const res = await call('GET', '/api/stats/top', { token: tokenA, query: { kind: 'doc' } });
  assert.equal(res.status, 200);

  const items = res.body.data.items as Array<{ key: string; title: string; count: number }>;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.key, String(docId1));
  assert.equal(items[0]!.title, '文档一');
  assert.equal(items[0]!.count, 2);
  assert.equal(items[1]!.key, String(docId2));
  assert.equal(items[1]!.title, '文档二');
  assert.equal(items[1]!.count, 1);
});

test('documents.stats 增强：typeDist / statusDist / libraryDist 正确', async () => {
  const res = await call('GET', '/api/documents/stats', { token: tokenA });
  assert.equal(res.status, 200);

  assert.equal(res.body.data.docTotal, 2);

  const typeDist = res.body.data.typeDist as Array<{ key: string; label: string; count: number }>;
  assert.deepEqual(typeDist, [{ key: 'text', label: '纯文本', count: 2 }]);

  const statusDist = res.body.data.statusDist as Array<{ key: string; label: string; count: number }>;
  assert.deepEqual(statusDist, [{ key: 'ready', label: '就绪', count: 2 }]);

  const libraryDist = res.body.data.libraryDist as Array<{ key: string; label: string; count: number }>;
  assert.equal(libraryDist.length, 2);
  const inLib = libraryDist.find((item) => item.key === String(libraryId));
  const unassigned = libraryDist.find((item) => item.key === 'none');
  assert.ok(inLib, '应包含库内文档分布');
  assert.equal(inLib!.count, 1);
  assert.equal(inLib!.label, '驾驶舱库');
  assert.ok(unassigned, '应包含未分类分布');
  assert.equal(unassigned!.count, 1);
  assert.equal(unassigned!.label, '未分类');
});

test('top 非法 kind -> 422 VALIDATION_ERROR（schema enum 校验）', async () => {
  const res = await call('GET', '/api/stats/top', { token: tokenA, query: { kind: 'bogus' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('越权隔离：B 查不到 A 的 trend / top / documents.stats', async () => {
  const trend = await call('GET', '/api/stats/trend', { token: tokenB, query: { days: 7 } });
  assert.equal(trend.status, 200);
  const series = trend.body.data.series as Array<{ search: number; chat: number; ingest: number }>;
  assert.ok(series.length === 7);
  assert.ok(series.every((point) => point.search === 0 && point.chat === 0 && point.ingest === 0));

  const top = await call('GET', '/api/stats/top', { token: tokenB, query: { kind: 'query' } });
  assert.equal(top.status, 200);
  assert.deepEqual(top.body.data.items, []);

  const stats = await call('GET', '/api/documents/stats', { token: tokenB });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.docTotal, 0);
  assert.deepEqual(stats.body.data.typeDist, []);
  assert.deepEqual(stats.body.data.statusDist, []);
  assert.deepEqual(stats.body.data.libraryDist, []);
});
