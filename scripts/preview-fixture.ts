/** 独立 UI 验收环境：临时数据库 + mock 模型，不读取用户数据、不调用付费 API。 */
import { makeTempDir, setTestEnv, makeCall } from '../packages/server/test/harness.js';
import { createMockGateway, createTestAppWithGateway, thinkingArtifact } from '../packages/server/test/mock-gateway.js';
import { createServer } from 'vite';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

setTestEnv(makeTempDir('ui-preview'));
process.env.LLM_PROVIDER = 'deepseek';
process.env.LLM_API_KEY = randomBytes(24).toString('base64url');
const mock = createMockGateway({
  defaultStream: async function* (req, signal) {
    const text = req.meta.purpose === 'thinking' ? thinkingArtifact(1) :
      '这是一条用于界面验收的模拟回答。\n\n第一行：历史消息应清晰可读。\n第二行：支持换行和长内容折行。\n\n资料说明：建议定期备份知识库，并验证恢复结果。[1]';
    for (const part of text.match(/.{1,8}|\n/g) ?? []) {
      await new Promise((resolve) => setTimeout(resolve, 70));
      if (signal.aborted) return;
      yield { type: 'content_delta', text: part };
    }
    yield { type: 'finish', finishReason: 'stop' };
  },
});
const ctx = await createTestAppWithGateway(mock.gateway);
const call = makeCall(ctx.app);
const previewUsername = `ui_preview_${randomBytes(4).toString('hex')}`;
const previewPassword = `${randomBytes(18).toString('base64url')}!A1`;
const reg = await call('POST', '/api/auth/register', { payload: { username: previewUsername, password: previewPassword } });
if (reg.status !== 200) throw new Error('无法创建测试用户');
const token = reg.body.data.token;
await call('POST', '/api/documents/text', { token, payload: { title: '界面验收示例文档', content: '# 备份说明\n\n建议定期备份知识库，并验证恢复结果。历史消息需要在浅色、深色及高对比主题下保持可读。' } });
const conversation = await call('POST', '/api/conversations', { token, payload: { title: '历史对话 · 配色与换行验收', kbEnabled: true } });
await call('POST', `/api/conversations/${conversation.body.data.item.id}/messages`, { token, payload: { content: '如何备份知识库？\n请保留这一行换行，用于检查历史对话显示。', mode: 'chat' } });
await (ctx.app as unknown as FastifyInstance).listen({ port: 8788, host: '127.0.0.1' });
const vite = await createServer({
  root: path.resolve('packages/web'),
  server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true } } },
});
await vite.listen();
console.log(`UI 验收：http://127.0.0.1:5180（${previewUsername} / ${previewPassword}），所有回答为 mock。`);
const stop = async () => { await vite.close(); await ctx.close(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
