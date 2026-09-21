#!/usr/bin/env node
/**
 * 批量导入 samples 目录下的文档到知识库（幂等，可重复执行）。
 *
 * 用法（需后端已启动）：
 *   node scripts/import-samples.mjs [baseUrl] [--library <知识库名>] [--username <u>] [--password <p>] [--dir <目录>]
 *
 * 示例：
 *   node scripts/import-samples.mjs                                              # 默认库
 *   node scripts/import-samples.mjs http://127.0.0.1:8787 --library "智能制造"     # 导入到指定知识库（按名创建/查找）
 *   node scripts/import-samples.mjs --dir samples/smart-manufacturing             # 指定目录
 *
 * 行为：
 *   - 注册/登录账号（默认 demo / DemoPass1234，可 --username/--password 覆盖）
 *   - 若指定 --library，按名称查找或创建知识库，文档归属该库；否则导入默认库
 *   - 扫描目录下所有 .md 文件，通过 POST /api/documents/text 入库
 *   - 标题 = 文件名去掉前导「NNN-」序号与扩展名；幂等：已存在同标题则跳过
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 解析参数 ----------------
const args = process.argv.slice(2);
const BASE = args[0] && !args[0].startsWith('--') ? args[0] : 'http://127.0.0.1:8787';
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const USERNAME = opt('--username', 'demo');
const PASSWORD = opt('--password', 'DemoPass1234');
const LIBRARY_NAME = opt('--library', '');
const SAMPLES_DIR = path.resolve(ROOT, opt('--dir', 'samples/smart-manufacturing'));

// ---------------- HTTP 封装 ----------------
async function call(method, p, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function log(level, message) {
  console.log(`[import:${level}] ${message}`);
}

/** 标题清洗：去掉前导「NNN-」序号与扩展名 */
function titleOf(filename) {
  const base = path.basename(filename, path.extname(filename));
  return base.replace(/^\d{3}-/, '').trim();
}

async function main() {
  console.log(`=== 批量导入 samples ===`);
  console.log(`后端：${BASE}`);
  console.log(`目录：${SAMPLES_DIR}`);

  // 1) 健康检查
  try {
    const health = await call('GET', '/api/health');
    if (health.status !== 200 || health.json?.data?.status !== 'ok') {
      throw new Error(`后端未就绪：status=${health.status} body=${JSON.stringify(health.json)}`);
    }
    log('ok', '后端健康检查通过');
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // 2) 注册或登录账号
  let token = '';
  const reg = await call('POST', '/api/auth/register', { body: { username: USERNAME, password: PASSWORD } });
  if (reg.status === 200 && reg.json?.data?.token) {
    token = reg.json.data.token;
    log('ok', `账号已注册：${USERNAME}`);
  } else if (reg.status === 409) {
    const login = await call('POST', '/api/auth/login', { body: { username: USERNAME, password: PASSWORD } });
    if (login.status !== 200 || !login.json?.data?.token) {
      log('error', `账号登录失败：${JSON.stringify(login.json)}`);
      process.exit(1);
    }
    token = login.json.data.token;
    log('ok', `账号已存在，直接登录：${USERNAME}`);
  } else {
    log('error', `注册失败：status=${reg.status} body=${JSON.stringify(reg.json)}`);
    process.exit(1);
  }

  // 3) 解析目标知识库（可选）
  let libraryId = null;
  if (LIBRARY_NAME) {
    const libs = await call('GET', '/api/libraries', { token });
    const found = (libs.json?.data?.items ?? []).find((l) => l.name === LIBRARY_NAME);
    if (found) {
      libraryId = found.id;
      log('ok', `使用已有知识库「${LIBRARY_NAME}」(id=${libraryId})`);
    } else {
      const created = await call('POST', '/api/libraries', { body: { name: LIBRARY_NAME }, token });
      libraryId = created.json?.data?.item?.id ?? null;
      if (!libraryId) {
        log('error', `创建知识库「${LIBRARY_NAME}」失败：${JSON.stringify(created.json)}`);
        process.exit(1);
      }
      log('ok', `已创建知识库「${LIBRARY_NAME}」(id=${libraryId})`);
    }
  } else {
    log('ok', '未指定 --library，文档将导入默认库');
  }

  // 4) 扫描目录
  let files;
  try {
    files = readdirSync(SAMPLES_DIR).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (error) {
    log('error', `读取目录失败：${SAMPLES_DIR}（${error instanceof Error ? error.message : error}）`);
    process.exit(1);
  }
  if (files.length === 0) {
    log('warn', `目录下没有 .md 文件：${SAMPLES_DIR}`);
    return;
  }
  log('ok', `发现 ${files.length} 篇文档`);

  // 5) 读取已有文档标题（幂等去重）
  const existing = new Set();
  const list = await call('GET', '/api/documents?limit=500', { token });
  for (const doc of list.json?.data?.items ?? []) {
    existing.add(doc.title);
  }

  // 6) 逐篇入库
  let created = 0;
  let skipped = 0;
  let failed = 0;
  let i = 0;
  for (const file of files) {
    i += 1;
    const title = titleOf(file);
    if (existing.has(title)) {
      skipped += 1;
      log('skip', `[${i}/${files.length}]《${title}》已存在，跳过`);
      continue;
    }
    let content;
    try {
      content = readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
    } catch (error) {
      failed += 1;
      log('error', `[${i}/${files.length}]《${title}》读取失败：${error instanceof Error ? error.message : error}`);
      continue;
    }
    const res = await call('POST', '/api/documents/text', {
      body: { title, content, libraryId },
      token,
    });
    const item = res.json?.data?.item ?? null;
    if (res.status === 200 && item?.status === 'ready') {
      created += 1;
      log('ok', `[${i}/${files.length}]《${title}》已入库（chunks=${item.chunkCount}）`);
    } else if (res.status === 409) {
      // 配额/冲突类错误，如实报告
      failed += 1;
      log('warn', `[${i}/${files.length}]《${title}》入库被拒：${res.json?.message ?? JSON.stringify(res.json)}`);
    } else {
      failed += 1;
      log('warn', `[${i}/${files.length}]《${title}》入库异常：status=${res.status} body=${JSON.stringify(res.json)}`);
    }
  }

  console.log(`\n=== 批量导入完成：新建 ${created} 篇，跳过 ${skipped} 篇，失败 ${failed} 篇 ===`);
  console.log(`可用账号 ${USERNAME} / ${PASSWORD} 登录，在检索/问答页验证效果。`);
  if (LIBRARY_NAME) console.log(`文档已归入知识库「${LIBRARY_NAME}」。`);
}

main().catch((error) => {
  console.error('[import-samples] 执行失败：', error);
  process.exit(1);
});
