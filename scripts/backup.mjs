#!/usr/bin/env node
/** 一致数据库快照 + 快照引用的原文 + SHA-256 清单；不复制 .env 或模型缓存。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(name + ' 缺少路径');
  return argv[i + 1];
}
function within(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error('清单含非法路径');
  const result = path.resolve(root, relative);
  const rel = path.relative(root, result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径超出备份范围');
  return result;
}
function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

export function verifyBackup(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.some(f => f.path === 'kb.db')) throw new Error('备份清单无效');
  for (const file of manifest.files) {
    if (digest(within(root, file.path)) !== file.sha256) throw new Error('文件校验失败：' + file.path);
  }
  return manifest.files.length;
}

export async function createBackup({ dbPath, dataDir, outputDir }) {
  if (typeof sqlite.backup !== 'function') throw new Error('需要支持 node:sqlite.backup 的 Node.js 版本；禁止退化为不一致的在线文件复制');
  if (!existsSync(dbPath)) throw new Error('数据库不存在：' + dbPath);
  const name = 'kb-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const pending = path.join(outputDir, name + '.partial');
  const complete = path.join(outputDir, name);
  mkdirSync(pending, { recursive: true });
  const destination = path.join(pending, 'kb.db');
  const source = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try { await sqlite.backup(source, destination); } finally { source.close(); }
  const snapshot = new sqlite.DatabaseSync(destination, { readOnly: true });
  let documents;
  try { documents = snapshot.prepare('SELECT storage_path FROM documents WHERE storage_path IS NOT NULL').all(); }
  finally { snapshot.close(); }
  const files = [{ path: 'kb.db', sha256: digest(destination) }];
  const realDataDir = realpathSync(dataDir);
  for (const relative of new Set(documents.map(d => d.storage_path))) {
    if (!/^uploads[\\/]/.test(relative)) throw new Error('文档路径不在 uploads 中，备份中止');
    const sourceFile = within(dataDir, relative);
    within(realDataDir, path.relative(realDataDir, realpathSync(sourceFile)));
    const target = within(pending, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(sourceFile, target);
    files.push({ path: relative.split(path.sep).join('/'), sha256: digest(target) });
  }
  writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2));
  verifyBackup(pending);
  renameSync(pending, complete);
  return complete;
}

async function main() {
  const verify = arg('--verify', null);
  if (verify) { console.log('[backup] 校验通过：' + verifyBackup(verify) + ' 个文件'); return; }
  const envPath = path.join(ROOT, '.env');
  const env = { ...(existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}), ...process.env };
  const dataDir = path.resolve(ROOT, arg('--data-dir', env.DATA_DIR || 'data'));
  const dbPath = path.resolve(ROOT, arg('--db', env.DB_PATH || path.join(dataDir, 'kb.db')));
  const outputDir = path.resolve(ROOT, arg('--out', path.join(dataDir, 'backups')));
  console.log('[backup] 完整备份已生成并校验：' + await createBackup({ dbPath, dataDir, outputDir }));
  console.log('[backup] 加密密钥不在备份中，请单独安全保管 SECRETS_KEY；恢复应先在新的空目录演练。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[backup] 备份/校验失败：' + error.message + '。未完成目录保留为 .partial，不可用于恢复；若源文件正被替换，请暂停写入后重试。');
    process.exitCode = 1;
  });
}
