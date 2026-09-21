/**
 * docx 解析：mammoth 提取纯文本。
 * 注意 mammoth 只取文本，图片/表格中的文字也会尽量抽出；纯图片 docx 会得到空文本 -> 判 40012。
 */
import mammoth from 'mammoth';
import { hasMeaningfulText, ParseError, type ParsedDocument } from './types.js';
import { inferTitle, normalizeText } from './text.js';

export async function parseDocx(
  buf: Buffer,
  fallbackTitle: string | null = null,
): Promise<ParsedDocument> {
  let raw: string;
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    raw = result.value ?? '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw ParseError.failed(`docx 解析失败：${message}`);
  }

  const text = normalizeText(raw);
  if (!hasMeaningfulText(text)) {
    throw ParseError.empty('docx 中没有可检索的文本（可能是纯图片文档）');
  }

  return {
    text,
    title: inferTitle(text, fallbackTitle),
    meta: { charCount: text.length, source: 'mammoth' },
  };
}
