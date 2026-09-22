import { createHash } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import type { RagChunkSettings } from '@kb/shared';

function effectiveChunk(config: AppConfig, chunk?: RagChunkSettings) {
  return chunk ?? { strategy: 'structured' as const, size: config.chunk.size, overlap: config.chunk.overlap, breakMode: 'sentence' as const, preserveSectionPath: true };
}

export function indexFingerprint(config: AppConfig, embedding: EmbeddingProvider, chunk?: RagChunkSettings): string {
  const rules = effectiveChunk(config, chunk);
  const identity = JSON.stringify({ parser: `${rules.strategy}-v2`, chunkSize: rules.size, chunkOverlap: rules.overlap, breakMode: rules.breakMode, preserveSectionPath: rules.preserveSectionPath, provider: embedding.kind, model: embedding.model, dim: embedding.dim });
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function ensureProfile(db: DbHandle, config: AppConfig, embedding: EmbeddingProvider, chunk?: RagChunkSettings): number {
  const rules = effectiveChunk(config, chunk);
  const fingerprint = indexFingerprint(config, embedding, rules);
  const found = db.driver.get<{ id: number }>('SELECT id FROM index_profiles WHERE fingerprint=?', [fingerprint]);
  if (found) return found.id;
  return db.driver.run('INSERT INTO index_profiles (fingerprint, parser_version, chunk_size, chunk_overlap, embedding_provider, embedding_model, embedding_dim) VALUES (?, ?, ?, ?, ?, ?, ?)', [fingerprint, `${rules.strategy}-v2:${rules.breakMode}:${rules.preserveSectionPath ? 'path' : 'flat'}`, rules.size, rules.overlap, embedding.kind, embedding.model, embedding.dim]).lastInsertRowid;
}

export function beginGeneration(db: DbHandle, config: AppConfig, embedding: EmbeddingProvider, userId: number | null, scope: unknown, chunk?: RagChunkSettings): number {
  const profileId = ensureProfile(db, config, embedding, chunk);
  return db.driver.run("INSERT INTO index_generations (user_id, profile_id, status, scope_json) VALUES (?, ?, 'building', ?)", [userId, profileId, JSON.stringify(scope ?? {})]).lastInsertRowid;
}

export function activateGeneration(db: DbHandle, generationId: number, userId: number | null, scope: unknown, docIds: number[], stats: unknown): void {
  const scopeJson = JSON.stringify(scope ?? {});
  db.driver.transaction(() => {
    db.driver.run("UPDATE index_generations SET status='superseded' WHERE user_id IS ? AND status='active' AND scope_json=?", [userId, scopeJson]);
    db.driver.run("UPDATE index_generations SET status='active', stats_json=?, activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", [JSON.stringify(stats ?? {}), generationId]);
    if (userId !== null) for (const docId of docIds) db.driver.run("INSERT INTO document_index_state (doc_id,user_id,generation_id,status) VALUES (?, ?, ?, 'current') ON CONFLICT(doc_id) DO UPDATE SET generation_id=excluded.generation_id,status='current',indexed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error_message=NULL", [docId, userId, generationId]);
  });
}

export function failGeneration(db: DbHandle, generationId: number, message: string): void {
  db.driver.run("UPDATE index_generations SET status='failed', error_message=? WHERE id=?", [message, generationId]);
}

export function indexStatus(db: DbHandle, config: AppConfig, embedding: EmbeddingProvider, userId: number, chunk?: RagChunkSettings) {
  const fingerprint = indexFingerprint(config, embedding, chunk);
  const latest = db.driver.get<{ id: number; status: string; fingerprint: string; created_at: string; activated_at: string | null; stats_json: string }>(`SELECT g.id,g.status,p.fingerprint,g.created_at,g.activated_at,g.stats_json FROM index_generations g JOIN index_profiles p ON p.id=g.profile_id WHERE g.user_id=? ORDER BY g.created_at DESC LIMIT 1`, [userId]);
  const tracked = Number(db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM document_index_state WHERE user_id=? AND status=\'current\'', [userId])?.c ?? 0);
  const ready = Number(db.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE user_id=? AND status=\'ready\'', [userId])?.c ?? 0);
  return { fingerprint, generation: latest ? { ...latest, stats: JSON.parse(latest.stats_json || '{}'), stats_json: undefined } : null, readyDocuments: ready, trackedDocuments: tracked, stale: Boolean(latest && latest.fingerprint !== fingerprint) || tracked < ready };
}
