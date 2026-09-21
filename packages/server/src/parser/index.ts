/**
 * 解析器分派：按扩展名路由到具体解析器。
 */
import { ALLOWED_EXTENSIONS } from '@kb/shared';
import { ParseError, type ParsedDocument } from './types.js';
import { parseTextLike } from './text.js';
import { parseDocx } from './docx.js';
import { parseXlsx } from './xlsx.js';
import { parsePdf } from './pdf.js';

export interface ParseInput {
  buffer: Buffer;
  /** 原始文件名（用于兜底标题与扩展名推断） */
  fileName: string;
  /** 小写扩展名（不含点）；缺省时从 fileName 推断 */
  ext?: string;
}

/** 从文件名取小写扩展名（不含点） */
export function extOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx < 0) return '';
  return fileName.slice(idx + 1).toLowerCase();
}

/** 是否为受支持的扩展名 */
export function isSupportedExt(ext: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * 按扩展名解析文档。
 * @throws ParseError —— 40011 不支持类型 / 40012 无有效文本 / 40013 解析失败
 */
export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  const ext = (input.ext ?? extOf(input.fileName)).toLowerCase();

  if (!isSupportedExt(ext)) {
    throw ParseError.unsupported(`不支持的文件类型：${ext || '(无扩展名)'}`);
  }

  switch (ext) {
    case 'docx':
      return parseDocx(input.buffer, input.fileName);
    case 'xlsx':
      return parseXlsx(input.buffer, input.fileName);
    case 'pdf':
      return parsePdf(input.buffer, input.fileName);
    case 'txt':
    case 'md':
    case 'markdown':
    case 'csv':
    case 'json':
    case 'log':
      return parseTextLike(input.buffer, ext, input.fileName);
    default:
      throw ParseError.unsupported(`不支持的文件类型：${ext}`);
  }
}

export { ParseError } from './types.js';
export { PARSE_ERRNO } from './types.js';
export type { ParsedDocument } from './types.js';
