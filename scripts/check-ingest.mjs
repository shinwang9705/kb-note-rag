#!/usr/bin/env node
/**
 * 入库链路端到端自检（第 3、4 步验收）：
 *   注册 -> 登录 -> 上传(md/txt/pdf) -> 列表 -> 详情 -> 片段偏移校验 -> FTS 命中
 *   -> 下载 -> 越权隔离 -> 删除 -> 不支持类型/空文件/纯文本入库
 *
 * 用法：npx tsx scripts/check-ingest.mjs
 *
 * 说明：用 app.inject() 直接打内存请求，不占端口，也不需要起服务。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 每次运行用独立目录，避免依赖 rmSync 清理（干净且不会被批量删除保护拦截）
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TMP = path.join(ROOT, 'data', 'tmp', `ingest-check-${RUN_ID}`);

// 环境变量必须在 import config 之前设置
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'kb.db');
process.env.JWT_SECRET = 'ingest-check-secret-0123456789abcdef';
process.env.EMBEDDING_PROVIDER = 'none';
process.env.CHUNK_SIZE = '400';
process.env.CHUNK_OVERLAP = '80';
process.env.ALLOW_REGISTER = 'true';
process.env.LOG_LEVEL = 'error';
process.env.LOG_FILE = '';
process.env.MAX_UPLOAD_MB = '20';

mkdirSync(TMP, { recursive: true });

const { loadConfig } = await import('../packages/server/src/config.ts');
const { initDatabase, closeDatabase } = await import('../packages/server/src/db/connection.ts');
const { runMigrations } = await import('../packages/server/src/db/migrate.ts');
const { createLogger } = await import('../packages/server/src/logger.ts');
const { buildApp } = await import('../packages/server/src/app.ts');
const { initEmbeddingProvider } = await import('../packages/server/src/embedding/index.ts');

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

/** 构造 multipart/form-data 请求体 */
function multipart(fields, files) {
  const boundary = `----kbcheck${Math.random().toString(36).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
      file.buffer,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { buffer: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const config = loadConfig();
check(
  '分块参数按 400/80 生效',
  config.chunk.size === 400 && config.chunk.overlap === 80,
  `size=${config.chunk.size} overlap=${config.chunk.overlap}`,
);
const logger = createLogger(config, { level: 'error' });
const db = await initDatabase(config);
runMigrations(db, { embeddingDim: config.embedding.dim });
const embedding = await initEmbeddingProvider({ config, logger: null });
const app = await buildApp({ config, logger, db, startedAt: Date.now(), embedding });

/** 请求封装：自动附带 token，返回 { status, body } */
async function call(method, url, options = {}, token = null) {
  const response = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...options,
  });
  let body = null;
  try {
    body = JSON.parse(response.payload);
  } catch {
    body = { raw: response.payload };
  }
  return { status: response.statusCode, body };
}

async function upload(token, fileName, buffer, contentType, query = '') {
  const { buffer: payload, contentType: ct } = multipart({}, [
    { field: 'file', filename: fileName, contentType, buffer },
  ]);
  return call('POST', `/api/documents/upload${query}`, { payload, headers: { 'content-type': ct, authorization: `Bearer ${token}` } });
}

// ---------- 1. 账号 ----------
const userA = `ingest_a_${Date.now().toString(36)}`;
const userB = `ingest_b_${Date.now().toString(36)}`;
const PASSWORD = 'check-pass-1234';

const regA = await call('POST', '/api/auth/register', { payload: { username: userA, password: PASSWORD } });
check('注册用户 A', regA.status === 200 || regA.status === 201, `status=${regA.status}`);
const regB = await call('POST', '/api/auth/register', { payload: { username: userB, password: PASSWORD } });
check('注册用户 B', regB.status === 200 || regB.status === 201, `status=${regB.status}`);

const loginA = await call('POST', '/api/auth/login', { payload: { username: userA, password: PASSWORD } });
const tokenA = loginA.body?.data?.token ?? '';
check('登录 A 拿到 token', loginA.status === 200 && tokenA.length > 0, `status=${loginA.status}`);
const loginB = await call('POST', '/api/auth/login', { payload: { username: userB, password: PASSWORD } });
const tokenB = loginB.body?.data?.token ?? '';
check('登录 B 拿到 token', loginB.status === 200 && tokenB.length > 0, `status=${loginB.status}`);

const meNoAuth = await call('GET', '/api/documents');
check('未登录访问文档列表返回 401', meNoAuth.status === 401, `status=${meNoAuth.status}`);

// ---------- 2. 上传 md ----------
const mdText = '# 知识库标题\n\n这是一个用于验证入库链路的 Markdown 文档。\n包含中文与 English 混排内容。\n';
const upMd = await upload(tokenA, 'note.md', Buffer.from(mdText, 'utf8'), 'text/markdown');
const mdDoc = upMd.body?.data?.item ?? null;
check('上传 md 成功且状态 ready', upMd.status === 200 && mdDoc?.status === 'ready', `status=${upMd.status} docStatus=${mdDoc?.status}`);
check('md 标题从内容推断', mdDoc?.title === '知识库标题', `title=${mdDoc?.title}`);
check('md 片段数 >= 1', (mdDoc?.chunkCount ?? 0) >= 1, `chunkCount=${mdDoc?.chunkCount}`);

// ---------- 3. 上传长中文 txt：验证 400/80 分块与偏移 ----------
const sentence = '知识库系统的核心目标是把散落的文档变成可检索的资产，';
const longText = sentence.repeat(60); // 约 1500 字，必然切多块
const upTxt = await upload(tokenA, 'long.txt', Buffer.from(longText, 'utf8'), 'text/plain; charset=utf-8');
const txtDoc = upTxt.body?.data?.item ?? null;
check('上传长 txt 成功', upTxt.status === 200 && txtDoc?.status === 'ready', `status=${upTxt.status}`);
check('长文本被切成多块', (txtDoc?.chunkCount ?? 0) > 1, `chunkCount=${txtDoc?.chunkCount} chars=${txtDoc?.charCount}`);

const chunksRes = await call('GET', `/api/documents/${txtDoc?.id}/chunks`, {}, tokenA);
const chunks = chunksRes.body?.data?.items ?? [];
check('片段列表可读', chunksRes.status === 200 && chunks.length === txtDoc?.chunkCount, `count=${chunks.length}`);

const offsetsOk =
  chunks.length > 0 &&
  chunks.every((c) => longText.slice(c.charStart, c.charEnd) === c.content && c.charEnd > c.charStart);
check('片段 charStart/charEnd 与原文严格对齐', offsetsOk);

const alignsWithWindow =
  chunks.length < 2 || chunks.slice(1).every((c, i) => c.charStart < chunks[i].charEnd);
check('相邻片段存在重叠（overlap=80）', alignsWithWindow);

const seqOk = chunks.every((c, i) => c.seq === i);
check('片段 seq 连续递增', seqOk);
console.log(
  `       边界: ${chunks.map((c) => `${c.charStart}-${c.charEnd}`).join(',')}` +
    `  首块头: ${JSON.stringify(chunks[0]?.content.slice(0, 24) ?? '')}`,
);

// ---------- 4. 上传合规 PDF ----------
const { buildPdf } = await import('./make-pdf-sample.mjs');
const pdfBuffer = buildPdf(['KB Parser Regression Sample', 'Generated by scripts/make-pdf-sample.mjs']);
const upPdf = await upload(tokenA, 'gen-sample.pdf', pdfBuffer, 'application/pdf');
const pdfDoc = upPdf.body?.data?.item ?? null;
check(
  '上传合规 PDF 解析成功',
  upPdf.status === 200 && pdfDoc?.status === 'ready',
  `status=${upPdf.status} docStatus=${pdfDoc?.status} err=${pdfDoc?.errorMessage ?? '-'}`,
);
check('PDF 提取到英文文本', (pdfDoc?.charCount ?? 0) > 20, `charCount=${pdfDoc?.charCount}`);

// ---------- 5. 异常分支 ----------
const upExe = await upload(tokenA, 'malware.exe', Buffer.from('MZ'), 'application/octet-stream');
check(
  '不支持类型返回 400/40011',
  upExe.status === 400 && upExe.body?.details?.errNo === 40011,
  `status=${upExe.status} errNo=${upExe.body?.details?.errNo}`,
);

const upEmpty = await upload(tokenA, 'empty.txt', Buffer.from('   \n\t  '), 'text/plain');
check(
  '空文本返回 400/40012',
  upEmpty.status === 400 && upEmpty.body?.details?.errNo === 40012,
  `status=${upEmpty.status} errNo=${upEmpty.body?.details?.errNo}`,
);

const upNoFile = await call('POST', '/api/documents/upload', { payload: Buffer.from(''), headers: { 'content-type': 'multipart/form-data; boundary=X', authorization: `Bearer ${tokenA}` } });
check('缺少文件字段返回 4xx', upNoFile.status >= 400 && upNoFile.status < 500, `status=${upNoFile.status}`);

// ---------- 6. 纯文本入库 ----------
const textRes = await call(
  'POST',
  '/api/documents/text',
  { payload: { title: '手工录入笔记', content: '这是一条通过接口直接录入的知识条目，用于验证纯文本入库路径。' } },
  tokenA,
);
const textDoc = textRes.body?.data?.item ?? null;
check(
  '纯文本入库成功',
  textRes.status === 200 && textDoc?.status === 'ready' && textDoc?.sourceType === 'text',
  `status=${textRes.status} srcType=${textDoc?.sourceType}`,
);

// ---------- 7. FTS 索引已同步 ----------
const ftsRows = db.driver.all(
  `SELECT c.id, c.doc_id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
   WHERE chunks_fts MATCH ? AND c.user_id = ? LIMIT 5`,
  ['知识库系统', Number(loginA.body?.data?.user?.id ?? 0)],
);
check('FTS5 trigram 索引已同步并可命中 4 字中文', ftsRows.length > 0, `hits=${ftsRows.length}`);

// ---------- 8. 列表与详情 ----------
// 期望 5 条：md / 长 txt / pdf / 纯文本 4 条成功 + 空文件 1 条 failed（保留失败记录便于排查）
const listRes = await call('GET', '/api/documents?limit=50', {}, tokenA);
const items = listRes.body?.data?.items ?? [];
const failedCount = items.filter((d) => d.status === 'failed').length;
check(
  '文档列表只含 A 自己的 5 条（含 1 条 failed）',
  listRes.status === 200 && items.length === 5 && failedCount === 1,
  `count=${items.length} failed=${failedCount}`,
);

const detailRes = await call('GET', `/api/documents/${mdDoc?.id}`, {}, tokenA);
check('文档详情可读', detailRes.status === 200 && detailRes.body?.data?.item?.id === mdDoc?.id);

// ---------- 9. 下载 ----------
const dlRes = await app.inject({
  method: 'GET',
  url: `/api/documents/${mdDoc?.id}/download`,
  headers: { authorization: `Bearer ${tokenA}` },
});
check(
  '下载原始文件成功',
  dlRes.statusCode === 200 && dlRes.payload.length > 0,
  `status=${dlRes.statusCode} bytes=${dlRes.payload.length}`,
);

// ---------- 10. 越权隔离 ----------
const crossGet = await call('GET', `/api/documents/${mdDoc?.id}`, {}, tokenB);
check('B 读取 A 的文档返回 404', crossGet.status === 404, `status=${crossGet.status}`);

const crossChunks = await call('GET', `/api/documents/${mdDoc?.id}/chunks`, {}, tokenB);
check('B 读取 A 的片段返回 404', crossChunks.status === 404, `status=${crossChunks.status}`);

const crossDelete = await call('DELETE', `/api/documents/${mdDoc?.id}`, {}, tokenB);
check('B 删除 A 的文档返回 404', crossDelete.status === 404, `status=${crossDelete.status}`);

const crossDownload = await app.inject({
  method: 'GET',
  url: `/api/documents/${mdDoc?.id}/download`,
  headers: { authorization: `Bearer ${tokenB}` },
});
check('B 下载 A 的文件返回 404', crossDownload.statusCode === 404, `status=${crossDownload.statusCode}`);

const listB = await call('GET', '/api/documents', {}, tokenB);
check('B 的文档列表为空', (listB.body?.data?.items ?? []).length === 0, `count=${(listB.body?.data?.items ?? []).length}`);

// ---------- 11. 错误 id ----------
const badId = await call('GET', '/api/documents/abc', {}, tokenA);
check('非法 id 返回 400', badId.status === 400, `status=${badId.status}`);

// ---------- 12. 删除级联 ----------
const delRes = await call('DELETE', `/api/documents/${txtDoc?.id}`, {}, tokenA);
check('删除文档成功', delRes.status === 200, `status=${delRes.status}`);

const afterDel = await call('GET', `/api/documents/${txtDoc?.id}`, {}, tokenA);
check('删除后详情返回 404', afterDel.status === 404, `status=${afterDel.status}`);

const orphan = db.driver.all('SELECT id FROM chunks WHERE doc_id = ?', [Number(txtDoc?.id ?? 0)]);
check('删除后片段已级联清空', orphan.length === 0, `left=${orphan.length}`);

const ftsOrphan = Number(
  db.driver.get('SELECT COUNT(*) AS c FROM chunks c JOIN chunks_fts f ON f.rowid = c.id WHERE c.doc_id = ?', [
    Number(txtDoc?.id ?? 0),
  ])?.c ?? 0,
);
check('删除后 FTS 索引已同步清理', ftsOrphan === 0, `left=${ftsOrphan}`);

// ---------- 13. meta ----------
const meta = await call('GET', '/api/meta');
check('meta 报告 embeddingMode', meta.status === 200 && typeof meta.body?.data?.embeddingMode === 'string', `mode=${meta.body?.data?.embeddingMode}`);

await app.close();
closeDatabase();

console.log(`\n=== ingest check: ${pass} passed, ${fail} failed ===`);
console.log(`临时数据目录：${TMP}`);
process.exitCode = fail === 0 ? 0 : 1;
