/** 服务端 SSE 共用读取器：处理 UTF-8 分片、CRLF、尾帧与异常断流。 */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown> & { type: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lines: string[] = [];
  const parse = (): (Record<string, unknown> & { type: string }) | null => {
    if (!lines.length) return null;
    const raw = lines.join('\n'); lines = [];
    const event = JSON.parse(raw) as Record<string, unknown> & { type: string };
    if (typeof event.type !== 'string') throw new Error('服务端流式消息格式错误');
    return event;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error('流式消息过大');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
        if (line !== '') continue;
        const event = parse();
        if (!event) continue;
        yield event;
        if (['done', 'error', 'run_completed', 'run_aborted'].includes(event.type)) return;
      }
      if (done) throw new Error('连接提前中断，已保留收到的内容，请重试');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
