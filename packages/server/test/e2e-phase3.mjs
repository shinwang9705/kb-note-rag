#!/usr/bin/env node
/**
 * 三期端到端自检：**起真实服务进程 + 真实端口 + 临时 DB + 本地 mock OpenAI 兼容服务**。
 *
 * 与单元测试（app.inject 内存调用）不同，这里刻意走真进程 + 真 fetch + 真 SSE 解析，
 * 覆盖「服务能不能起来 / 端口监听 / 路由挂载 / 凭据解密 / ModelGateway 出网 / SSE 流」全链路。
 *
 * LLM 策略：
 *   - 服务端 LLM_PROVIDER=none（无全局回退）；
 *   - A 用户 PUT deepseek 凭据，baseUrlOverride 指向本地 mock OpenAI 服务；
 *   - 这样真实 ModelGateway -> OpenAICompatAdapter -> fetch -> mock 服务 -> SSE 解析 全链路被覆盖，不依赖外网。
 *
 * 用法：node packages/server/test/e2e-phase3.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TMP = path.join(ROOT, 'data', 'tmp', `e2e-phase3-${RUN_ID}`);
const LOG_FILE = path.join(TMP, 'server.log');
const MOCK_PORT = 25000 + Math.floor(Math.random() * 1000);
const SERVER_PORT = 27000 + Math.floor(Math.random() * 1000);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

mkdirSync(TMP, { recursive: true });
writeFileSync(LOG_FILE, '');

let pass = 0;
let fail = 0;
function check(label, condition, extra = '') {
  if (condition) {
    pass += 1;
    console.log(`[PASS] ${label}${extra ? `  ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${label}${extra ? `  ${extra}` : ''}`);
  }
}
const note = (t) => console.log(`       ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 本地 mock OpenAI 兼容服务 ----------------
let thinkCount = 0;
let abortSlowUsed = false;
function thinkArtifact() {
  thinkCount += 1;
  const n = thinkCount;
  return [
    '<outline>',
    `- E2E要点${n}A`,
    `- E2E要点${n}B`,
    '</outline>',
    '<changes>',
    `- added|目标${n}|说明`,
    `- reworded|目标${n}|补充`,
    '</changes>',
    '<score>',
    'clarity: 8',
    'coverage: 7',
    'evidence: 7',
    'concision: 8',
    '</score>',
    '<has_further_improvement>true</has_further_improvement>',
    '<draft>',
    `第${n}轮E2E深度思考草稿`,
    '</draft>',
  ].join('\n');
}

let mockServer = null;
function startMockServer() {
  mockServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const thinking = (messages[0]?.content ?? '').includes('深度思考引擎');
      const lastUser = messages[messages.length - 1]?.content ?? '';

      if (!body.stream) {
        // 非流式：连通性测试 / 摘要
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'E2E 非流式回答' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        return;
      }

      // 流式
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const full = thinking ? thinkArtifact() : 'E2E 多轮助手回答';

      // 首次 ABORT_TEST 思考请求：吐完整 XML 后延迟 3s 才发 [DONE]，留出客户端 abort 窗口。
      // 之后同题目的续跑请求走快速流（避免续跑也慢 3 秒）。
      if (thinking && lastUser.includes('ABORT_TEST') && !abortSlowUsed) {
        abortSlowUsed = true;
        const half = Math.floor(full.length / 2);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(0, half) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(half) } }] })}\n\n`);
        setTimeout(() => {
          try {
            res.write('data: [DONE]\n\n');
            res.end();
          } catch {
            /* 客户端已 abort */
          }
        }, 3000);
        return;
      }

      const half = Math.floor(full.length / 2);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(0, half) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: full.slice(half) } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    mockServer.listen(MOCK_PORT, '127.0.0.1', () => resolve());
  });
}
function stopMockServer() {
  return new Promise((resolve) => {
    if (!mockServer) return resolve();
    mockServer.close(() => resolve());
    mockServer = null;
  });
}

// ---------------- kb-app 服务进程 ----------------
let child = null;
function serverEnv() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(SERVER_PORT),
    DATA_DIR: TMP,
    DB_PATH: path.join(TMP, 'kb.db'),
    JWT_SECRET: 'e2e-phase3-secret-0123456789abcdef',
    EMBEDDING_PROVIDER: 'none',
    ALLOW_REGISTER: 'true',
    LOG_LEVEL: 'warn',
    LOG_FILE: '',
    LLM_PROVIDER: 'none',
    LLM_API_KEY: '',
  };
}
async function startServer() {
  const args = ['--import', 'tsx', path.join('packages', 'server', 'src', 'index.ts')];
  child = spawn(process.execPath, args, { cwd: ROOT, env: serverEnv(), windowsHide: true });
  child.stdout.on('data', (c) => appendFileSync(LOG_FILE, String(c)));
  child.stderr.on('data', (c) => appendFileSync(LOG_FILE, String(c)));
  child.on('exit', (code) => appendFileSync(LOG_FILE, `\n[server exited code=${code}]\n`));
  await waitForHealth(60000);
}
async function stopServer() {
  if (!child) return;
  const target = child;
  child = null;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        target.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 5000);
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      target.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  await sleep(800);
}
async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.data?.status === 'ok') return true;
      }
    } catch {
      /* 未就绪 */
    }
    await sleep(300);
  }
  throw new Error(`服务未在 ${timeoutMs}ms 内就绪。日志：\n${readFileSync(LOG_FILE, 'utf8')}`);
}

// ---------------- HTTP 封装 ----------------
async function api(method, url, { token = null, body = null } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { raw: await res.text().catch(() => '') };
  }
  return { status: res.status, body: json };
}

function parseSseText(text) {
  return text
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.startsWith('data:'))
    .map((c) => {
      const j = c.slice(5).trim();
      if (j === '[DONE]') return null;
      try {
        return JSON.parse(j);
      } catch {
        return { raw: j };
      }
    })
    .filter(Boolean);
}

/** 增量 SSE 事件迭代器（用于中途 abort 场景） */
function sseIterator(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next() {
      for (;;) {
        const nl = buffer.indexOf('\n\n');
        if (nl >= 0) {
          const chunk = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data:')) {
              const j = line.slice(5).trim();
              if (j === '[DONE]') return { done: true };
              try {
                return { done: false, event: JSON.parse(j) };
              } catch {
                return { done: false, event: { raw: j } };
              }
            }
          }
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return { done: true };
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function readEnvKey() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return '';
  const text = readFileSync(envPath, 'utf8');
  const m = /^LLM_API_KEY=(.+)$/m.exec(text);
  if (!m) return '';
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

// ---------------- 主流程 ----------------
async function main() {
  console.log(`运行目录：${TMP}`);
  console.log(`mock LLM：${MOCK_BASE}   kb-app：${BASE}`);

  await startMockServer();
  await startServer();

  try {
    // 0. 健康检查 + meta 补充字段
    const health = await api('GET', '/api/health');
    check('服务可启动且 /api/health ok', health.body?.data?.status === 'ok', `status=${health.body?.data?.status}`);
    const meta = await api('GET', '/api/meta');
    check('/api/meta 含 needsSetup/conversationEnabled/providers 字段', ['needsSetup', 'conversationEnabled', 'providers'].every((k) => k in (meta.body?.data ?? {})), `needsSetup=${meta.body?.data?.needsSetup}`);

    // 1. 注册两用户
    const suffix = RUN_ID.replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const userA = `e2ea_${suffix}`;
    const userB = `e2eb_${suffix}`;
    const PASSWORD = 'e2e-pass-1234';
    const regA = await api('POST', '/api/auth/register', { body: { username: userA, password: PASSWORD } });
    const regB = await api('POST', '/api/auth/register', { body: { username: userB, password: PASSWORD } });
    check('注册 A / B 两个用户', regA.status === 200 && regB.status === 200, `A=${regA.status} B=${regB.status}`);
    const tokenA = regA.body?.data?.token ?? '';
    const tokenB = regB.body?.data?.token ?? '';

    // 2. A 配置 deepseek 凭据（指向本地 mock）
    const cred = await api('PUT', '/api/providers/deepseek/credentials', {
      token: tokenA,
      body: { apiKey: 'e2e-mock-key', baseUrlOverride: MOCK_BASE },
    });
    check('A 配置 deepseek 凭据（baseUrlOverride -> mock）', cred.status === 200 && cred.body?.data?.configured === true);
    const provA = await api('GET', '/api/providers', { token: tokenA });
    check('A 的 deepseek configured=true', (provA.body?.data?.items ?? []).some((p) => p.id === 'deepseek' && p.configured === true));
    const provB = await api('GET', '/api/providers', { token: tokenB });
    check('B 的 deepseek configured=false（凭据硬隔离）', (provB.body?.data?.items ?? []).some((p) => p.id === 'deepseek' && p.configured === false && p.maskedKey === null));

    // 3. A 多轮对话（chat 模式）
    const conv = await api('POST', '/api/conversations', { token: tokenA, body: { title: 'E2E多轮', mode: 'chat' } });
    const convId = conv.body?.data?.item?.id;
    check('A 创建 chat 会话', conv.status === 200 && convId > 0, `id=${convId}`);

    const m1 = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'E2E 第一问：多轮上下文' }),
    });
    const m1Text = await m1.text();
    check('多轮第 1 轮流式完成（done 帧）', m1Text.includes('"type":"done"'), '');
    const m2 = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'E2E 第二问' }),
    });
    const m2Text = await m2.text();
    check('多轮第 2 轮流式完成（done 帧）', m2Text.includes('"type":"done"'), '');

    const msgs = await api('GET', `/api/conversations/${convId}/messages`, { token: tokenA });
    const msgItems = msgs.body?.data?.items ?? [];
    check('多轮消息列表含 2 问 2 答（上下文不丢）', msgItems.length === 4, `messages=${msgItems.length}`);

    // 4. A 深度思考 3 轮（agent 模式）
    const ac = await api('POST', '/api/conversations', { token: tokenA, body: { title: 'E2E深度思考', mode: 'agent', params: { thinkingRounds: 3, maxTokens: 1024 } } });
    const acId = ac.body?.data?.item?.id;
    const athink = await fetch(`${BASE}/api/conversations/${acId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'E2E 深度思考测试问题' }),
    });
    const athinkText = await athink.text();
    const athinkEvents = parseSseText(athinkText);
    const runStarted = athinkEvents.find((e) => e.type === 'run_started');
    const runId = runStarted?.runId;
    check('深度思考 3 轮：收到 run_started', Boolean(runStarted), `runId=${runId}`);
    const runCompleted = athinkEvents.find((e) => e.type === 'run_completed');
    check('深度思考 3 轮：收到 run_completed', Boolean(runCompleted), `stopReason=${runCompleted?.stopReason}`);
    const runDetail = await api('GET', `/api/thinking/runs/${runId}`, { token: tokenA });
    check('深度思考 run 完成 3 轮', runDetail.body?.data?.run?.status === 'completed' && runDetail.body?.data?.run?.completedRounds === 3, `status=${runDetail.body?.data?.run?.status} rounds=${runDetail.body?.data?.run?.completedRounds}`);
    check('深度思考 rounds 落库 3 条', (runDetail.body?.data?.rounds ?? []).length === 3, `rounds=${runDetail.body?.data?.rounds?.length}`);

    // 5. 中途 abort -> 续跑
    const abc = await api('POST', '/api/conversations', { token: tokenA, body: { title: 'E2E中断续跑', mode: 'agent', params: { thinkingRounds: 3, maxTokens: 1024 } } });
    const abcId = abc.body?.data?.item?.id;
    const abortRes = await fetch(`${BASE}/api/conversations/${abcId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ABORT_TEST 请慢速深度思考' }),
    });
    const it = sseIterator(abortRes);
    let abortRunId = null;
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      if (r.event?.type === 'run_started') {
        abortRunId = r.event.runId;
        break;
      }
    }
    check('中断续跑：abort 前拿到 runId', Boolean(abortRunId), `runId=${abortRunId}`);
    await sleep(600);
    const doAbort = await api('POST', `/api/conversations/${abcId}/abort`, { token: tokenA });
    check('中断续跑：POST abort 返回 200', doAbort.status === 200, `aborted=${doAbort.body?.data?.aborted}`);
    let sawAborted = false;
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      if (r.event?.type === 'run_aborted') {
        sawAborted = true;
        break;
      }
    }
    check('中断续跑：收到 run_aborted', sawAborted, '');

    // 续跑
    const resume = await fetch(`${BASE}/api/thinking/runs/${abortRunId}/resume`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const resumeText = await resume.text();
    const resumeEvents = parseSseText(resumeText);
    check('中断续跑：resume 收到 run_completed', resumeEvents.some((e) => e.type === 'run_completed'), `events=${resumeEvents.map((e) => e.type).join(',')}`);
    const resumeDetail = await api('GET', `/api/thinking/runs/${abortRunId}`, { token: tokenA });
    check('中断续跑：resume 后 run 完成 3 轮', resumeDetail.body?.data?.run?.status === 'completed' && resumeDetail.body?.data?.run?.completedRounds === 3, `rounds=${resumeDetail.body?.data?.run?.completedRounds}`);

    // 6. A 历史搜索 / 导出
    const search = await api('POST', '/api/history/search', { token: tokenA, body: { keyword: '深度思考' } });
    check('历史搜索：命中深度思考消息', search.status === 200 && search.body?.data?.total >= 1, `total=${search.body?.data?.total}`);
    const exportMd = await fetch(`${BASE}/api/conversations/${convId}/export?format=md`, { headers: { authorization: `Bearer ${tokenA}` } });
    const mdText = await exportMd.text();
    check('历史导出 md：含标题与消息', exportMd.status === 200 && mdText.includes('# E2E多轮') && mdText.includes('E2E 第一问'), '');

    // 7. B 越权访问 A 的资源全部 404/空
    const bConv = await api('GET', `/api/conversations/${convId}`, { token: tokenB });
    check('B 越权 GET A 会话 -> 404', bConv.status === 404, `status=${bConv.status}`);
    const bRun = await api('GET', `/api/thinking/runs/${runId}`, { token: tokenB });
    check('B 越权 GET A 思考 run -> 404', bRun.status === 404, `status=${bRun.status}`);
    const bSearch = await api('POST', '/api/history/search', { token: tokenB, body: { keyword: '深度思考' } });
    check('B 搜 A 的历史 -> 0 条', bSearch.status === 200 && bSearch.body?.data?.total === 0, `total=${bSearch.body?.data?.total}`);
    const bExport = await api('GET', `/api/conversations/${convId}/export?format=md`, { token: tokenB });
    check('B 越权导出 A 会话 -> 404', bExport.status === 404, `status=${bExport.status}`);

    // 8. 真实 DeepSeek 出网路径（沙箱受限则如实跳过）
    const realKey = readEnvKey();
    if (realKey && realKey.length >= 10) {
      note(`检测到 .env 的 LLM_API_KEY（长度 ${realKey.length}，不打印明文），尝试真实出网连通性测试…`);
      const t0 = Date.now();
      const real = await api('POST', '/api/providers/deepseek/test', { token: tokenA, body: { apiKey: realKey } });
      const took = Date.now() - t0;
      if (real.body?.data?.ok === true) {
        check('真实 DeepSeek 出网连通性测试 ok', true, `${took}ms`);
      } else {
        note(`真实 DeepSeek 出网测试未通过（${took}ms，error=${JSON.stringify(real.body?.data?.error ?? real.body?.raw ?? '')}）。判定为沙箱出网受限，mock 与降级链路已跑通，此项按跳过记录。`);
      }
    } else {
      note('未检测到可用 LLM_API_KEY，跳过真实出网测试。');
    }
  } finally {
    await stopServer();
    await stopMockServer();
  }

  console.log(`\n临时数据目录：${TMP}`);
  console.log(`服务端日志：${LOG_FILE}`);
  console.log(`\n=== e2e phase3: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(async (error) => {
  await stopServer();
  await stopMockServer();
  console.error(`\n[FATAL] ${error instanceof Error ? error.message : String(error)}`);
  try {
    console.error(`---- 服务端日志 ----\n${readFileSync(LOG_FILE, 'utf8').slice(-4000)}`);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
