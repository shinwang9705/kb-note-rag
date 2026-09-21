/**
 * 环境变量解析 + 校验 + fail-fast。
 * 任何缺失的必填项或非法值都会在进程启动早期抛出，避免运行时出现半初始化状态。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GENERATION_PARAMS,
  DEFAULT_RERANK_API_BASE,
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_PROVIDER,
  DEFAULT_RERANK_RETURN_DOCUMENTS,
  DEFAULT_RERANK_TIMEOUT_MS,
  DEFAULT_RERANK_TOPK,
  DEFAULT_RERANK_TOPN,
  DEFAULT_SHARE_BASE_URL,
  DEFAULT_THINKING_BUDGET,
} from '@kb/shared';

export type AppEnv = 'development' | 'production' | 'test';
export type EmbeddingProviderKind = 'local' | 'api' | 'none';
export type RerankProviderKind = 'api' | 'none';
export type LlmProviderKind = 'none' | 'deepseek';
export type SqliteDriverKind = 'node' | 'better' | 'auto';

export interface ServerConfig {
  trustProxy?: boolean;
  host: string;
  port: number;
  publicOrigin: string;
}

export interface DbConfig {
  dataDir: string;
  path: string;
  driver: SqliteDriverKind;
  vecPath: string;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  jwtExpiresInSec: number;
  allowRegister: boolean;
  /** 连续登录失败多少次后锁定（ACC-06） */
  loginMaxAttempts: number;
  /** 锁定时长（分钟） */
  loginLockMinutes: number;
}

export interface BootstrapConfig {
  adminUser: string;
  adminPass: string;
}

export interface QuotaConfig {
  maxDocumentsPerUser: number;
  maxUploadMb: number;
  maxFilesPerUpload: number;
  /** 单用户总存储字节上限（DOC-06） */
  maxTotalBytes: number;
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  model: string;
  dim: number;
  cacheDir: string;
  hfEndpoint: string;
  apiBase: string;
  apiKey: string;
  apiModel: string;
  timeoutMs: number;
  batchSize: number;
}

export interface SearchConfig {
  topK: number;
  finalK: number;
}

export interface RerankConfig {
  provider: RerankProviderKind;
  apiBase: string;
  apiKey: string;
  model: string;
  topN: number;
  topK: number;
  timeoutMs: number;
  /** 是否让上游在结果里附带原文（return_documents），默认 false（本地已有原文） */
  returnDocuments: boolean;
}

export interface LlmConfig {
  provider: LlmProviderKind;
  apiBase: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  contextTopK: number;
}

/** 三期生成参数默认值（用户在参数面板可覆盖，持久化到 conversations.params_json） */
export interface GenerationConfig {
  temperature: number;
  topP: number;
  maxTokens: number;
  thinkingRounds: number;
}

/** 三期深度思考三维预算默认值 */
export interface ThinkingConfig {
  maxTotalInputTokens: number;
  maxWallClockMs: number;
  diffConvergeThreshold: number;
  maxConsecutiveFailures: number;
}

export interface ChunkConfig {
  size: number;
  overlap: number;
}

export interface LogConfig {
  level: string;
  file: string;
}

export interface AppConfig {
  env: AppEnv;
  appName: string;
  version: string;
  rootDir: string;
  isProduction: boolean;
  server: ServerConfig;
  db: DbConfig;
  auth: AuthConfig;
  bootstrap: BootstrapConfig;
  quota: QuotaConfig;
  embedding: EmbeddingConfig;
  search: SearchConfig;
  llm: LlmConfig;
  rerank: RerankConfig;
  generation: GenerationConfig;
  thinking: ThinkingConfig;
  /** 服务端密钥加密主密钥（provider 凭据 AES-256-GCM 用），缺省回退 jwtSecret */
  secretsKey: string;
  chunk: ChunkConfig;
  log: LogConfig;
  allowedOrigins: string[];
  providerAllowedOrigins?: string[];
  /** 共享链接基址（SHARE_BASE_URL，默认 Vite dev 地址） */
  shareBaseUrl: string;
}

/** 简易 .env 解析（不引入 dotenv 也能用，兼容 setup 脚本早期调用） */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // 去掉行尾注释（如 `PORT=8787  # 后端端口`），引号内的 # 不处理
      const hash = value.indexOf(' #');
      if (hash > 0) value = value.slice(0, hash).trim();
      else if (value.startsWith('#')) value = '';
    }
    out[key] = value;
  }
  return out;
}

/** 从起始目录向上查找 monorepo 根（含 workspaces 字段的 package.json） */
export function findRootDir(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          workspaces?: unknown;
          name?: string;
        };
        if (pkg.workspaces) return dir;
      } catch {
        /* 忽略解析错误，继续向上 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/** 加载 .env（root/.env 优先，其次 cwd/.env），不覆盖已有环境变量 */
export function loadEnvFile(rootDir: string): void {
  const candidates = [path.join(rootDir, '.env'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`环境变量 ${name} 不是合法数字：${value}`);
  }
  return Math.trunc(parsed);
}

function float(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`环境变量 ${name} 不是合法数字：${value}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = str(name, fallback) as T;
  if (!allowed.includes(value)) {
    throw new Error(`环境变量 ${name} 取值非法：${value}，可选值：${allowed.join(' | ')}`);
  }
  return value;
}

/** 解析 "7d" / "12h" / "30m" / "3600s" / "3600" 为秒 */
export function parseDurationToSeconds(input: string, fallbackSec: number): number {
  const text = String(input).trim();
  if (!text) return fallbackSec;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) return fallbackSec;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  return Math.max(1, Math.trunc(amount * (factor[unit] ?? 1)));
}

/** 相对路径按 rootDir 解析；支持 ~ 展开 */
function resolvePath(input: string, rootDir: string): string {
  if (input.startsWith('~')) return path.join(homedir(), input.slice(1));
  return path.resolve(rootDir, input);
}

function readVersion(rootDir: string): string {
  const pkgPath = path.join(rootDir, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function platformVecExt(rootDir: string): string {
  const base = path.join(rootDir, 'data', 'lib', 'vec0');
  if (process.platform === 'win32') return `${base}.dll`;
  if (process.platform === 'darwin') return `${base}.dylib`;
  return `${base}.so`;
}

let cachedConfig: AppConfig | null = null;

export interface LoadConfigOptions {
  /** 强制重新加载（默认缓存） */
  reload?: boolean;
  /** 覆盖 rootDir 查找起点 */
  cwd?: string;
}

/**
 * 读取并校验配置。
 * 生产环境缺少 JWT_SECRET 或仍为默认值时直接抛错（fail-fast）。
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (cachedConfig && !options.reload) return cachedConfig;

  const rootDir = findRootDir(options.cwd ?? process.cwd());
  loadEnvFile(rootDir);

  const env = oneOf<AppEnv>('NODE_ENV', ['development', 'production', 'test'], 'development');
  const isProduction = env === 'production';

  const jwtSecret = str('JWT_SECRET', isProduction ? '' : 'dev-only-change-me');
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      '缺少 JWT_SECRET（至少 16 字符）。请在 .env 中配置，例如：JWT_SECRET=' +
        '$(openssl rand -base64 48)',
    );
  }
  if (isProduction && (jwtSecret.length < 32 || ['dev-only-change-me', 'please-change-me-to-a-random-48-bytes'].includes(jwtSecret))) {
    throw new Error('生产环境必须配置至少 32 字符的随机 JWT_SECRET，不能使用示例值');
  }
  if (isProduction && ['admin12345', 'admin', 'password'].includes(str('BOOTSTRAP_ADMIN_PASS', ''))) throw new Error('生产环境不能使用示例管理员密码');
  if (isProduction && str('SECRETS_KEY', '').length < 32) throw new Error('生产环境必须显式配置至少 32 字符的 SECRETS_KEY；已有凭据应先保留原加密密钥再迁移');

  const dataDir = resolvePath(str('DATA_DIR', './data'), rootDir);
  const dbPath = resolvePath(str('DB_PATH', path.join(dataDir, 'kb.db')), rootDir);
  const vecPathRaw = str('SQLITE_VEC_PATH', '');
  const vecPath = vecPathRaw ? resolvePath(vecPathRaw, rootDir) : platformVecExt(rootDir);

  const jwtExpiresIn = str('JWT_EXPIRES_IN', '7d');

  const allowedOrigins = str('ALLOWED_ORIGINS', '*')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const config: AppConfig = {
    env,
    appName: str('APP_NAME', 'kb-note'),
    version: readVersion(rootDir),
    rootDir,
    isProduction,
    server: {
      trustProxy: bool('TRUST_PROXY', false),
      host: str('SERVER_HOST', '0.0.0.0'),
      port: int('SERVER_PORT', 8787),
      publicOrigin: str('PUBLIC_ORIGIN', 'http://localhost:8787'),
    },
    db: {
      dataDir,
      path: dbPath,
      driver: oneOf<SqliteDriverKind>('SQLITE_DRIVER', ['node', 'better', 'auto'], 'auto'),
      vecPath,
    },
    auth: {
      jwtSecret,
      jwtExpiresIn,
      jwtExpiresInSec: parseDurationToSeconds(jwtExpiresIn, 7 * 86400),
      allowRegister: bool('ALLOW_REGISTER', !isProduction),
      loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5),
      loginLockMinutes: int('LOGIN_LOCK_MINUTES', 10),
    },
    bootstrap: {
      adminUser: str('BOOTSTRAP_ADMIN_USER', 'admin'),
      adminPass: str('BOOTSTRAP_ADMIN_PASS', ''),
    },
    quota: {
      maxDocumentsPerUser: int('MAX_DOCUMENTS_PER_USER', 500),
      maxUploadMb: int('MAX_UPLOAD_MB', 20),
      maxFilesPerUpload: int('MAX_FILES_PER_UPLOAD', 10),
      maxTotalBytes: int('MAX_TOTAL_GB', 2) * 1024 * 1024 * 1024,
    },
    embedding: {
      provider: oneOf<EmbeddingProviderKind>('EMBEDDING_PROVIDER', ['local', 'api', 'none'], 'local'),
      model: str('EMBEDDING_MODEL', 'Xenova/bge-small-zh-v1.5'),
      dim: int('EMBEDDING_DIM', 512),
      cacheDir: resolvePath(str('EMBEDDING_CACHE_DIR', path.join(dataDir, 'models')), rootDir),
      hfEndpoint: str('HF_ENDPOINT', 'https://hf-mirror.com'),
      apiBase: str('EMBEDDING_API_BASE', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      apiKey: str('EMBEDDING_API_KEY', ''),
      apiModel: str('EMBEDDING_API_MODEL', 'text-embedding-v4'),
      timeoutMs: int('EMBEDDING_TIMEOUT_MS', 10000),
      batchSize: int('EMBEDDING_BATCH_SIZE', 16),
    },
    search: {
      topK: int('SEARCH_TOP_K', 30),
      finalK: int('SEARCH_FINAL_K', 10),
    },
    llm: {
      provider: oneOf<LlmProviderKind>('LLM_PROVIDER', ['none', 'deepseek'], 'none'),
      apiBase: str('LLM_API_BASE', 'https://api.deepseek.com'),
      apiKey: str('LLM_API_KEY', ''),
      model: str('LLM_MODEL', 'deepseek-v4-flash'),
      timeoutMs: int('LLM_TIMEOUT_MS', 30000),
      temperature: float('LLM_TEMPERATURE', 0.3),
      maxTokens: int('LLM_MAX_TOKENS', 1024),
      contextTopK: int('LLM_CONTEXT_TOPK', 5),
    },
    rerank: {
      provider: oneOf<RerankProviderKind>('RERANK_PROVIDER', ['api', 'none'], DEFAULT_RERANK_PROVIDER),
      apiBase: str('RERANK_API_BASE', DEFAULT_RERANK_API_BASE),
      // 重排序 API Key 统一从 DASHSCOPE_API_KEY 读取（不硬编码、与 embedding 的 EMBEDDING_API_KEY 分离）
      apiKey: str('DASHSCOPE_API_KEY', ''),
      model: str('RERANK_MODEL', DEFAULT_RERANK_MODEL),
      topN: int('RERANK_TOPN', DEFAULT_RERANK_TOPN),
      topK: int('RERANK_TOPK', DEFAULT_RERANK_TOPK),
      timeoutMs: int('RERANK_TIMEOUT_MS', DEFAULT_RERANK_TIMEOUT_MS),
      returnDocuments: bool('RERANK_RETURN_DOCUMENTS', DEFAULT_RERANK_RETURN_DOCUMENTS),
    },
    generation: {
      temperature: float('GENERATION_TEMPERATURE', DEFAULT_GENERATION_PARAMS.temperature),
      topP: float('GENERATION_TOP_P', DEFAULT_GENERATION_PARAMS.topP),
      maxTokens: int('GENERATION_MAX_TOKENS', DEFAULT_GENERATION_PARAMS.maxTokens),
      thinkingRounds: int('GENERATION_THINKING_ROUNDS', DEFAULT_GENERATION_PARAMS.thinkingRounds),
    },
    thinking: {
      maxTotalInputTokens: int('THINKING_MAX_INPUT_TOKENS', DEFAULT_THINKING_BUDGET.maxTotalInputTokens),
      maxWallClockMs: int('THINKING_MAX_WALL_CLOCK_MS', DEFAULT_THINKING_BUDGET.maxWallClockMs),
      diffConvergeThreshold: float(
        'THINKING_DIFF_CONVERGE_THRESHOLD',
        DEFAULT_THINKING_BUDGET.diffConvergeThreshold,
      ),
      maxConsecutiveFailures: int(
        'THINKING_MAX_CONSECUTIVE_FAILURES',
        DEFAULT_THINKING_BUDGET.maxConsecutiveFailures,
      ),
    },
    secretsKey: str('SECRETS_KEY', jwtSecret),
    chunk: {
      // 与 shared 常量保持单一数据源，避免前后端分块口径漂移
      size: int('CHUNK_SIZE', DEFAULT_CHUNK_SIZE),
      overlap: int('CHUNK_OVERLAP', DEFAULT_CHUNK_OVERLAP),
    },
    log: {
      level: str('LOG_LEVEL', isProduction ? 'info' : 'debug'),
      file: str('LOG_FILE', ''),
    },
    allowedOrigins,
    providerAllowedOrigins: str('PROVIDER_ALLOWED_ORIGINS', '').split(',').map(v => v.trim()).filter(Boolean),
    shareBaseUrl: str('SHARE_BASE_URL', DEFAULT_SHARE_BASE_URL),
  };

  if (config.chunk.overlap >= config.chunk.size) {
    throw new Error(`CHUNK_OVERLAP(${config.chunk.overlap}) 必须小于 CHUNK_SIZE(${config.chunk.size})`);
  }
  if (config.embedding.dim <= 0 || config.embedding.dim > 4096) {
    throw new Error(`EMBEDDING_DIM 必须在 1..4096 之间，当前：${config.embedding.dim}`);
  }
  if (config.llm.temperature < 0 || config.llm.temperature > 2) {
    throw new Error(`LLM_TEMPERATURE 必须在 0..2 之间，当前：${config.llm.temperature}`);
  }
  if (config.llm.contextTopK < 1 || config.llm.contextTopK > 50) {
    throw new Error(`LLM_CONTEXT_TOPK 必须在 1..50 之间，当前：${config.llm.contextTopK}`);
  }
  if (config.rerank.topN < 1 || config.rerank.topN > 100) {
    throw new Error(`RERANK_TOPN 必须在 1..100 之间，当前：${config.rerank.topN}`);
  }
  if (config.rerank.topK < 1 || config.rerank.topK > 50) {
    throw new Error(`RERANK_TOPK 必须在 1..50 之间，当前：${config.rerank.topK}`);
  }
  if (config.rerank.timeoutMs < 1) {
    throw new Error(`RERANK_TIMEOUT_MS 必须为正整数，当前：${config.rerank.timeoutMs}`);
  }
  if (config.generation.temperature < 0 || config.generation.temperature > 2) {
    throw new Error(`GENERATION_TEMPERATURE 必须在 0..2 之间，当前：${config.generation.temperature}`);
  }
  if (config.generation.topP < 0 || config.generation.topP > 1) {
    throw new Error(`GENERATION_TOP_P 必须在 0..1 之间，当前：${config.generation.topP}`);
  }
  if (config.generation.maxTokens < 256 || config.generation.maxTokens > 8192) {
    throw new Error(`GENERATION_MAX_TOKENS 必须在 256..8192 之间，当前：${config.generation.maxTokens}`);
  }
  if (config.generation.thinkingRounds < 1 || config.generation.thinkingRounds > 10) {
    throw new Error(
      `GENERATION_THINKING_ROUNDS 必须在 1..10 之间，当前：${config.generation.thinkingRounds}`,
    );
  }
  if (config.thinking.diffConvergeThreshold <= 0 || config.thinking.diffConvergeThreshold >= 1) {
    throw new Error(
      `THINKING_DIFF_CONVERGE_THRESHOLD 必须在 (0,1) 之间，当前：${config.thinking.diffConvergeThreshold}`,
    );
  }

  cachedConfig = config;
  return config;
}

/** 清空配置缓存（测试用） */
export function resetConfigCache(): void {
  cachedConfig = null;
}

/** 当前文件所属包的根（src/config.ts -> packages/server） */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
