# kb-note：基于 RAG 的知识库智能问答系统

一个面向个人和小型团队的 B/S 架构知识库系统。它把文档解析、全文检索、向量检索、重排序和大模型生成组合成一条完整的 RAG 链路，并在回答中保留可回溯的原文引用。

项目采用 npm workspaces 管理，前端为 React + Vite，后端为 Fastify + TypeScript，数据存储使用 Node.js 内置 SQLite。运行时数据库、上传文档、模型文件和密钥均保存在本地，不包含在仓库中。

## 功能特性

- 支持 TXT、Markdown、CSV、DOCX、XLSX、PDF 文档上传、文本直接入库、替换和重建索引。
- 基于 SQLite FTS5 trigram 的中文全文检索，并支持 sqlite-vec 向量检索与 RRF 混合排序。
- 可限定知识库或单篇文档检索，用户、文档、会话和检索结果均按账号隔离。
- 提供单轮问答与多轮会话，支持流式输出、停止生成、上下文参数和思考过程展示。
- 依据检索结果生成带 `[n]` 引用的回答，可从答案直接定位原文。
- 支持 DeepSeek、通义千问、豆包和智谱等 OpenAI 兼容模型端点；API Key 由用户在本地配置并加密保存。
- 向量或重排序服务不可用时可降级到关键词检索；检索依据不足时拒绝无依据生成。
- 提供知识库管理、标签与收藏、检索历史、用量统计、数据驾驶舱和管理员用户管理。
- 内置登录失败锁定、JWT 注销黑名单、模型端点来源限制、上传配额和多用户权限校验。
- 支持浅色、深色和高对比度主题，并针对桌面端与移动端进行响应式适配。

## 系统架构

```text
浏览器
  │
  ├─ React 18 + Vite + Tailwind CSS
  │    ├─ 文档 / 知识库 / 标签管理
  │    ├─ 检索、对话、引用阅读器
  │    └─ 设置、用量与数据驾驶舱
  │
  └─ Fastify REST / SSE API
       ├─ JWT 认证与用户隔离
       ├─ 文档解析、分块、入库事务
       ├─ FTS5 + sqlite-vec + RRF + Rerank
       ├─ RAG 上下文、引用校验、置信度判断
       └─ 多供应商 LLM 路由、超时、取消与降级
              │
              └─ SQLite / 本地上传目录 / 本地模型缓存
```

RAG 请求的主要流程：

```text
用户问题 → 范围与权限过滤 → 关键词/向量召回 → 去重与 RRF
        → 可选 Rerank → 置信度判断 → 组装受限上下文
        → LLM 流式生成 → 引用校验 → 答案与来源落库
```

## 技术栈

| 层次 | 技术 |
| --- | --- |
| Web | React 18、TypeScript、Vite 6、Tailwind CSS、Framer Motion、ECharts |
| API | Fastify 5、TypeScript、原生 Fetch、Server-Sent Events |
| 数据 | Node.js `node:sqlite`、SQLite FTS5、sqlite-vec |
| 文档解析 | Mammoth、ExcelJS、pdf-parse、内置文本/CSV 解析器 |
| 工程 | npm workspaces、Node Test Runner、TypeScript |

## 环境要求

- Node.js 22.5 或更高版本，推荐当前 Node.js 22 LTS。
- npm 10 或更高版本。
- Windows、macOS 或 Linux。
- 使用语义检索时需要可用的 sqlite-vec 扩展；初始化脚本会按平台尝试准备扩展。

## 快速开始

```bash
git clone <repository-url>
cd kb-note
npm install
npm run setup
npm run dev
```

打开 <http://localhost:5173>。后端默认监听 `http://localhost:8787`，健康检查地址为 <http://localhost:8787/api/health>。

`npm run setup` 会执行以下操作：

1. 创建运行时数据目录。
2. 尝试准备 sqlite-vec 扩展。
3. 从 `.env.example` 生成本地 `.env`，并随机生成 JWT 密钥。
4. 执行数据库迁移。

首次使用可以在开放注册的开发环境自行注册，也可以创建管理员：

```bash
npm run create-admin
```

命令会输出一次性随机密码。也可以显式传入用户名和密码：

```bash
npm run create-admin -- myadmin "YourStrongPassword"
```

## 配置模型与检索

所有私密配置只应写入本地 `.env` 或通过设置页保存，切勿提交真实密钥。`.env.example` 只保留空值和非敏感示例。

最小的 DeepSeek 配置示例：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_BASE=https://api.deepseek.com
LLM_API_KEY=
LLM_MODEL=deepseek-v4-flash
```

将真实 `LLM_API_KEY` 填入本地 `.env`，或登录后在设置页保存个人供应商凭据。系统支持的关键配置包括：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET` | JWT 签名密钥；生产环境至少 32 字符 |
| `SECRETS_KEY` | 用户供应商凭据加密密钥；生产环境必须显式设置且稳定保管 |
| `ALLOW_REGISTER` | 是否允许公开注册；生产环境默认关闭 |
| `DATA_DIR` / `DB_PATH` | 本地数据目录与 SQLite 路径 |
| `EMBEDDING_PROVIDER` | `local`、`api` 或 `none` |
| `EMBEDDING_API_KEY` | API 向量服务密钥；留空则不启用该服务 |
| `DASHSCOPE_API_KEY` | 可选的重排序服务密钥 |
| `LLM_API_KEY` | 服务端默认大模型密钥；留空则不启用默认问答模型 |
| `PROVIDER_ALLOWED_ORIGINS` | 管理员额外授权的自定义模型网关 origin |
| `ALLOWED_ORIGINS` | 允许访问 API 的前端来源 |
| `TRUST_PROXY` | 仅在明确可信的反向代理后开启 |

完整配置项及注释见 [`.env.example`](.env.example)。若本地向量模型不可用，系统会继续提供关键词检索；设置页会显示当前 RAG 能力状态。

## 常用命令

```bash
npm run dev           # 同时启动前后端开发服务
npm run build         # 构建 shared、server 和 web
npm run start         # 启动已构建的生产后端
npm run typecheck     # 前后端 TypeScript 检查
npm test              # 运行完整测试集
npm run check:parsers # 检查文档解析器
npm run check:ingest  # 检查入库流程
npm run check:search  # 检查检索流程
```

生产部署前至少需要：

1. 设置 `NODE_ENV=production`。
2. 配置强随机 `JWT_SECRET` 和独立、稳定的 `SECRETS_KEY`。
3. 设置受限的 `ALLOWED_ORIGINS`，并确认是否真的需要 `TRUST_PROXY=true`。
4. 关闭公开注册或显式制定注册策略。
5. 在反向代理层启用 HTTPS、请求体限制和额外的访问频率限制。

## 在线备份

备份脚本使用 SQLite 在线备份 API 创建一致性数据库快照，并复制快照所引用的原文文件，同时生成 SHA-256 校验清单：

```bash
node scripts/backup.mjs
node scripts/backup.mjs --verify <backup-directory>
```

备份不包含 `.env` 或加密密钥。请把 `SECRETS_KEY` 单独保存在安全位置，并先在新的空目录中演练恢复，避免直接覆盖现有数据。

## 目录结构

```text
.
├─ packages/
│  ├─ shared/        # 前后端共享类型、常量和 DTO
│  ├─ server/        # Fastify API、RAG、检索、模型路由与数据库迁移
│  └─ web/           # React 前端、主题和响应式界面
├─ scripts/          # 初始化、开发、管理、检查与备份脚本
├─ package.json      # npm workspaces 与统一命令
├─ tsconfig.base.json
└─ .env.example      # 不含真实密钥的配置模板
```

运行后产生的 `data/`、`.env`、日志、依赖和构建产物均被 `.gitignore` 排除。

## 测试与已知限制

项目包含认证、权限隔离、文档入库、检索、RAG、会话、流式协议、供应商路由、备份和统计等测试。提交前建议执行：

```bash
npm run typecheck
npm test
npm run build
```

当前仍适合继续增强的方向包括持久化后台入库队列、向量索引版本管理、固定检索评测集、全局/IP/成本限流、大会话分页以及前端按页面拆包。

## 数据与密钥安全

本仓库不包含任何运行时数据库、用户账号、上传文档或真实 API Key。克隆后生成的是全新的本地实例。请勿把以下内容加入版本控制：

- `.env`、访问令牌、模型供应商 API Key 和生产密钥。
- `data/` 下的数据库、上传原文、模型缓存和 sqlite-vec 二进制。
- 运行日志、备份目录、导出的数据及用户会话内容。

若密钥曾被意外提交，仅从最新提交删除是不够的；应立即在供应商控制台撤销并重新生成密钥，同时清理 Git 历史。

## License

本项目当前未附带开源许可证。在添加明确许可证之前，默认保留所有权利。
