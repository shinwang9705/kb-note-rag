#!/usr/bin/env node
/**
 * 按 platform/arch 获取 sqlite-vec v0.1.9 的 loadable extension。
 *
 * 优先级：
 *   1. 若 data/lib/vec0.* 已存在且非空 -> 跳过（幂等）
 *   2. 若 spike/ext/vec0.<ext> 存在且平台匹配 -> 直接拷贝（离线可用）
 *   3. 从 GitHub Release 下载 tar.gz 并解压
 *
 * 用法：node scripts/download-sqlite-vec.mjs [目标目录]
 */
import { existsSync, mkdirSync, copyFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.9';

/** 平台 -> sqlite-vec release 里的 arch 标识 */
function detectArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'win32') return { platform, arch: 'x86_64', ext: '.dll', triple: 'windows-x86_64' };
  if (platform === 'darwin') {
    return {
      platform,
      arch: arch === 'arm64' ? 'aarch64' : 'x86_64',
      ext: '.dylib',
      triple: arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64',
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      arch: arch === 'arm64' ? 'aarch64' : 'x86_64',
      ext: '.so',
      triple: arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64',
    };
  }
  throw new Error(`不支持的平台：${platform}/${arch}，请手动下载 sqlite-vec 并放置到 data/lib/`);
}

function targetDir() {
  const arg = process.argv[2];
  return path.resolve(ROOT, arg || 'data/lib');
}

function findExisting(dir, ext) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('vec0.') && statSync(path.join(dir, name)).size > 0) {
      return path.join(dir, name);
    }
  }
  return ext ? null : null;
}

async function download(outDir, info) {
  const url = `https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}/sqlite-vec-${VERSION}-loadable-${info.triple}.tar.gz`;
  const tmp = path.join(outDir, `sqlite-vec-${VERSION}.tar.gz`);
  console.log(`下载 sqlite-vec v${VERSION} (${info.triple})`);
  console.log(`  ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载内容异常（${buf.length} 字节）`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tmp, buf);
  try {
    execFileSync('tar', ['-xzf', tmp, '-C', outDir], { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`解压失败：${err.message}。请手动执行 tar -xzf ${tmp} -C ${outDir}`);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function main() {
  const info = detectArch();
  const outDir = targetDir();
  mkdirSync(outDir, { recursive: true });

  const existing = findExisting(outDir, info.ext);
  if (existing) {
    console.log(`sqlite-vec 已存在，跳过下载：${existing}（${(statSync(existing).size / 1024).toFixed(0)} KB）`);
    return existing;
  }

  // 复用 spike 里已验证的二进制（离线场景）
  const spikeCandidates = [
    path.join(ROOT, 'spike', 'ext', `vec0${info.ext}`),
    path.join(ROOT, 'spike', 'ext', 'vec0.dll'),
    path.join(ROOT, 'spike', 'ext', 'vec0.so'),
    path.join(ROOT, 'spike', 'ext', 'vec0.dylib'),
  ];
  for (const candidate of spikeCandidates) {
    if (existsSync(candidate) && statSync(candidate).size > 0 && path.extname(candidate) === info.ext) {
      const dest = path.join(outDir, `vec0${info.ext}`);
      copyFileSync(candidate, dest);
      console.log(`复用已有扩展：${path.relative(ROOT, candidate)} -> ${path.relative(ROOT, dest)}`);
      return dest;
    }
  }

  try {
    await download(outDir, info);
  } catch (err) {
    console.error(`\n[sqlite-vec] 自动获取失败：${err.message}`);
    console.error('请手动处理（二选一）：');
    console.error(`  1) 从 https://github.com/asg017/sqlite-vec/releases/tag/v${VERSION} 下载`);
    console.error(`     sqlite-vec-${VERSION}-loadable-${info.triple}.tar.gz，解压出 vec0${info.ext} 放到：`);
    console.error(`     ${path.join(outDir, `vec0${info.ext}`)}`);
    console.error('  2) 设置环境变量 SQLITE_VEC_PATH 指向已有的扩展文件。');
    console.error('\n未获取到向量扩展不影响启动：系统会自动降级为「仅关键词检索」模式。\n');
    return null;
  }

  const final = findExisting(outDir, info.ext);
  if (!final) {
    console.error('[sqlite-vec] 解压后未找到 vec0 扩展，将降级为关键词检索模式。');
    return null;
  }
  console.log(`sqlite-vec 就绪：${final}`);
  return final;
}

main().then(
  (p) => process.exit(p ? 0 : 0),
  (err) => {
    console.error(err);
    process.exit(0); // 扩展缺失不应中断 setup
  },
);
