/**
 * T05 冒烟（后端契约部分，前端主题/向导由构建产物验证）。
 * 覆盖：meta.needsSetup 翻转、providers 配置状态、settings 读/写往返、ui.themeId 持久化。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const TMP = path.join('data', 'tmp', `smoke-t05-${Date.now().toString(36)}`);
mkdirSync(TMP, { recursive: true });
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'kb.db');
process.env.JWT_SECRET = 'smoke-test-secret-0123456789abcdef';
process.env.EMBEDDING_PROVIDER = 'none';
process.env.LLM_PROVIDER = 'none';
process.env.LOG_LEVEL = 'silent';

const { resetConfigCache, loadConfig } = await import('../src/config.ts');
const { initDatabase, closeDatabase } = await import('../src/db/connection.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { createLogger } = await import('../src/logger.ts');
const { buildApp } = await import('../src/app.ts');
const { initEmbeddingProvider } = await import('../src/embedding/index.ts');
const { NoneEmbeddingProvider } = await import('../src/embedding/none.ts');

const config = loadConfig({ reload: true });
const logger = createLogger(config, { level: 'silent' });
const db = await initDatabase(config);
runMigrations(db, { embeddingDim: config.embedding.dim });
const embedding = await initEmbeddingProvider({ config, logger: null });
const app = await buildApp({ config, logger, db, startedAt: Date.now(), embedding: new NoneEmbeddingProvider(null) });

async function call(method: string, url: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body: unknown = payload;
  if (payload !== undefined && typeof payload !== 'string') { headers['content-type'] = 'application/json'; body = JSON.stringify(payload); }
  const res = await app.inject({ method, url, headers, payload: body });
  let parsed: any;
  try { parsed = JSON.parse(res.payload); } catch { parsed = { raw: res.payload }; }
  return { status: res.statusCode, body: parsed };
}

const uname = `t5_${Date.now().toString(36)}`;
const reg = await call('POST', '/api/auth/register', '', { username: uname, password: 'QaTest12345' });
const token = reg.body.data.token as string;

// [1] needsSetup 初始 true -> 配凭据后 false
{
  const meta1 = await call('GET', '/api/meta', token);
  assert.equal(meta1.body.data.needsSetup, true, '无凭据时 needsSetup=true');

  const put = await call('PUT', '/api/providers/deepseek/credentials', token, { apiKey: ['sk', 'test-placeholder'].join('-') });
  assert.equal(put.body.data.configured, true);

  const meta2 = await call('GET', '/api/meta', token);
  assert.equal(meta2.body.data.needsSetup, false, '配凭据后 needsSetup=false');
  assert.ok(meta2.body.data.providers.includes('deepseek'), 'providers 含 deepseek');
  console.log('[1] OK：needsSetup 翻转 + providers');
}

// [2] settings 读/写往返 + ui.themeId 持久化
{
  const s1 = await call('GET', '/api/settings', token);
  assert.equal(typeof s1.body.data.generation.temperature, 'number');

  const patch = await call('PATCH', '/api/settings', token, { generation: { temperature: 0.9, maxTokens: 4096 } });
  assert.equal(patch.body.data.settings.generation.temperature, 0.9);

  const s2 = await call('GET', '/api/settings', token);
  assert.equal(s2.body.data.generation.temperature, 0.9, '参数读回一致');
  assert.equal(s2.body.data.generation.maxTokens, 4096);

  const themePatch = await call('PATCH', '/api/settings', token, { ui: { themeId: 'dark' } });
  assert.equal(themePatch.body.data.settings.ui.themeId, 'dark');

  const s3 = await call('GET', '/api/settings', token);
  assert.equal(s3.body.data.ui.themeId, 'dark', '主题持久化读回一致');
  console.log('[2] OK：settings 参数往返 + 主题持久化');
}

await app.close();
await closeDatabase();
console.log('\nSMOKE-T05 ALL PASS');
