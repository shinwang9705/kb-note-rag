#!/usr/bin/env node
/**
 * 检索链路端到端自检：**起真实服务进程 + 发真实 HTTP 请求**。
 *
 * 与 check-ingest.mjs（app.inject 内存调用）不同，这里刻意走真进程 + 真端口，
 * 为的是覆盖"服务能不能起来 / 端口能不能监听 / 路由有没有挂上 / 环境变量有没有生效"，
 * 这些是内存调用测不出来的。
 *
 * 用法：npm run check:search
 *
 * 场景：
 *   第一轮 EMBEDDING_PROVIDER=local（本机无模型时会自动降级，脚本如实报告）
 *   第二轮 **重启**为 EMBEDDING_PROVIDER=none，验证降级链路仍能召回
 */
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TMP = path.join(ROOT, 'data', 'tmp', `search-check-${RUN_ID}`);
const LOG_FILE = path.join(TMP, 'server.log');
const PORT = 22000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;

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

function note(text) {
  console.log(`       ${text}`);
}

// ---------------- 进程管理 ----------------
let child = null;

function serverEnv(provider) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: String(PORT),
    DATA_DIR: TMP,
    DB_PATH: path.join(TMP, 'kb.db'),
    JWT_SECRET: 'search-check-secret-0123456789abcdef',
    EMBEDDING_PROVIDER: provider,
    CHUNK_SIZE: '400',
    CHUNK_OVERLAP: '80',
    ALLOW_REGISTER: 'true',
    LOG_LEVEL: 'warn',
    LOG_FILE: '',
    MAX_UPLOAD_MB: '20',
  };
}

async function startServer(provider) {
  const args = ['--import', 'tsx', path.join('packages', 'server', 'src', 'index.ts')];
  child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: serverEnv(provider),
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => appendFileSync(LOG_FILE, String(chunk)));
  child.stderr.on('data', (chunk) => appendFileSync(LOG_FILE, String(chunk)));
  child.on('exit', (code) => appendFileSync(LOG_FILE, `\n[server exited code=${code}]\n`));

  await waitForHealth(60_000);
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
        /* 已退出 */
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
  // 等端口彻底释放，避免下一轮 EADDRINUSE
  await sleep(800);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      /* 服务还没起来，继续等 */
    }
    await sleep(300);
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有就绪，端口 ${PORT}。服务端日志：\n${readFileSync(LOG_FILE, 'utf8')}`);
}

// ---------------- HTTP 封装 ----------------
async function api(method, url, { token = null, body = null } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { raw: await res.text().catch(() => '') };
  }
  return { status: res.status, body: json };
}

function multipart(boundary, files) {
  const chunks = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.buffer,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function upload(token, filename, text, contentType = 'text/markdown; charset=utf-8') {
  const boundary = `----kbsearch${randomBytes(8).toString('hex')}`;
  const payload = multipart(boundary, [{ filename, contentType, buffer: Buffer.from(text, 'utf8') }]);
  const res = await fetch(`${BASE}/api/documents/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: payload,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { raw: await res.text().catch(() => '') };
  }
  return { status: res.status, body: json };
}

// ---------------- 语料 ----------------
// 关键约束：正文里**不能**出现"防止数据丢失"这个连续串
const DOC_BACKUP = `# 数据备份与恢复

备份策略分为全量备份、增量备份与差异备份三种。全量备份每周日凌晨执行一次，
增量备份每小时执行一次，写入对象存储的近线桶。

恢复演练：每季度做一次恢复演练，验证恢复点目标 RPO 与恢复时间目标 RTO 是否达标。
演练步骤包括挂载快照、回放增量日志、校验行数与抽样比对。

常见故障：硬盘损坏、误删表、机房断电。定期备份可以在这些情况下避免数据损毁与丢失。
恢复完成后需要重新建立索引并跑一次完整性校验。
`;

const DOC_VECTOR = `# 向量检索原理

向量检索把文本映射成稠密向量，再通过余弦相似度或内积召回候选片段。
常用的索引结构有 HNSW、IVF-PQ 与暴力扫描三种。

本项目使用 sqlite-vec 扩展提供的 vec0 虚表存放向量，
KNN 查询通过 embedding MATCH 加 k 参数完成。
`;

const DOC_ACCOUNT = `# 账号与权限

系统采用自签 JWT 做鉴权，令牌放在 Authorization 头的 Bearer 字段。
登出通过 jti 黑名单实现，令牌仍然有效但会被服务端拒绝。

多用户之间数据硬隔离，所有查询都强制带上 user_id 条件，
本知识库不会把一个用户的片段返回给另一个用户。
`;

const DOCS = [
  { filename: '数据备份与恢复.md', text: DOC_BACKUP, expectTitle: '数据备份与恢复' },
  { filename: '向量检索原理.md', text: DOC_VECTOR, expectTitle: '向量检索原理' },
  { filename: '账号与权限.md', text: DOC_ACCOUNT, expectTitle: '账号与权限' },
];

const SYNONYM_QUERY = '怎么防止数据丢失';
const TARGET_TITLE = '数据备份与恢复';

function printHits(label, result, max = 3) {
  const hits = result?.hits ?? [];
  note(`${label}：mode=${result?.mode} 命中=${hits.length} stats=${JSON.stringify(result?.stats)} fallbackLike=${result?.fallbackLike} tookMs=${result?.tookMs}`);
  hits.slice(0, max).forEach((hit, i) => {
    const snip = (hit.snippet ?? '').replace(/\n/g, ' ');
    note(
      `   #${i + 1} [${hit.source}] score=${hit.score} docId=${hit.docId} seq=${hit.seq} ` +
        `《${hit.docTitle}》 chunk=${hit.charStart}-${hit.charEnd} hl=${hit.highlightStart}-${hit.highlightEnd}`,
    );
    note(`      ${snip}`);
  });
  if (result?.warnings?.length) note(`   告警：${result.warnings.join(' | ')}`);
}

// ---------------- 主流程 ----------------
async function runScenario(provider, options) {
  console.log(`\n================ 场景：EMBEDDING_PROVIDER=${provider} ================`);
  await startServer(provider);

  try {
    const meta = await api('GET', '/api/meta');
    check(
      `${provider} /api/meta 返回的 searchMode 是合法值（不是 unknown）`,
      ['hybrid', 'keyword', 'vector'].includes(meta.body?.data?.searchMode),
      `searchMode=${meta.body?.data?.searchMode} embeddingProvider=${meta.body?.data?.embeddingProvider} vec=${meta.body?.data?.vecAvailable}`,
    );

    const modeRes = await api('GET', '/api/search/mode', { token: options.tokenA });
    check(
      `${provider} /api/search/mode 可用`,
      modeRes.status === 200 && typeof modeRes.body?.data?.mode === 'string',
      `mode=${modeRes.body?.data?.mode} vectorReady=${modeRes.body?.data?.vectorReady}`,
    );

    // ---- 断言 5：同义/近义召回 ----
    const syn = await api(
      'POST',
      '/api/search',
      { token: options.tokenA, body: { query: SYNONYM_QUERY, finalK: 10 } },
    );
    printHits(`查询「${SYNONYM_QUERY}」`, syn.body?.data);
    const synHits = syn.body?.data?.hits ?? [];
    const hitTarget = synHits.find((h) => (h.docTitle ?? '').includes(TARGET_TITLE));
    check(
      `${provider} 查询「${SYNONYM_QUERY}」能召回《${TARGET_TITLE}》`,
      syn.status === 200 && Boolean(hitTarget),
      hitTarget
        ? `命中 #${synHits.indexOf(hitTarget) + 1} source=${hitTarget.source} offset=${hitTarget.charStart}-${hitTarget.charEnd}`
        : `实际命中标题：${synHits.map((h) => h.docTitle).join(' / ') || '(空)'}`,
    );

    // ---- 断言 6：1-2 字中文走 LIKE 兜底 ----
    const short = await api(
      'POST',
      '/api/search',
      { token: options.tokenA, body: { query: '向量', finalK: 10 } },
    );
    printHits('查询「向量」（2 字，trigram 必然 0 命中）', short.body?.data, 2);
    check(
      `${provider} 2 字中文查询「向量」有结果（LIKE 兜底生效）`,
      short.status === 200 && (short.body?.data?.hits ?? []).length > 0,
      `hits=${(short.body?.data?.hits ?? []).length} fallbackLike=${short.body?.data?.fallbackLike} stats=${JSON.stringify(short.body?.data?.stats)}`,
    );

    const one = await api('POST', '/api/search', { token: options.tokenA, body: { query: '库', finalK: 10 } });
    check(
      `${provider} 1 字中文查询「库」有结果`,
      one.status === 200 && (one.body?.data?.hits ?? []).length > 0,
      `hits=${(one.body?.data?.hits ?? []).length} fallbackLike=${one.body?.data?.fallbackLike}`,
    );

    // ---- 断言 7：跨用户隔离 ----
    const cross = await api(
      'POST',
      '/api/search',
      { token: options.tokenB, body: { query: SYNONYM_QUERY, finalK: 10 } },
    );
    check(
      `${provider} B 用户搜同一词返回 0 条（向量+关键词双通道隔离）`,
      cross.status === 200 && (cross.body?.data?.hits ?? []).length === 0,
      `hits=${(cross.body?.data?.hits ?? []).length} stats=${JSON.stringify(cross.body?.data?.stats)}`,
    );

    const crossShort = await api('POST', '/api/search', { token: options.tokenB, body: { query: '向量', finalK: 10 } });
    check(
      `${provider} B 用户搜「向量」返回 0 条`,
      crossShort.status === 200 && (crossShort.body?.data?.hits ?? []).length === 0,
      `hits=${(crossShort.body?.data?.hits ?? []).length}`,
    );

    return syn;
  } finally {
    await stopServer();
  }
}

async function main() {
  // ---- 第一轮：local（本机无模型则自动降级，如实报告）----
  console.log(`运行目录：${TMP}`);
  console.log(`服务端口：${PORT}`);

  await startServer('local');
  const health = await api('GET', '/api/health');
  check('服务能起来且 /api/health 返回 ok', health.body?.data?.status === 'ok', `status=${health.body?.data?.status} vec=${health.body?.data?.vec}`);

  const suffix = RUN_ID.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  const userA = `sea_${suffix}`;
  const userB = `seb_${suffix}`;
  const PASSWORD = 'search-pass-1234';

  const regA = await api('POST', '/api/auth/register', { body: { username: userA, password: PASSWORD } });
  const regB = await api('POST', '/api/auth/register', { body: { username: userB, password: PASSWORD } });
  check('注册 A / B 两个用户', regA.status === 200 && regB.status === 200, `A=${regA.status} B=${regB.status}`);

  const loginA = await api('POST', '/api/auth/login', { body: { username: userA, password: PASSWORD } });
  const loginB = await api('POST', '/api/auth/login', { body: { username: userB, password: PASSWORD } });
  const tokenA = loginA.body?.data?.token ?? '';
  const tokenB = loginB.body?.data?.token ?? '';
  check('登录 A / B 拿到 token', tokenA.length > 0 && tokenB.length > 0);

  // 未登录检索必须 401
  const anon = await api('POST', '/api/search', { body: { query: '向量' } });
  check('未登录调用 /api/search 返回 401', anon.status === 401, `status=${anon.status}`);

  // 空查询必须 400
  const empty = await api('POST', '/api/search', { token: tokenA, body: { query: '   ' } });
  check('空查询返回 400', empty.status === 400 || empty.status === 422, `status=${empty.status}`);

  // ---- 上传语料 ----
  const docIds = [];
  for (const doc of DOCS) {
    const res = await upload(tokenA, doc.filename, doc.text);
    const item = res.body?.data?.item;
    docIds.push(item?.id);
    check(
      `上传《${doc.expectTitle}》并进入 ready`,
      res.status === 200 && item?.status === 'ready',
      `status=${res.status} docStatus=${item?.status} chunks=${item?.chunkCount} chars=${item?.charCount} err=${item?.errorMessage ?? '-'}`,
    );
  }

  // 关键词通道就绪：确认 FTS 索引里能查到 3 字以上中文
  const ftsProbe = await api('POST', '/api/search', { token: tokenA, body: { query: '恢复演练' , finalK: 10 } });
  check(
    'FTS 通道可用（4 字中文「恢复演练」有结果）',
    (ftsProbe.body?.data?.hits ?? []).length > 0,
    `hits=${(ftsProbe.body?.data?.hits ?? []).length} stats=${JSON.stringify(ftsProbe.body?.data?.stats)}`,
  );

  await stopServer();

  // ---- 两轮场景（各自重启服务）----
  await runScenario('local', { tokenA, tokenB });
  await runScenario('none', { tokenA, tokenB });

  console.log(`\n临时数据目录：${TMP}`);
  console.log(`服务端日志：${LOG_FILE}`);
}

main()
  .then(() => {
    console.log(`\n=== search check: ${pass} passed, ${fail} failed ===`);
    process.exitCode = fail === 0 ? 0 : 1;
  })
  .catch(async (error) => {
    await stopServer();
    console.error(`\n[FATAL] ${error instanceof Error ? error.message : String(error)}`);
    try {
      console.error(`---- 服务端日志 ----\n${readFileSync(LOG_FILE, 'utf8').slice(-4000)}`);
    } catch {
      /* 日志不可读时忽略 */
    }
    process.exitCode = 1;
  });
