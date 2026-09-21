/**
 * 主理人端到端验证脚本：检索链路 / 短词兜底 / 多用户隔离 / 降级行为
 * 用法：node scripts/verify-lead.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:8787';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  [PASS] ${name}`); }
  else { fail++; results.push(`  [FAIL] ${name} ${detail}`); }
}

async function api(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: form ? form : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function register(username) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'Qa123456' },
  });
  if (r.status !== 200 && r.status !== 201) return { error: r.json };
  return { token: r.json.data?.token, user: r.json.data?.user };
}

async function uploadDoc(token, filename, content) {
  // 实际契约：POST /api/documents/text（纯文本入库）
  return api('/api/documents/text', {
    method: 'POST', token,
    body: { title: filename.replace(/\.\w+$/, ''), content },
  });
}

async function waitReady(token, docId, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await api(`/api/documents/${docId}`, { token });
    const st = r.json?.data?.item?.status;
    if (st === 'ready' || st === 'failed') return st;
    await new Promise((r) => setTimeout(r, 400));
  }
  return 'timeout';
}

(async () => {
  const suffix = Date.now().toString().slice(-6);
  const userA = `vA${suffix}`;
  const userB = `vB${suffix}`;

  console.log('=== 1. 注册两个用户 ===');
  const A = await register(userA);
  const B = await register(userB);
  check('用户A注册成功', !!A.token, JSON.stringify(A.error || ''));
  check('用户B注册成功', !!B.token, JSON.stringify(B.error || ''));
  if (!A.token || !B.token) { report(); process.exit(1); }

  console.log('=== 2. 弱密码应被拒绝 ===');
  const weak = await api('/api/auth/register', {
    method: 'POST', body: { username: `weak${suffix}`, password: '123' },
  });
  check('弱密码注册被拒', weak.status >= 400, `status=${weak.status}`);

  console.log('=== 3. A 上传文档（含"数据备份与恢复"，不含"防止数据丢失"）===');
  const docText = [
    '# 数据备份与恢复',
    '',
    '本文档说明系统的备份策略。',
    '我们每天凌晨执行一次全量快照，保留最近三十天。',
    '恢复流程：先停止写入，再挂载最近快照，最后回放增量日志。',
    '向量索引可以重建，因此备份时只需保存原始文档与数据库文件。',
  ].join('\n');
  const up = await uploadDoc(A.token, '数据备份与恢复.md', docText);
  check('上传返回 200/201', [200, 201].includes(up.status), `status=${up.status} ${JSON.stringify(up.json).slice(0, 200)}`);
  const docId = up.json?.data?.item?.id;
  check('拿到 documentId', !!docId, JSON.stringify(up.json?.data || {}).slice(0, 200));

  if (docId) {
    const st = await waitReady(A.token, docId);
    check('文档状态到达 ready', st === 'ready', `status=${st}`);
  }

  console.log('=== 4. 关键词检索（3字以上）===');
  const s1 = await api('/api/search', { method: 'POST', token: A.token, body: { query: '备份策略' } });
  check('检索返回 200', s1.status === 200, `status=${s1.status} ${JSON.stringify(s1.json).slice(0, 200)}`);
  const hits1 = s1.json?.data?.hits || s1.json?.data?.items || s1.json?.data?.results || [];
  check('检索有结果', hits1.length > 0, `hits=${hits1.length}`);
  if (hits1.length) {
    console.log('    首条:', JSON.stringify(hits1[0]).slice(0, 220));
  }

  console.log('=== 5. 短词兜底（1-2字中文，trigram 的已知限制）===');
  for (const q of ['库', '向量', '备份']) {
    const s = await api('/api/search', { method: 'POST', token: A.token, body: { query: q } });
    const hits = s.json?.data?.hits || s.json?.data?.items || s.json?.data?.results || [];
    check(`短词「${q}」有结果`, s.status === 200 && hits.length > 0, `status=${s.status} hits=${hits.length}`);
  }

  console.log('=== 6. 多用户隔离 ===');
  const sB = await api('/api/search', { method: 'POST', token: B.token, body: { query: '备份策略' } });
  const hitsB = sB.json?.data?.hits || sB.json?.data?.items || sB.json?.data?.results || [];
  check('B 搜不到 A 的文档', hitsB.length === 0, `hitsB=${hitsB.length}`);

  if (docId) {
    const cross = await api(`/api/documents/${docId}`, { token: B.token });
    check('B 访问 A 的文档返回 404', cross.status === 404, `status=${cross.status}`);
  }

  console.log('=== 7. 当前检索模式 ===');
  const meta = await api('/api/meta');
  console.log('    meta:', JSON.stringify(meta.json?.data || {}).slice(0, 300));
  check('searchMode 已明确（非 unknown）', meta.json?.data?.searchMode && meta.json?.data?.searchMode !== 'unknown',
    `searchMode=${meta.json?.data?.searchMode}`);

  report();
  process.exit(fail > 0 ? 1 : 0);
})();

function report() {
  console.log('\n================ 验证结果 ================');
  results.forEach((r) => console.log(r));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==========================================');
}
