/**
 * pdf 解析：pdf-parse 抽取文本层。
 *
 * 关键：扫描件（只有图片、无文本层）会得到空字符串，必须显式判空并返回 40012，
 * 否则会产生"导入成功但永远搜不到"的幽灵文档。
 *
 * 注意（实测）：
 *   1. 必须走 `pdf-parse/lib/pdf-parse.js` 这个子入口。
 *      v1.1.1 的包根 index.js 有 `if (!module.parent)` 自测分支，在 tsx / ESM-CJS 互操作下
 *      module.parent 为空，会去读自带的 test/data/05-versions-space.pdf 并抛 ENOENT。
 *   2. 不要 `node pdf.js` 直接运行它（同样会走自测分支）。
 *   3. **必须传独立的 Uint8Array，不能直接传 Buffer**。
 *      Node 的小 Buffer（<4KB 走 8KB 共享池）byteOffset 非 0，而 pdf-parse 内部按
 *      底层 ArrayBuffer 从头读取、忽略 byteOffset，于是读到池里的其他数据：
 *      症状是随机的 `bad XRef entry`，或 `getTextContent - ignoring errors` 后返回空文本。
 *      实测同一份 PDF 字节完全相同，byteOffset=0 正常、byteOffset=5416 直接报 bad XRef entry。
 */
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { hasMeaningfulText, ParseError, type ParsedDocument } from './types.js';
import { inferTitle, normalizeText } from './text.js';

/** 复制出一份独占底层 ArrayBuffer 的字节视图，规避 Node Buffer 共享池偏移问题 */
function toStandaloneBytes(buf: Buffer): Uint8Array {
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

export async function parsePdf(
  buf: Buffer,
  fallbackTitle: string | null = null,
): Promise<ParsedDocument> {
  let raw: string;
  let pageCount = 0;
  try {
    const result = await pdfParse(toStandaloneBytes(buf));
    raw = result.text ?? '';
    pageCount = Number(result.numpages ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw ParseError.failed(`pdf 解析失败：${message}`);
  }

  const text = normalizeText(raw);
  if (!hasMeaningfulText(text)) {
    throw ParseError.empty('PDF 没有文本层，可能是扫描件，请先做 OCR');
  }

  return {
    text,
    title: inferTitle(text, fallbackTitle),
    meta: { charCount: text.length, pageCount, source: 'pdf-parse' },
  };
}
