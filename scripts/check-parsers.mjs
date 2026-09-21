#!/usr/bin/env node
/**
 * 解析 + 分块自检：对 spike/samples 下的样本跑一遍完整链路。
 * 用法：npm run check:parsers
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = path.join(ROOT, 'spike', 'samples');

const { parseDocument, extOf } = await import('../packages/server/src/parser/index.ts');
const { chunkText } = await import('../packages/server/src/util/text.ts');

const files = ['sample.txt', 'sample.md', 'sample.csv', 'sample.docx', 'sample.xlsx', 'sample.pdf'];
let failures = 0;

for (const name of files) {
  const file = path.join(SAMPLES, name);
  if (!existsSync(file)) {
    console.log(`[SKIP] ${name}（样本不存在）`);
    continue;
  }
  try {
    const buf = readFileSync(file);
    const doc = await parseDocument({ buffer: buf, fileName: name, ext: extOf(name) });
    const chunks = chunkText(doc.text, { size: 400, overlap: 80 });
    const offsetsOk = chunks.every(
      (c) => doc.text.slice(c.charStart, c.charEnd) === c.content && c.charEnd > c.charStart,
    );
    console.log(
      `[OK]   ${name.padEnd(12)} chars=${String(doc.text.length).padStart(6)} ` +
        `chunks=${chunks.length} 偏移校验=${offsetsOk ? 'PASS' : 'FAIL'} title=${doc.title ?? '-'}`,
    );
    console.log(`       预览: ${doc.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    if (!offsetsOk) failures += 1;
  } catch (error) {
    const code = error?.code ?? 'ERR';
    const errno = error?.errNo ?? '-';
    console.log(`[FAIL] ${name.padEnd(12)} code=${code} errno=${errno} msg=${error?.message}`);
    failures += 1;
  }
}

// 空文本 / 扫描件 必须抛 40012
try {
  await parseDocument({ buffer: Buffer.from('   \n\t  '), fileName: 'empty.txt', ext: 'txt' });
  console.log('[FAIL] 空文本未抛错');
  failures += 1;
} catch (error) {
  const ok = error?.errNo === 40012;
  console.log(`[${ok ? 'OK' : 'FAIL'}] 空文本判 40012 -> errNo=${error?.errNo}`);
  if (!ok) failures += 1;
}

// 不支持类型必须抛 40011
try {
  await parseDocument({ buffer: Buffer.from('x'), fileName: 'a.exe', ext: 'exe' });
  console.log('[FAIL] 不支持类型未抛错');
  failures += 1;
} catch (error) {
  const ok = error?.errNo === 40011;
  console.log(`[${ok ? 'OK' : 'FAIL'}] 不支持类型判 40011 -> errNo=${error?.errNo}`);
  if (!ok) failures += 1;
}

console.log(failures === 0 ? '\n=== parsers ALL PASS ===' : `\n=== ${failures} FAILED ===`);
// 用 exitCode 而不是 process.exit()：管道下 console.log 是异步的，直接 exit 会丢输出
process.exitCode = failures === 0 ? 0 : 1;
