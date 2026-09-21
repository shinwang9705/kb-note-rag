/**
 * 密码哈希与 JWT 工具（全部基于 node:crypto，无需 native 编译）。
 *
 * 密码：scrypt，N=16384, r=8, p=1，每用户 16 字节随机 salt，输出 64 字节。
 *      存储格式：scrypt$N$r$p$saltB64$hashB64
 * Token：自签 JWT，HS256（HMAC-SHA256），payload 含 sub/username/role/jti/iat/exp。
 */
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
/** scrypt 需要 maxmem > 128 * N * r = 16MB，给 64MB 留余量 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * scrypt 异步封装。
 * 不直接用 promisify：node:crypto 的多重载会让 promisify 只挑出 3 参版本，
 * 导致 options（N/r/p）无法传入。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export interface JwtPayload {
  /** 用户 id */
  sub: string;
  username: string;
  role: string;
  /** token 唯一 id，用于登出黑名单 */
  jti: string;
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
  [key: string]: unknown;
}

/** base64url 编码 */
function b64url(input: Buffer | string): string {
  return Buffer.isBuffer(input) ? input.toString('base64url') : Buffer.from(input, 'utf8').toString('base64url');
}

/** base64url 解码为 Buffer */
function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/** 生成随机 id（默认带前缀） */
export function randomId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${id}` : id;
}

/** 生成知识库只读分享 token：randomBytes(24) -> base64url（192bit，URL-safe） */
export function genShareToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 生成 scrypt 密码哈希 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('密码不能为空');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** 校验密码（格式错误或哈希算法不匹配时返回 false，不抛错） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt = Buffer.from(String(parts[4]), 'base64');
    const expected = Buffer.from(String(parts[5]), 'base64');
    const actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2),
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 签名 JWT（HS256） */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'> & Partial<Pick<JwtPayload, 'jti'>>,
  secret: string,
  expiresInSec: number,
): { token: string; jti: string; expiresAt: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(1, Math.trunc(expiresInSec));
  const jti = payload.jti ?? randomId('jti');
  const body: JwtPayload = { ...payload, jti, iat, exp } as JwtPayload;

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const signingInput = `${header}.${claims}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, jti, expiresAt: exp };
}

/** 校验 JWT，失败返回 null */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, claims, signature] = parts as [string, string, string];

  try {
    const expected = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
    const given = Buffer.from(signature, 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

    const decoded = JSON.parse(b64urlDecode(claims).toString('utf8')) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (typeof decoded.exp !== 'number' || decoded.exp <= now) return null;
    if (typeof decoded.iat === 'number' && decoded.iat > now + 60) return null;
    if (!decoded.sub) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 从 Authorization 头提取 Bearer token */
export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}
