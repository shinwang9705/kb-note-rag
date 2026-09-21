/**
 * multipart 测试辅助：手工拼装 multipart/form-data 请求体，供 app.inject 使用。
 *
 * 说明：本文件命名不以 *.test.ts 结尾，不会被 node --test 当作用例收集。
 * 与 scripts/check-search.mjs 里的 multipart 拼装思路一致，但此处针对 inject。
 */
import { randomBytes } from 'node:crypto';

export interface MultipartFile {
  /** 表单字段名（上传用 'file'） */
  field: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface MultipartField {
  name: string;
  value: string;
}

/** 拼装 multipart 请求体，返回可直接交给 app.inject 的 body 与 content-type */
export function buildMultipart(
  files: MultipartFile[],
  fields: MultipartField[] = [],
): { body: Buffer; contentType: string } {
  const boundary = `----kbqa${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];

  for (const f of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`,
      ),
    );
  }

  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(f.buffer);
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
