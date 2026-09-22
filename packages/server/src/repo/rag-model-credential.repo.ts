import type { RagModelCapability } from '@kb/shared';
import type { DbHandle } from '../db/connection.js';

export interface RagModelCredentialRow { id: number; user_id: number; capability: RagModelCapability; api_key_enc: string; api_base: string; model: string; enabled: number; timeout_ms: number; dim: number | null; batch_size: number | null; created_at: string; updated_at: string }

export function getRagModelCredential(db: DbHandle, userId: number, capability: RagModelCapability): RagModelCredentialRow | undefined {
  return db.driver.get<RagModelCredentialRow>('SELECT * FROM rag_model_credentials WHERE user_id=? AND capability=?', [userId, capability]);
}

export function upsertRagModelCredential(db: DbHandle, input: { userId: number; capability: RagModelCapability; apiKeyEnc: string; apiBase: string; model: string; enabled: boolean; timeoutMs: number; dim?: number | null; batchSize?: number | null }): void {
  db.driver.run(`INSERT INTO rag_model_credentials (user_id,capability,api_key_enc,api_base,model,enabled,timeout_ms,dim,batch_size) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,capability) DO UPDATE SET api_key_enc=excluded.api_key_enc,api_base=excluded.api_base,model=excluded.model,enabled=excluded.enabled,timeout_ms=excluded.timeout_ms,dim=excluded.dim,batch_size=excluded.batch_size,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`, [input.userId, input.capability, input.apiKeyEnc, input.apiBase, input.model, input.enabled ? 1 : 0, input.timeoutMs, input.dim ?? null, input.batchSize ?? null]);
}

export function deleteRagModelCredential(db: DbHandle, userId: number, capability: RagModelCapability): boolean {
  return db.driver.run('DELETE FROM rag_model_credentials WHERE user_id=? AND capability=?', [userId, capability]).changes > 0;
}
