import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { DbHandle } from '../db/connection.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import { claimJob, failJob, finishJob, renewJobLease } from '../repo/background-job.repo.js';
import { activateGeneration, beginGeneration, failGeneration } from '../repo/index-version.repo.js';
import { listReadyDocuments } from '../repo/document.repo.js';
import { reindexAll } from './ingest.service.js';
import type { RagProviderResolver } from './rag-model.service.js';
import { getRagSettings } from './rag.service.js';

export function startBackgroundWorker(input: { db: DbHandle; config: AppConfig; embedding: EmbeddingProvider; ragModels: RagProviderResolver; logger: Logger }) {
  const workerId = `worker-${randomUUID()}`;
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    const job = claimJob(input.db, workerId);
    if (!job) return;
    running = true;
    const heartbeat = setInterval(() => { renewJobLease(input.db, job.id, workerId); }, 30_000);
    heartbeat.unref?.();
    try {
      if (job.kind !== 'reindex') throw new Error(`不支持的任务类型：${job.kind}`);
      const payload = JSON.parse(job.payload_json) as { userId: number | null; libraryId?: number | null };
      const scope = { libraryId: payload.libraryId ?? null };
      const embedding = payload.userId === null ? input.embedding : input.ragModels.embeddingFor(payload.userId, input.embedding);
      const chunk = payload.userId === null
        ? undefined
        : getRagSettings({ db: input.db, config: input.config }, payload.userId).chunk;
      const generationId = beginGeneration(input.db, input.config, embedding, payload.userId, scope, chunk);
      try {
        const docs = listReadyDocuments(input.db, payload.userId, payload.libraryId ?? null);
        const result = await reindexAll({ db: input.db, config: input.config, embedding, chunk, logger: { info: (m) => input.logger.info(m), warn: (m) => input.logger.warn(m), error: (m) => input.logger.error(m), debug: (m) => input.logger.debug(m) } }, payload);
        const failedIds = new Set(result.failed.map((item) => item.docId));
        activateGeneration(input.db, generationId, payload.userId, scope, docs.filter((doc) => !failedIds.has(doc.id)).map((doc) => doc.id), result);
        finishJob(input.db, job.id, { ...result, generationId });
      } catch (error) {
        failGeneration(input.db, generationId, error instanceof Error ? error.message : String(error));
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.logger.error({ jobId: job.id, err: error }, 'background job failed');
      failJob(input.db, job, message);
    } finally { clearInterval(heartbeat); running = false; }
  };
  const timer = setInterval(() => void tick(), 1500);
  timer.unref?.();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
