#!/usr/bin/env node
/**
 * 一键初始化（幂等，可重复执行）：
 *   1. 创建 data/ 目录结构
 *   2. 获取/复用 sqlite-vec 扩展
 *   3. 生成 .env（若不存在）
 *   4. 执行数据库迁移（优先用 tsx 跑 TS 迁移器；tsx 不可用时退化为内置执行器）
 *
 * 用法：node scripts/setup.mjs
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'packages', 'server', 'src', 'db', 'migrations');
const MIGRATE_CLI = path.join(ROOT, 'packages', 'server', 'src', 'cli', 'migrate.ts');

const DIRS = ['data', 'data/lib', 'data/uploads', 'data/models', 'data/tmp', 'logs'];

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

/** 解析 .env 文本（去掉行尾注释） */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(' #');
    if (hash > 0) value = value.slice(0, hash).trim();
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** 确保 .env 存在（不存在则基于 .env.example 生成，JWT_SECRET 随机） */
function ensureEnv() {
  const envPath = path.join(ROOT, '.env');
  if (existsSync(envPath)) {
    log('env', '.env 已存在，保持不变');
    return parseEnv(readFileSync(envPath, 'utf8'));
  }
  const examplePath = path.join(ROOT, '.env.example');
  let content = existsSync(examplePath)
    ? readFileSync(examplePath, 'utf8')
    : 'JWT_SECRET=change-me\n';
  const secret = randomBytes(48).toString('base64url');
  content = content.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
  writeFileSync(envPath, content, 'utf8');
  log('env', '已生成 .env（JWT_SECRET 为随机值）');
  return parseEnv(content);
}

function ensureDirs() {
  for (const rel of DIRS) {
    const dir = path.join(ROOT, rel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const gitkeep = path.join(ROOT, 'data', '.gitkeep');
  if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf8');
  log('dirs', `就绪：${DIRS.join(', ')}`);
}

function ensureVecExt() {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'download-sqlite-vec.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    log('vec', 'sqlite-vec 获取脚本返回非 0（不影响启动，将降级为关键词检索）');
  }
}

function tsxAvailable() {
  return existsSync(path.join(ROOT, 'node_modules', 'tsx', 'package.json'));
}

/** 处理迁移 SQL 里的占位符与 vec 条件段（标记必须独占一行） */
function prepareSql(sql, dim, vecOk) {
  const start = /^[ \t]*--[ \t]*>>>VEC_ONLY[ \t]*$/gm;
  const end = /^[ \t]*--[ \t]*<<<VEC_ONLY[ \t]*$/gm;
  const stripped = vecOk
    ? sql.replace(start, '').replace(end, '')
    : sql.replace(/^[ \t]*--[ \t]*>>>VEC_ONLY[ \t]*$[\s\S]*?^[ \t]*--[ \t]*<<<VEC_ONLY[ \t]*$/gm, '');
  return stripped.replace(/\{\{EMBEDDING_DIM\}\}/g, String(dim));
}

/** 内置极简迁移执行器（迁移 SQL 全部幂等，顺序执行即可） */
async function fallbackMigrate(env) {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = path.resolve(ROOT, env.DB_PATH || path.join(env.DATA_DIR || 'data', 'kb.db'));
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const extName =
    process.platform === 'win32' ? 'vec0.dll' : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so';
  const vecPath = env.SQLITE_VEC_PATH
    ? path.resolve(ROOT, env.SQLITE_VEC_PATH)
    : path.join(ROOT, 'data', 'lib', extName);

  let vecOk = false;
  if (existsSync(vecPath)) {
    try {
      db.loadExtension(vecPath);
      vecOk = true;
    } catch (err) {
      log('migrate', `装载向量扩展失败：${err.message}`);
    }
  }

  const dim = Number(env.EMBEDDING_DIM || 512);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(prepareSql(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'), dim, vecOk));
    log('migrate', `已应用 ${file}（vec=${vecOk ? 'on' : 'off'}, dim=${dim}）`);
  }
  db.close();
}

/** 执行迁移：优先 TS 迁移器（带 user_version 版本控制） */
async function runMigrations(env) {
  if (existsSync(MIGRATE_CLI) && tsxAvailable()) {
    const res = spawnSync(process.execPath, ['--import', 'tsx', MIGRATE_CLI], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (res.status === 0) return;
    log('migrate', 'TS 迁移器执行失败，退化为内置执行器');
  }
  await fallbackMigrate(env);
}

async function main() {
  console.log('=== kb-app setup ===');
  ensureDirs();
  ensureVecExt();
  const env = ensureEnv();
  await runMigrations(env);
  console.log('\n=== setup 完成 ===');
  console.log('下一步：');
  console.log('  npm install                   # 若尚未安装依赖');
  console.log('  npm run dev                   # 启动后端(8787) + 前端(5173)');
  console.log('  npm run create-admin          # 创建/重置管理员');
  console.log('  node scripts/smoke.mjs        # 注册-登录-隔离 冒烟测试');
}

await main();
