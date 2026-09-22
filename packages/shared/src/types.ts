/**
 * 跨端共享类型定义（前后端共用，禁止引入任何运行时依赖）。
 */

/** 统一响应信封：成功 data 有值，失败 code !== 'OK' */
export interface ApiResponse<T = unknown> {
  code: string;
  message: string;
  data?: T;
  request_id?: string;
}

/** 统一错误体 */
export interface ApiErrorBody {
  code: string;
  message: string;
  request_id?: string;
  details?: unknown;
}

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

/** 对外暴露的用户信息（不含密码哈希） */
export interface User {
  id: number;
  username: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface Library {
  id: number;
  userId: number;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: number;
  userId: number;
  libraryId: number | null;
  title: string;
  sourceType: 'upload' | 'text';
  fileName: string | null;
  fileExt: string | null;
  fileSize: number;
  mimeType: string | null;
  charCount: number;
  chunkCount: number;
  status: DocumentStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** 是否收藏（收藏置顶排序用） */
  isFavorite: boolean;
  /** 文档标签名列表（五期新增；覆盖式 set） */
  tags: string[];
}

export interface Chunk {
  id: number;
  userId: number;
  docId: number;
  seq: number;
  content: string;
  charStart: number;
  charEnd: number;
  /** 章节路径（如「一、概述 > 1.2 架构」），五期分块结构感知；旧数据无此字段 */
  sectionPath?: string;
}

/** 文档标签（五期新增） */
export interface DocTag {
  id: number;
  name: string;
}

export type IngestStatus = 'queued' | 'running' | 'done' | 'failed';

export interface IngestTask {
  id: number;
  userId: number;
  docId: number | null;
  status: IngestStatus;
  stage: string;
  progress: number;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 检索模式：混合（向量+关键词）/ 仅关键词 / 仅向量 */
export type SearchMode = 'hybrid' | 'keyword' | 'vector';

export interface SearchHit {
  chunkId: number;
  docId: number;
  docTitle: string;
  snippet: string;
  score: number;
  /** 片段在原文中的起始字符偏移（用于"查看原文"跳到文档并高亮） */
  charStart: number;
  /** 片段在原文中的结束字符偏移（不含） */
  charEnd: number;
  /** 片段在文档内的序号 */
  seq: number;
  /**
   * snippet 内高亮区间（相对 snippet 的字符下标），未命中为 -1。
   * 用偏移量而不是 <mark> 标签：检索内容来自用户上传的文档，
   * 服务端回灌 HTML 会让前端必须 dangerouslySetInnerHTML，等于开了 XSS 口子。
   */
  highlightStart: number;
  highlightEnd: number;
  /** 命中来自哪条通道，便于前端标注 */
  source: 'fts' | 'vec' | 'both';
  /** 章节路径（五期分块结构感知；旧数据无此字段） */
  sectionPath?: string;
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
  tookMs: number;
  /** 是否触发了 LIKE 兜底（trigram 对 1-2 字中文恒 0 命中） */
  fallbackLike: boolean;
  /** 各通道原始命中数，便于排查"为什么搜不到" */
  stats: {
    fts: number;
    vec: number;
    like: number;
  };
}

/** RAG 问答引用来源（charStart/charEnd 供前端跳原文） */
export interface ChatSource {
  chunkId: number;
  docId: number;
  docTitle: string;
  snippet: string;
  charStart: number;
  charEnd: number;
  /** RRF 融合分（关键词+语义通道加权后的排序分） */
  score: number;
  /** 重排序（rerank）后的归一化相关度 0..1；未走 rerank 时缺省 */
  rerankScore?: number;
  /** 章节路径（五期分块结构感知；旧数据无此字段） */
  sectionPath?: string;
}

/** POST /api/chat 返回 */
export interface AskResult {
  answer: string;
  sources: ChatSource[];
  mode: SearchMode;
  tookMs: number;
  /** 实际返回答案的模型标识；未调用 LLM 时为空串 */
  model: string;
  /** 是否确实有依据（检索无命中时为 false，不调 LLM） */
  grounded: boolean;
  /** 置信度三档标签（四期新增；缺省兼容旧前端） */
  confidence?: ConfidenceLevel;
  /** 跨文档聚合元数据（四期新增；缺省兼容旧前端） */
  crossDoc?: CrossDocMeta;
  /** 越界引用编号（五期引用回验；缺省表示无越界） */
  citationWarnings?: number[];
}

/** GET /api/chat/status 返回 */
export interface LlmStatus {
  enabled: boolean;
  provider: string;
  model: string;
}

/** 管理员用户列表项（不含任何文档内容，仅统计文档数） */
export interface AdminUserItem {
  id: number;
  username: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  docCount: number;
  createdAt: string;
}

/** 检索历史项（SRCH-08） */
export interface SearchHistoryItem {
  id: number;
  query: string;
  mode: string;
  hitCount: number;
  createdAt: string;
}

/** 个人用量统计（OPS-05） */
export interface UsageStats {
  docCount: number;
  storageBytes: number;
  searchCount7d: number;
  /** 入库任务成功率 0..1；无任务时按 1 处理 */
  taskSuccessRate: number;
}

/** 管理员全局用量统计（跨用户聚合，不含任何文档内容） */
export interface AdminUsageStats {
  userCount: number;
  docCount: number;
  storageBytes: number;
  searchCount7d: number;
}

/** 文档/索引健康统计（IDX-07） */
export interface DocumentStats {
  docTotal: number;
  docReady: number;
  docFailed: number;
  chunkTotal: number;
  vecCovered: number;
  vecCoverage: number;
  storageBytes: number;
  /** 文档类型分布（四期驾驶舱追加；向后兼容，缺省旧前端不渲染） */
  typeDist?: DistItem[];
  /** 知识库分布 */
  libraryDist?: DistItem[];
  /** 状态分布 */
  statusDist?: DistItem[];
}

/** 鉴权相关 */
export interface AuthUser {
  user: User;
  token: string;
  expiresIn: number;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface RegisterInput {
  username: string;
  password: string;
  email?: string | null;
}

/** /api/meta 返回 */
export interface AppMeta {
  appName: string;
  version: string;
  env: string;
  /** 实际生效的检索模式：向量可用 -> hybrid，否则 keyword */
  embeddingMode: SearchMode | 'none';
  /** 显式区分"配置的 provider"与"实际检索模式"，避免前端拿 unknown 猜 */
  searchMode: SearchMode;
  /** 配置的向量提供者：local / api / none */
  embeddingProvider: string;
  /** 向量模型标识 */
  embeddingModel: string;
  /** sqlite-vec 扩展是否装载成功 */
  vecAvailable: boolean;
  allowRegister: boolean;
  limits: {
    maxDocumentsPerUser: number;
    maxUploadMb: number;
    maxFilesPerUpload: number;
  };
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  uptimeSec: number;
  db: 'up' | 'down';
  vec: boolean;
  version: string;
}

// ---------------------------------------------------------------------------
// 三期 · 多轮对话 + 深度思考 + 多厂商 + 历史管理 + 设置（共享类型）
// ---------------------------------------------------------------------------

/** 供应商标识：内置四家，同时允许未来扩展的任意字符串 */
export type ProviderId = 'deepseek' | 'qwen' | 'doubao' | 'glm' | (string & {});

export type ConversationMode = 'chat' | 'agent';

/** 生成参数面板（持久化到 conversations.params_json） */
export interface GenerationParams {
  temperature: number;
  topP: number;
  maxTokens: number;
  thinkingRounds: number;
}

/** 会话级知识库检索范围 */
export interface KbScope {
  libraryId?: number | null;
  documentIds?: number[];
}

/** 滚动摘要（上下文裁剪复用，落 conversations.summary_json） */
export interface ConversationSummary {
  text: string;
  upToSeq: number;
}

export interface Conversation {
  id: number;
  userId: number;
  title: string;
  mode: ConversationMode;
  providerId: string;
  model: string;
  params: GenerationParams;
  strategy: string;
  kbEnabled: boolean;
  kbScope: KbScope | null;
  summary: ConversationSummary | null;
  messageCount: number;
  tokenIn: number;
  tokenOut: number;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'aborted' | 'failed';

/** 消息引用来源（与 ChatSource 同构，落在 messages.citations_json） */
export interface MessageCitation {
  chunkId: number;
  docId: number;
  docTitle: string;
  snippet: string;
  charStart: number;
  charEnd: number;
  score: number;
  /** 章节路径（五期分块结构感知；旧数据无此字段） */
  sectionPath?: string;
}

export interface MessageView {
  id: number;
  conversationId: number;
  seq: number;
  role: MessageRole;
  content: string;
  reasoning: string | null;
  parentId: number | null;
  branchIndex: number;
  status: MessageStatus;
  thinkingRunId: number | null;
  citations: MessageCitation[];
  model: string | null;
  providerId: string | null;
  tokenIn: number;
  tokenOut: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// 三期 · 深度思考（数据基础 + SSE 事件，引擎逻辑在 T03）
// ---------------------------------------------------------------------------

export type StopReason =
  | 'completed'
  | 'converged'
  | 'budget_exhausted'
  | 'max_failures'
  | 'user_aborted'
  | 'error';

export type ThinkingRunStatus =
  | 'planning'
  | 'running'
  | 'synthesizing'
  | 'completed'
  | 'aborted'
  | 'failed';

export interface ThinkingBudget {
  maxRounds: number;
  maxTotalOutputTokens: number;
  maxTotalInputTokens: number;
  maxWallClockMs: number;
  maxConsecutiveFailures: number;
  earlyStopOnConverge: boolean;
  diffConvergeThreshold: number;
}

export interface ThinkingRun {
  id: number;
  userId: number;
  conversationId: number;
  messageId: number | null;
  question: string;
  strategy: string;
  requestedRounds: number;
  completedRounds: number;
  status: ThinkingRunStatus;
  budget: ThinkingBudget;
  consumedIn: number;
  consumedOut: number;
  consumedMs: number;
  stopReason: StopReason | null;
  finalContent: string;
  createdAt: string;
  updatedAt: string;
}

export type ChangeType =
  | 'added'
  | 'removed'
  | 'reworded'
  | 'restructured'
  | 'evidence_added'
  | 'conclusion_changed';

export interface ChangeItem {
  type: ChangeType;
  target: string;
  detail: string;
}

export type RoundStatus = 'running' | 'done' | 'failed' | 'skipped' | 'aborted';

export interface SelfScore {
  clarity: number;
  coverage: number;
  evidence: number;
  concision: number;
}

export interface RoundArtifact {
  runId: number;
  index: number;
  strategy: string;
  instruction: string;
  draft: string;
  reasoning?: string;
  outline: string[];
  changes: ChangeItem[];
  selfScore?: SelfScore;
  hasFurtherImprovement: boolean;
  status: RoundStatus;
  tokenIn: number;
  tokenOut: number;
  latencyMs: number;
  startedAt: string;
  endedAt: string | null;
}

/** 归一化错误（LLM 层 -> 前端展示共用的跨端类型） */
export type ErrorKind =
  | 'auth'
  | 'network'
  | 'rate_limit'
  | 'quota'
  | 'invalid_request'
  | 'server'
  | 'context_overflow'
  | 'timeout'
  | 'parse'
  | 'aborted'
  | 'unknown';

export type SuggestedAction =
  | 'open_settings'
  | 'retry'
  | 'switch_provider'
  | 'reduce_context'
  | 'check_network';

export interface NormalizedError {
  kind: ErrorKind;
  httpStatus?: number;
  providerCode?: string;
  userMessage: string;
  retryable: boolean;
  suggestedAction?: SuggestedAction;
}

export type ThinkingEvent =
  | { type: 'run_started'; runId: number; totalRounds: number; budget: ThinkingBudget }
  | { type: 'round_started'; index: number; totalRounds: number; instruction: string }
  | { type: 'round_reasoning_delta'; index: number; text: string }
  | { type: 'round_delta'; index: number; text: string }
  | { type: 'round_done'; index: number; artifact: RoundArtifact }
  | { type: 'round_failed'; index: number; error: NormalizedError; willRetry: boolean }
  | { type: 'synthesis_started' }
  | { type: 'final_delta'; text: string }
  | { type: 'budget_warning'; consumed: number; limit: number }
  | { type: 'run_completed'; run: ThinkingRun; stopReason: StopReason }
  | { type: 'run_aborted'; runId: number; completedRounds: number; resumable: boolean }
  | { type: 'context_trimmed'; droppedCount: number }
  | { type: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------
// 三期 · 历史管理 / 多厂商 / 设置
// ---------------------------------------------------------------------------

export interface HistoryHit {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  role: MessageRole;
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
  createdAt: string;
}

export interface ProviderModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ProviderModelInfo[];
  configured: boolean;
  maskedKey: string | null;
  isDefault: boolean;
  health: { okRate: number; p95Ms: number; openUntil?: number } | null;
  defaultModel: string;
  docsUrl: string;
  keyFormatHint: string;
}

// ---------------------------------------------------------------------------
// 六期 · RAG 运行级配置（用户可实时调，落在 user_settings.settings_json.rag）
// ---------------------------------------------------------------------------

/** 检索模式（运行级 defaultMode 兜底；auto 按能力自动降级） */
export type RagSearchMode = 'auto' | 'hybrid' | 'keyword' | 'vector';

export interface RagSearchSettings {
  /** 检索单通道候选数 */
  topK: number;
  /** 检索最终返回条数 */
  finalK: number;
  /** 默认检索模式（请求未显式指定 / 传 auto 时兜底） */
  defaultMode: RagSearchMode;
}

export interface RagContextSettings {
  /** 进生成/上下文的片段条数（rerank 不可用时的 fallback） */
  topK: number;
}

export interface RagRerankSettings {
  /** 是否启用精排（与 provider.available 求 && 后生效） */
  enabled: boolean;
  /** 喂给 rerank 的候选数 */
  topN: number;
  /** 重排后进生成条数 */
  topK: number;
}

export interface RagConfidenceSettings {
  /** top1 rerankScore ≥ 此值 -> grounded */
  groundedScore: number;
  /** ≥ 此值 -> partial（< groundedScore） */
  partialScore: number;
}

export type RagChunkStrategy = 'structured' | 'sliding';
export type RagChunkBreakMode = 'sentence' | 'fixed';

/** 文档入库分块规则；修改后仅影响新入库，已有文档需重建索引。 */
export interface RagChunkSettings {
  strategy: RagChunkStrategy;
  size: number;
  overlap: number;
  breakMode: RagChunkBreakMode;
  preserveSectionPath: boolean;
}

export interface RagSettings {
  search: RagSearchSettings;
  context: RagContextSettings;
  rerank: RagRerankSettings;
  confidence: RagConfidenceSettings;
  chunk: RagChunkSettings;
}

/** 三挂载点共用的解析结果（resolveRagParams 单一出口） */
export interface ResolvedRagParams {
  searchTopK: number;
  searchFinalK: number;
  searchMode: RagSearchMode;
  topN: number;
  finalK: number;
  rerankEnabled: boolean;
}

/** GET /api/rag/status 返回的能力状态快照 */
export interface RagStatus {
  /** 结构级（进程级，重启/重建索引才变化） */
  embedding: { provider: string; model: string; available: boolean; dim: number };
  rerankProvider: { provider: string; model: string; available: boolean };
  vecAvailable: boolean;
  chunk: RagChunkSettings;
  /** 运行级（本次生效，用户可实时调） */
  effective: RagSettings;
  resolved: ResolvedRagParams;
  structuralHint: string[];
}

export interface Settings {
  generation: GenerationParams;
  thinking: ThinkingBudget;
  rag: RagSettings;
  ui: { themeId: string };
  wizardCompleted: boolean;
}

/** rag 段的部分更新（四组嵌套字段均可省略） */
export interface RagSettingsPatch {
  search?: Partial<RagSearchSettings>;
  context?: Partial<RagContextSettings>;
  rerank?: Partial<RagRerankSettings>;
  confidence?: Partial<RagConfidenceSettings>;
  chunk?: Partial<RagChunkSettings>;
}

export type RagModelCapability = 'embedding' | 'rerank';
export interface RagModelConfigView {
  capability: RagModelCapability;
  enabled: boolean;
  configured: boolean;
  source: 'user' | 'system' | 'none';
  apiBase: string;
  model: string;
  maskedKey: string | null;
  timeoutMs: number;
  dim?: number;
  batchSize?: number;
}

export interface SaveRagModelConfigInput {
  enabled: boolean;
  apiBase: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  dim?: number;
  batchSize?: number;
}

/** PATCH /api/settings 入参（白名单字段；rag 支持嵌套部分更新） */
export interface PatchSettingsInput {
  generation?: Partial<GenerationParams>;
  thinking?: Partial<ThinkingBudget>;
  rag?: RagSettingsPatch;
  ui?: { themeId?: string };
  wizardCompleted?: boolean;
}

// ---------------------------------------------------------------------------
// 四期 · Rerank / 置信度 / 多文档聚合 / 共享 / 驾驶舱
// ---------------------------------------------------------------------------

/** 置信度三档标签 */
export type ConfidenceLevel = 'grounded' | 'partial' | 'ungrounded';

/** 冲突来源（best-effort，从命中分组里提取文档标题） */
export interface CrossDocConflictSource {
  docId: number;
  docTitle: string;
}

/** 跨文档交叉验证元数据 */
export interface CrossDocMeta {
  /** 命中片段跨多少个不同文档 */
  docCount: number;
  /** 是否出现表述分歧 */
  conflict: boolean;
  /** 分歧涉及的文档（conflict=true 时 best-effort 提供） */
  conflictSources?: CrossDocConflictSource[];
}

/** 知识库只读共享的文档脱敏字段白名单（不含 storage_path/error/userId/mimeType/fileName） */
export interface ShareDoc {
  id: number;
  title: string;
  fileExt: string | null;
  charCount: number;
  chunkCount: number;
  status: DocumentStatus;
  updatedAt: string;
}

/** 共享链接解析出的只读作用域（token -> 库主 + 库） */
export interface ShareScope {
  ownerUserId: number;
  libraryId: number;
  libraryName: string;
  libraryDescription: string;
}

/** 驾驶舱趋势单点：检索 / 提问 / 入库 按日聚合 */
export interface StatsTrendPoint {
  date: string;
  search: number;
  chat: number;
  ingest: number;
}

/** GET /api/stats/trend 返回 */
export interface StatsTrend {
  days: number;
  series: StatsTrendPoint[];
}

/** 对话质量驾驶舱：只包含聚合指标与待改进问题，不返回回答正文。 */
export interface ConversationQualityStats {
  days: number;
  questions: number;
  completedAnswers: number;
  failedAnswers: number;
  citedAnswers: number;
  completionRate: number;
  citationRate: number;
  averageLatencyMs: number;
  noEvidenceQuestions: TopItem[];
}

/** 分布条目（文档类型 / 知识库 / 状态） */
export interface DistItem {
  key: string;
  label: string;
  count: number;
}

/** 热门条目（检索词 / 被引用文档） */
export interface TopItem {
  key: string;
  title: string;
  count: number;
}
