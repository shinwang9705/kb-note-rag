/**
 * 跨端共享常量：文件白名单、分块参数、容量上限。
 * 前端用于上传前校验，后端用于强制校验（后端才是权威）。
 */
import type { GenerationParams, RagSettings, ThinkingBudget } from './types.js';

/** 允许上传的扩展名（小写，不含点） */
export const ALLOWED_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'pdf'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** 扩展名 -> MIME 类型（用于下载时的 Content-Type） */
export const EXT_MIME: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** 默认分块参数（可被环境变量覆盖）：窗口 400 字 + 重叠 80 字 */
export const DEFAULT_CHUNK_SIZE = 400;
export const DEFAULT_CHUNK_OVERLAP = 80;

/** 默认容量上限 */
export const DEFAULT_MAX_DOCUMENTS_PER_USER = 500;
export const DEFAULT_MAX_UPLOAD_MB = 20;
export const DEFAULT_MAX_FILES_PER_UPLOAD = 10;

/** 检索默认参数 */
export const DEFAULT_SEARCH_TOP_K = 30;
export const DEFAULT_SEARCH_FINAL_K = 10;

/** LLM 默认配置（与环境变量默认值保持一致） */
export const DEFAULT_LLM_PROVIDER = 'none';
export const DEFAULT_LLM_API_BASE = 'https://api.deepseek.com';
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';
export const DEFAULT_LLM_TIMEOUT_MS = 30000;
export const DEFAULT_LLM_TEMPERATURE = 0.3;
export const DEFAULT_LLM_MAX_TOKENS = 1024;
export const DEFAULT_LLM_CONTEXT_TOPK = 5;

/** 用户名 / 密码规则（前后端一致） */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** 中文字符判定：用于决定 FTS 查询是否需要 LIKE 兜底 */
export const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** FTS5 trigram 的最小可命中长度：小于该值的纯 CJK 查询必须走 LIKE 兜底 */
export const TRIGRAM_MIN_LEN = 3;

/** 前端存储 token 的 key */
export const TOKEN_STORAGE_KEY = 'kb.token';
export const USER_STORAGE_KEY = 'kb.user';

// ---------------------------------------------------------------------------
// 三期 · 生成参数 + 深度思考预算 + 供应商（共享常量）
// ---------------------------------------------------------------------------

/** 内置供应商标识（新增厂商 = 加一个声明式配置对象，不在业务代码里改分支） */
export const PROVIDER_IDS = ['deepseek', 'qwen', 'doubao', 'glm'] as const;
export type KnownProviderId = (typeof PROVIDER_IDS)[number];

/** 生成参数默认值（对齐设计 §3.3 第 5 点） */
export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 2048,
  thinkingRounds: 3,
};

export const GENERATION_TEMPERATURE_MIN = 0;
export const GENERATION_TEMPERATURE_MAX = 2;
export const GENERATION_TOP_P_MIN = 0;
export const GENERATION_TOP_P_MAX = 1;
export const GENERATION_MAX_TOKENS_MIN = 256;
export const GENERATION_MAX_TOKENS_MAX = 8192;
export const GENERATION_THINKING_ROUNDS_MIN = 1;
export const GENERATION_THINKING_ROUNDS_MAX = 10;

/** 深度思考三维预算默认值（maxTotalOutputTokens 由 maxTokens × rounds × 1.2 在运行时计算） */
export const DEFAULT_THINKING_BUDGET: ThinkingBudget = {
  maxRounds: 3,
  maxTotalOutputTokens: 0,
  maxTotalInputTokens: 200000,
  maxWallClockMs: 180000,
  maxConsecutiveFailures: 2,
  earlyStopOnConverge: true,
  diffConvergeThreshold: 0.9,
};

/** 上下文裁剪：保首轮 + 最近 N 条原文 */
export const CONTEXT_TRIM_KEEP_HEAD = 2;
export const CONTEXT_TRIM_KEEP_TAIL = 6;

// ---------------------------------------------------------------------------
// 四期 · Rerank 默认配置 + 置信度阈值（与环境变量默认值保持一致）
// ---------------------------------------------------------------------------

export const DEFAULT_RERANK_PROVIDER = 'api';
export const DEFAULT_RERANK_API_BASE =
  'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';
export const DEFAULT_RERANK_API_KEY = '';
export const DEFAULT_RERANK_MODEL = 'qwen3.7-text-rerank';
export const DEFAULT_RERANK_TOPN = 20;
export const DEFAULT_RERANK_TOPK = 5;
export const DEFAULT_RERANK_TIMEOUT_MS = 10000;
export const DEFAULT_RERANK_RETURN_DOCUMENTS = false;

/** 共享链接默认基址（Vite dev；生产由 SHARE_BASE_URL 覆盖） */
export const DEFAULT_SHARE_BASE_URL = 'http://localhost:5173';

/** 置信度阈值（可 env 覆盖，见 config.ts 的 RERANK_GROUNDED_SCORE / RERANK_PARTIAL_SCORE） */
export const RERANK_GROUNDED_SCORE = 0.5;
export const RERANK_PARTIAL_SCORE = 0.25;

// ---------------------------------------------------------------------------
// 六期 · RAG 运行级默认配置 + 取值范围（落在 user_settings.settings_json.rag）
// ---------------------------------------------------------------------------

/** RAG 运行级参数取值范围（用户可实时调；越界值 clamp 到边界而非报错） */
export const RAG_RANGE = {
  searchTopK: { min: 1, max: 100 },
  searchFinalK: { min: 1, max: 50 },
  contextTopK: { min: 1, max: 50 },
  rerankTopN: { min: 1, max: 100 },
  rerankTopK: { min: 1, max: 50 },
  confidence: { min: 0, max: 1 },
  chunkSize: { min: 100, max: 4000 },
  chunkOverlap: { min: 0, max: 1000 },
} as const;

/** RAG 运行级默认值（与既有环境变量 / 代码常量保持单一数据源） */
export const DEFAULT_RAG_SETTINGS: RagSettings = {
  search: {
    topK: DEFAULT_SEARCH_TOP_K,
    finalK: DEFAULT_SEARCH_FINAL_K,
    defaultMode: 'auto',
  },
  context: { topK: DEFAULT_LLM_CONTEXT_TOPK },
  rerank: {
    enabled: true,
    topN: DEFAULT_RERANK_TOPN,
    topK: DEFAULT_RERANK_TOPK,
  },
  confidence: {
    groundedScore: RERANK_GROUNDED_SCORE,
    partialScore: RERANK_PARTIAL_SCORE,
  },
  chunk: {
    strategy: 'structured',
    size: DEFAULT_CHUNK_SIZE,
    overlap: DEFAULT_CHUNK_OVERLAP,
    breakMode: 'sentence',
    preserveSectionPath: true,
  },
};
