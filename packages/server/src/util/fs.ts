/**
 * 文件系统安全工具：所有涉及用户输入的路径都必须经过这里，
 * 防止路径穿越（../）与绝对路径逃逸。
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * 剔除控制字符。
 * 这里按码点过滤而不是写正则字符类，避免源码里出现裸控制字符。
 */
function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

/**
 * 把用户提供的相对片段安全地拼到 baseDir 下。
 * @throws 当解析后的路径不在 baseDir 之内
 */
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (rel === '' || rel === '.') return base;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`非法的路径：${segments.join('/')}（超出允许的根目录）`);
  }
  return target;
}

/** 确保目录存在（递归创建） */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 用户上传目录：uploads/<userId>/<docId>
 * docId 省略时只到用户级目录。
 */
export function userUploadDir(dataDir: string, userId: number, docId?: number): string {
  const base = path.join(dataDir, 'uploads', String(userId));
  if (docId === undefined) return base;
  return safeJoin(base, String(docId));
}

/**
 * 清洗上传文件名：去掉目录分隔符与控制字符，限制长度。
 * 只取 basename，杜绝 a/../../b 这类输入。
 */
export function sanitizeFileName(name: string, fallback = 'unnamed'): string {
  const base = path.basename(String(name || ''));
  const cleaned = stripControlChars(base).replace(/[/\\]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned.slice(0, 180);
}
