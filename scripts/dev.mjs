#!/usr/bin/env node
/**
 * 并发启动后端（Fastify，8787）与前端（Vite，5173）开发服务器。
 * 不引入 concurrently / npm-run-all，直接用 child_process 跨平台 spawn。
 *
 * 用法：npm run dev
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
// Windows 下 npm 是 .cmd/.bat，必须经 shell 执行
const SPAWN_OPTS = { cwd: ROOT, shell: IS_WIN };

const RESET = '\x1b[0m';
const targets = [
  { name: 'server', args: ['run', 'dev', '-w', '@kb/server'], color: '\x1b[36m' },
  { name: 'web', args: ['run', 'dev', '-w', '@kb/web'], color: '\x1b[35m' },
];

/** 把子进程输出加前缀后转发 */
function pipe(child, name, color) {
  const prefix = `${color}[${name}]${RESET} `;
  const forward = (stream, target) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
    stream.on('end', () => {
      if (buf) target.write(prefix + buf + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

// tsx 是 dev 的前置依赖
try {
  createRequire(path.join(ROOT, 'package.json')).resolve('tsx');
} catch {
  console.error('未找到 tsx，请先执行：npm install');
  process.exit(1);
}

// server / web 运行时都依赖 @kb/shared 的构建产物，dev 前先构建一次
const buildShared = spawnSync(NPM, ['run', 'build', '-w', '@kb/shared'], {
  ...SPAWN_OPTS,
  stdio: 'inherit',
});
if (buildShared.status !== 0) {
  console.error('构建 @kb/shared 失败，已中止');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

for (const t of targets) {
  const child = spawn(NPM, t.args, { ...SPAWN_OPTS, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(child, t.name, t.color);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${t.name} 进程退出（code=${code}），正在关闭其余进程…`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
