import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEventStream } from '../../web/src/api/event-stream.ts';
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const out = []; for await (const event of readEventStream(stream)) out.push(event); return out;
};
test('前端 SSE 正确处理中文 UTF-8 分片、CRLF、无换行尾帧', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"delta","content":"中文消息"}\r\n\r\ndata: {"type":"done"}');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await collect(stream), [{ type: 'delta', content: '中文消息' }, { type: 'done' }]);
});
test('前端 SSE 无完成标记的断流明确报错，不冒充成功', async () => {
  const stream = new Response('data: {"type":"delta","content":"部分内容"}\n\n').body!;
  await assert.rejects(collect(stream), /连接提前中断/);
});
test('前端 SSE error 和 run_aborted 正常终止并释放 reader', async () => {
  for (const type of ['error', 'run_aborted']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`data: {"type":"${type}"}\n\n`)); }, cancel() { cancelled = true; } });
    assert.equal((await collect(stream))[0]!.type, type); assert.equal(cancelled, true); assert.equal(stream.locked, false);
  }
});
