/**
 * 供应商凭据数据访问层（三期 T04）。
 *
 * 密文由 service 层用 util/secret-crypto 的 encryptSecret 写入、decryptSecret 读取；
 * 本 repo 只做读写，强制 WHERE user_id = ?。
 */
import type { DbHandle } from '../db/connection.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export interface CredentialRow {
  id: number;
  user_id: number;
  provider_id: string;
  api_key_enc: string;
  base_url_override: string | null;
  enabled: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface Credential {
  id: number;
  providerId: string;
  apiKeyEnc: string;
  baseUrlOverride: string | null;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function toCredential(row: CredentialRow): Credential {
  return {
    id: Number(row.id),
    providerId: row.provider_id,
    apiKeyEnc: row.api_key_enc,
    baseUrlOverride: row.base_url_override ?? null,
    enabled: Number(row.enabled) === 1,
    isDefault: Number(row.is_default) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertCredentialInput {
  apiKeyEnc: string;
  baseUrlOverride?: string | null;
  enabled?: boolean;
  isDefault?: boolean;
}

/** 幂等写入（ON CONFLICT(user_id, provider_id) DO UPDATE） */
export function upsertCredential(
  db: DbHandle,
  userId: number,
  providerId: string,
  input: UpsertCredentialInput,
): Credential {
  db.driver.run(
    `INSERT INTO provider_credentials
       (user_id, provider_id, api_key_enc, base_url_override, enabled, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ${NOW}, ${NOW})
     ON CONFLICT(user_id, provider_id) DO UPDATE SET
       api_key_enc = excluded.api_key_enc,
       base_url_override = excluded.base_url_override,
       enabled = excluded.enabled,
       is_default = excluded.is_default,
       updated_at = excluded.updated_at`,
    [
      userId,
      providerId,
      input.apiKeyEnc,
      input.baseUrlOverride ?? null,
      input.enabled === false ? 0 : 1,
      input.isDefault ? 1 : 0,
    ],
  );
  return getCredential(db, userId, providerId) as Credential;
}

export function getCredential(db: DbHandle, userId: number, providerId: string): Credential | undefined {
  const row = db.driver.get<CredentialRow>(
    'SELECT * FROM provider_credentials WHERE user_id = ? AND provider_id = ?',
    [userId, providerId],
  );
  return row ? toCredential(row) : undefined;
}

export function listByUser(db: DbHandle, userId: number): Credential[] {
  const rows = db.driver.all<CredentialRow>(
    'SELECT * FROM provider_credentials WHERE user_id = ? ORDER BY is_default DESC, id ASC',
    [userId],
  );
  return rows.map(toCredential);
}

export function userHasAny(db: DbHandle, userId: number): boolean {
  const row = db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM provider_credentials WHERE user_id = ?', [userId]);
  return Number(row?.c ?? 0) > 0;
}

export function deleteCredential(db: DbHandle, userId: number, providerId: string): boolean {
  const result = db.driver.run('DELETE FROM provider_credentials WHERE user_id = ? AND provider_id = ?', [
    userId,
    providerId,
  ]);
  return result.changes > 0;
}

/** 清空其它 default 并把指定供应商设为默认 */
export function setDefault(db: DbHandle, userId: number, providerId: string): void {
  db.driver.run('UPDATE provider_credentials SET is_default = 0 WHERE user_id = ?', [userId]);
  db.driver.run('UPDATE provider_credentials SET is_default = 1 WHERE user_id = ? AND provider_id = ?', [
    userId,
    providerId,
  ]);
}
