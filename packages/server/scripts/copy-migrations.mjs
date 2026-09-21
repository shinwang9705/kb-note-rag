/**
 * 把迁移 SQL 复制到编译产物目录（tsc 不会复制非 TS 资源）。
 * 用法：node packages/server/scripts/copy-migrations.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(PKG, 'src', 'db', 'migrations');
const dest = path.join(PKG, 'dist', 'db', 'migrations');

if (!existsSync(src)) {
  console.error(`未找到迁移目录：${src}`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
// 迁移均为单层 SQL 文件；逐文件复制避免 Windows 原生递归 cp 的兼容性问题。
for (const name of readdirSync(src)) {
  if (name.endsWith('.sql')) copyFileSync(path.join(src, name), path.join(dest, name));
}
console.log(`migrations copied -> ${path.relative(PKG, dest)}`);
