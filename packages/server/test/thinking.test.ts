/**
 * 深度思考引擎用例（三期 T03）。
 *
 * 覆盖（对照 P0-05/06/07）：
 *   1. 3 轮跑通（状态机 + 每轮落库 + 终稿合成）；
 *   2. 早停（has_further_improvement=false -> converged）；
 *   3. 降级①：无 <draft> 标签不丢正文（整段作 draft）；
 *   4. 降级②：连续失败 >= maxConsecutiveFailures 用 lastGood 作终稿；
 *   5. 续跑：aborted run 从 completed_rounds+1 续跑至完成；
 *   6. 预算耗尽：output token 超预算 -> budget_exhausted；
 *   7. 越权：B 访问 A 的 run（get/resume）一律 404。
 *
 * LLM 用 mock ModelGateway，不依赖外网。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, setTestEnv, makeCall, uniqueUsername, PASSWORD, type Caller } from './harness.ts';
import {
  createMockGateway,
  createTestAppWithGateway,
  thinkingArtifact,
  roundStream,
  parseSse,
  type MockGateway,
} from './mock-gateway.ts';
import * as thinkingRepo from '../src/repo/thinking.repo.js';
import { buildBudget } from '../src/thinking/budget.js';
import type { ChatStreamEvent } from '../src/llm/catalog.js';

const TMP = makeTempDir('thinking');
setTestEnv(TMP);
process.env.LLM_PROVIDER = 'none';
process.env.LLM_API_KEY = '';

let mock: MockGateway;
let ctx: Awaited<ReturnType<typeof createTestAppWithGateway>>;
let call: Caller;

const userA = uniqueUsername('thk_a');
const userB = uniqueUsername('thk_b');
let tokenA = '';
let tokenB = '';
let userIdA = 0;
let sharedRunId = 0;

before(async () => {
  mock = createMockGateway();
  ctx = await createTestAppWithGateway(mock.gateway);
  call = makeCall(ctx.app);

  const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
  assert.equal(regA.status, 200);
  tokenA = regA.body.data.token as string;
  userIdA = regA.body.data.user.id as number;
  const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
  assert.equal(regB.status, 200);
  tokenB = regB.body.data.token as string;
});

after(async () => {
  await ctx.close();
});

async function createAgentConversation(params: Record<string, number>): Promise<number> {
  const c = await call('POST', '/api/conversations', {
    token: tokenA,
    payload: { title: '思考测试', mode: 'agent', params },
  });
  assert.equal(c.status, 200);
  return c.body.data.item.id as number;
}

async function sendAgent(convId: number, content: string): Promise<Array<Record<string, unknown>>> {
  const res = await call('POST', `/api/conversations/${convId}/messages`, { token: tokenA, payload: { content } });
  assert.equal(res.status, 200);
  return parseSse(res.body.raw as string);
}

function runIdOf(events: Array<Record<string, unknown>>): number {
  const started = events.find((e) => e.type === 'run_started');
  assert.ok(started, '应发 run_started 帧');
  return started!.runId as number;
}

test('3 轮跑通：每轮落库、终稿合成、状态 completed', async () => {
  const convId = await createAgentConversation({ thinkingRounds: 3, maxTokens: 1024, temperature: 0.7 });
  mock.pushStream(roundStream(thinkingArtifact(1, { hfi: true })));
  mock.pushStream(roundStream(thinkingArtifact(2, { hfi: true })));
  mock.pushStream(roundStream(thinkingArtifact(3, { hfi: true })));

  const events = await sendAgent(convId, '跑通 3 轮测试问题');
  const runId = runIdOf(events);
  sharedRunId = runId;
  assert.ok(events.some((e) => e.type === 'run_completed'), `应发 run_completed：${JSON.stringify(events.map((e) => e.type))}`);

  const got = await call('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
  assert.equal(got.status, 200);
  const run = got.body.data.run as Record<string, any>;
  const rounds = got.body.data.rounds as Array<Record<string, any>>;
  assert.equal(run.status, 'completed');
  assert.equal(run.completedRounds, 3);
  assert.equal(run.stopReason, 'completed');
  assert.equal(run.finalContent, '第3轮草稿正文');
  assert.equal(rounds.length, 3);
  assert.ok(rounds.every((r) => r.status === 'done'));
});

test('早停：has_further_improvement=false -> 第 1 轮即 converged', async () => {
  const convId = await createAgentConversation({ thinkingRounds: 3, maxTokens: 1024 });
  mock.pushStream(roundStream(thinkingArtifact(1, { hfi: false })));

  const events = await sendAgent(convId, '早停测试问题');
  const runId = runIdOf(events);

  const got = await call('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
  const run = got.body.data.run as Record<string, any>;
  assert.equal(run.status, 'completed');
  assert.equal(run.completedRounds, 1);
  assert.equal(run.stopReason, 'converged');
  assert.equal(run.finalContent, '第1轮草稿正文');
});

test('降级①：无 <draft> 标签时整段作 draft，不丢正文', async () => {
  const convId = await createAgentConversation({ thinkingRounds: 1, maxTokens: 1024 });
  mock.pushStream(roundStream('这是没有任何 XML 标签的纯文本正文'));

  const events = await sendAgent(convId, '降级无标签测试');
  const runId = runIdOf(events);

  const got = await call('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
  const run = got.body.data.run as Record<string, any>;
  const rounds = got.body.data.rounds as Array<Record<string, any>>;
  assert.equal(run.status, 'completed');
  assert.equal(run.finalContent, '这是没有任何 XML 标签的纯文本正文');
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0]!.draft, '这是没有任何 XML 标签的纯文本正文', 'draft 应保留整段正文');
});

test('降级②：连续失败 >= 2 时用 lastGood 作终稿（max_failures）', async () => {
  const convId = await createAgentConversation({ thinkingRounds: 3, maxTokens: 1024 });
  mock.pushStream(roundStream(thinkingArtifact(1, { hfi: true, draft: '第一轮好稿' })));
  const fail: ChatStreamEvent[] = [{ type: 'error', error: { kind: 'server', userMessage: 'mock 失败', retryable: false } }];
  mock.pushStream(fail);
  mock.pushStream(fail);

  const events = await sendAgent(convId, '连续失败测试');
  const runId = runIdOf(events);

  const got = await call('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
  const run = got.body.data.run as Record<string, any>;
  const rounds = got.body.data.rounds as Array<Record<string, any>>;
  assert.equal(run.status, 'completed');
  assert.equal(run.stopReason, 'max_failures');
  assert.equal(run.finalContent, '第一轮好稿', '应回退到最后一轮成功草稿');
  assert.equal(rounds.length, 3);
  assert.equal(rounds[0]!.status, 'done');
  assert.equal(rounds[1]!.status, 'failed');
  assert.equal(rounds[2]!.status, 'failed');
});

test('续跑：aborted run 从 completed_rounds+1 续跑至完成', async () => {
  const c = await call('POST', '/api/conversations', {
    token: tokenA,
    payload: { title: '续跑', mode: 'agent', params: { thinkingRounds: 3 } },
  });
  assert.equal(c.status, 200);
  const convId = c.body.data.item.id as number;

  // 直接构造一个已完成 1 轮、状态 aborted 的可续跑 run
  const budget = buildBudget({ temperature: 0.7, topP: 0.95, maxTokens: 1024, thinkingRounds: 3 }, ctx.config);
  const run = thinkingRepo.createRun(ctx.db, userIdA, {
    conversationId: convId,
    messageId: null,
    question: '续跑测试问题',
    strategy: 'sequential',
    requestedRounds: 3,
    budget,
  });
  const iso = new Date().toISOString();
  thinkingRepo.upsertRound(ctx.db, userIdA, {
    runId: run.id,
    index: 1,
    strategy: 'sequential',
    instruction: '首轮',
    draft: '已完成的第1轮草稿',
    outline: ['要点1'],
    changes: [],
    hasFurtherImprovement: true,
    status: 'done',
    tokenIn: 10,
    tokenOut: 10,
    latencyMs: 5,
    startedAt: iso,
    endedAt: iso,
  });
  thinkingRepo.updateRun(ctx.db, userIdA, run.id, { status: 'aborted', completedRounds: 1 });

  // 续跑第 2、3 轮
  mock.pushStream(roundStream(thinkingArtifact(2, { hfi: true })));
  mock.pushStream(roundStream(thinkingArtifact(3, { hfi: true })));

  const res = await call('POST', `/api/thinking/runs/${run.id}/resume`, { token: tokenA });
  assert.equal(res.status, 200);
  const events = parseSse(res.body.raw as string);
  assert.ok(events.some((e) => e.type === 'run_completed'), `续跑应发 run_completed：${res.body.raw}`);

  const got = await call('GET', `/api/thinking/runs/${run.id}`, { token: tokenA });
  const rr = got.body.data.run as Record<string, any>;
  const rounds = got.body.data.rounds as Array<Record<string, any>>;
  assert.equal(rr.status, 'completed');
  assert.equal(rr.completedRounds, 3);
  assert.equal(rr.stopReason, 'completed');
  assert.equal(rounds.length, 3);
  assert.equal(rounds[0]!.draft, '已完成的第1轮草稿', '第 1 轮应保留，不被覆盖');
});

test('预算耗尽：output token 超预算 -> budget_exhausted（保留 lastDraft）', async () => {
  const convId = await createAgentConversation({ thinkingRounds: 3, maxTokens: 256 });
  // 第 1 轮回报超大 output 用量，触发第 2 轮预检超预算
  mock.pushStream(roundStream(thinkingArtifact(1, { hfi: true, draft: '预算耗尽前的草稿' }), { inputTokens: 10, outputTokens: 2000 }));

  const events = await sendAgent(convId, '预算耗尽测试');
  const runId = runIdOf(events);
  assert.ok(events.some((e) => e.type === 'budget_warning'), '应发 budget_warning 帧');

  const got = await call('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
  const run = got.body.data.run as Record<string, any>;
  assert.equal(run.status, 'completed');
  assert.equal(run.stopReason, 'budget_exhausted');
  assert.equal(run.completedRounds, 1);
  assert.equal(run.finalContent, '预算耗尽前的草稿');
});

test('越权：B 访问 A 的 run（get/resume）一律 404', async () => {
  const get = await call('GET', `/api/thinking/runs/${sharedRunId}`, { token: tokenB });
  assert.equal(get.status, 404);
  assert.equal(get.body.code, 'RUN_NOT_FOUND');

  const resume = await call('POST', `/api/thinking/runs/${sharedRunId}/resume`, { token: tokenB });
  assert.equal(resume.status, 404);
  assert.equal(resume.body.code, 'RUN_NOT_FOUND');
});
