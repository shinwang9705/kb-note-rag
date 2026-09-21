#!/usr/bin/env node
/**
 * 演示数据播种脚本（幂等，可重复执行）。
 *
 * 用法（需后端已启动）：
 *   node scripts/seed.mjs [baseUrl]
 *
 * 行为：
 *   - 注册演示账号 demo / DemoPass1234（已存在则直接登录）
 *   - 通过 HTTP 写入若干篇示例文档（POST /api/documents/text）
 *   - 幂等：若某篇示例文档标题已存在，则跳过，不重复创建
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'DemoPass1234';

/** 示例文档语料（与检索自检共用主题，方便演示语义检索） */
const DEMO_DOCS = [
  {
    title: '数据备份与恢复',
    content: `# 数据备份与恢复

备份策略分为全量备份、增量备份与差异备份三种。全量备份每周日凌晨执行一次，
增量备份每小时执行一次，写入对象存储的近线桶。

恢复演练：每季度做一次恢复演练，验证恢复点目标 RPO 与恢复时间目标 RTO 是否达标。
演练步骤包括挂载快照、回放增量日志、校验行数与抽样比对。

常见故障：硬盘损坏、误删表、机房断电。定期备份可以在这些情况下避免数据损毁与丢失。
恢复完成后需要重新建立索引并跑一次完整性校验。`,
  },
  {
    title: '向量检索原理',
    content: `# 向量检索原理

向量检索把文本映射成稠密向量，再通过余弦相似度或内积召回候选片段。
常用的索引结构有 HNSW、IVF-PQ 与暴力扫描三种。

本项目使用 sqlite-vec 扩展提供的 vec0 虚表存放向量，
KNN 查询通过 embedding MATCH 加 k 参数完成。`,
  },
  {
    title: '账号与权限',
    content: `# 账号与权限

系统采用自签 JWT 做鉴权，令牌放在 Authorization 头的 Bearer 字段。
登出通过 jti 黑名单实现，令牌仍然有效但会被服务端拒绝。

多用户之间数据硬隔离，所有查询都强制带上 user_id 条件，
本知识库不会把一个用户的片段返回给另一个用户。`,
  },
  {
    title: '分块与重叠窗口',
    content: `# 分块与重叠窗口

长文档入库时会按固定窗口切分成片段，相邻片段之间保留一定重叠，
避免一个完整语义被硬生生切断。

默认窗口为 400 字、重叠 80 字，可通过 CHUNK_SIZE 与 CHUNK_OVERLAP 环境变量调整。
片段会记录 charStart 与 charEnd 偏移，检索命中后可定位回原文位置。`,
  },
  {
    title: '快速开始指南',
    content: `# 快速开始指南

安装依赖、初始化数据库并启动开发服务后，即可在浏览器中注册账号并登录。

登录后先创建一个知识库，然后上传文档或粘贴纯文本入库，
最后在检索页输入关键词或自然语言问题，系统会返回带高亮的命中片段。`,
  },
];

async function call(method, path, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function log(level, message) {
  console.log(`[seed:${level}] ${message}`);
}

async function main() {
  console.log(`=== seed: ${BASE} ===`);

  // 1) 健康检查
  try {
    const health = await call('GET', '/api/health');
    if (health.status !== 200 || health.json?.data?.status !== 'ok') {
      throw new Error(`后端未就绪：status=${health.status} body=${JSON.stringify(health.json)}`);
    }
    log('ok', '后端健康检查通过');
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // 2) 注册或登录演示账号
  let token = '';
  const reg = await call('POST', '/api/auth/register', {
    body: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
  });
  if (reg.status === 200 && reg.json?.data?.token) {
    token = reg.json.data.token;
    log('ok', `演示账号已注册：${DEMO_USERNAME}`);
  } else if (reg.status === 409) {
    const login = await call('POST', '/api/auth/login', {
      body: { username: DEMO_USERNAME, password: DEMO_PASSWORD },
    });
    if (login.status !== 200 || !login.json?.data?.token) {
      log('error', `演示账号登录失败：${JSON.stringify(login.json)}`);
      process.exit(1);
    }
    token = login.json.data.token;
    log('ok', `演示账号已存在，直接登录：${DEMO_USERNAME}`);
  } else {
    log('error', `注册失败：status=${reg.status} body=${JSON.stringify(reg.json)}`);
    process.exit(1);
  }

  // 3) 读取现有文档标题，用于幂等去重
  const existing = new Set();
  const list = await call('GET', '/api/documents?limit=200', { token });
  for (const doc of list.json?.data?.items ?? []) {
    existing.add(doc.title);
  }

  // 4) 逐篇写入（跳过已存在标题）
  let created = 0;
  let skipped = 0;
  for (const doc of DEMO_DOCS) {
    if (existing.has(doc.title)) {
      skipped += 1;
      log('skip', `《${doc.title}》已存在，跳过`);
      continue;
    }
    const res = await call('POST', '/api/documents/text', {
      body: { title: doc.title, content: doc.content },
      token,
    });
    const item = res.json?.data?.item ?? null;
    if (res.status === 200 && item?.status === 'ready') {
      created += 1;
      log('ok', `已写入《${doc.title}》（chunks=${item.chunkCount}）`);
    } else {
      log('warn', `《${doc.title}》写入异常：status=${res.status} body=${JSON.stringify(res.json)}`);
    }
  }

  console.log(`\n=== seed 完成：新建 ${created} 篇，跳过 ${skipped} 篇 ===`);
  console.log(`现在可用账号 ${DEMO_USERNAME} / ${DEMO_PASSWORD} 登录并在检索页查询。`);
}

main().catch((error) => {
  console.error('[seed] 执行失败：', error);
  process.exit(1);
});
