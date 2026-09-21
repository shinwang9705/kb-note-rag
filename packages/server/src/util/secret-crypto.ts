/**
 * 服务端密钥加密（provider 凭据 API Key 落库用）。
 *
 * 形态差异豁免（ADR-16）：B/S 无 Electron safeStorage / DPAPI，这里降级为
 * AES-256-GCM + scrypt 密钥派生（node:crypto，零新增依赖）。
 * **安全等级 = 混淆级**：主密钥 SECRETS_KEY 存在服务端环境，能读到进程内存/环境变量的人仍可解出。
 * UI 必须如实告知，密钥永不进日志、不进导出。
 *
 * 密文格式：v1:base64(iv):base64(tag):base64(cipher)
 *   - iv 12 字节、tag 16 字节、key 32 字节
 *   - 密钥派生：scryptSync(SECRETS_KEY, 固定盐, 32)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DERIVE_SALT = 'kb-app.secret-crypto.v1';

/** 由主密钥派生 AES 密钥（盐无需保密，保密性来自 SECRETS_KEY） */
function deriveKey(secret: string): Buffer {
  if (!secret) throw new Error('缺少密钥主密钥（SECRETS_KEY）');
  return scryptSync(secret, DERIVE_SALT, KEY_BYTES);
}

/** 加密明文为 v1 格式密文 */
export function encryptSecret(plaintext: string, secret: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('待加密内容不能为空');
  }
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** 解密 v1 格式密文；格式非法或 MAC 校验失败时抛错 */
export function decryptSecret(ciphertext: string, secret: string): string {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new Error('密文不能为空');
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('密文格式不合法（期望 v1:iv:tag:cipher）');
  }
  const iv = Buffer.from(parts[1] as string, 'base64');
  const tag = Buffer.from(parts[2] as string, 'base64');
  const data = Buffer.from(parts[3] as string, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('密文头不合法（iv/tag 长度不符）');
  }

  const key = deriveKey(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
