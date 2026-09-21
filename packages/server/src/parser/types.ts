/**
 * 文档解析公共类型与错误定义。
 */

/** 解析器统一输出 */
export interface ParsedDocument {
  /** 提取出的纯文本（已做基础清洗，供分块使用） */
  text: string;
  /** 从内容中推断出的标题（可为 null） */
  title: string | null;
  /** 源文本编码（纯文本类才有） */
  encoding?: string;
  /** 各解析器自带的附加信息（页数、sheet 名等） */
  meta?: Record<string, unknown>;
}

/**
 * 业务错误码（数字），与 HTTP 状态码解耦：
 *   40011 不支持的文件类型
 *   40012 文档无有效文本（扫描件 PDF / 空文件 / 纯图片 docx）
 *   40013 解析失败（文件损坏、格式不合法）
 */
export const PARSE_ERRNO = {
  UNSUPPORTED_TYPE: 40011,
  EMPTY_DOCUMENT: 40012,
  PARSE_FAILED: 40013,
} as const;

export class ParseError extends Error {
  readonly code: string;
  readonly errNo: number;
  readonly statusCode: number;

  constructor(code: string, message: string, errNo: number, statusCode = 400) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.errNo = errNo;
    this.statusCode = statusCode;
  }

  /** 文档无有效文本内容（扫描件 PDF、空文件等） */
  static empty(message = '文档中没有可检索的文本内容（可能是扫描件或纯图片）'): ParseError {
    return new ParseError('EMPTY_DOCUMENT', message, PARSE_ERRNO.EMPTY_DOCUMENT, 400);
  }

  static unsupported(message = '不支持的文件类型'): ParseError {
    return new ParseError('UNSUPPORTED_TYPE', message, PARSE_ERRNO.UNSUPPORTED_TYPE, 400);
  }

  static failed(message: string): ParseError {
    return new ParseError('PARSE_FAILED', message, PARSE_ERRNO.PARSE_FAILED, 400);
  }
}

/** 判定文本是否"有效"：去掉空白与控制字符后仍有内容 */
export function hasMeaningfulText(text: string | null | undefined, minLength = 1): boolean {
  if (!text) return false;
  const cleaned = text.replace(/\s+/gu, '').trim();
  return cleaned.length >= minLength;
}
