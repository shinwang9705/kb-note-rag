/**
 * 纯文本类解析：txt / md / markdown / csv / json / log
 *
 * 编码嗅探顺序：BOM(UTF-8/UTF-16) -> 严格 UTF-8 -> GB18030/GBK/Big5 -> latin1
 * 说明：Node 22 自带 full-icu，TextDecoder 可直接解 GBK，无需引入 iconv-lite。
 */
import { hasMeaningfulText, ParseError, type ParsedDocument } from './types.js';

export interface DecodeResult {
  text: string;
  encoding: string;
}

const GBK_CANDIDATES = ['gb18030', 'gbk', 'big5'] as const;

/** 嗅探并解码字节流 */
export function sniffDecode(buf: Buffer): DecodeResult {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }

  // 严格 UTF-8：非法字节会抛错，据此判断是否为 UTF-8
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    /* 不是 UTF-8，继续尝试中文编码 */
  }

  for (const enc of GBK_CANDIDATES) {
    try {
      return { text: new TextDecoder(enc).decode(buf), encoding: enc };
    } catch {
      /* 该编码不被当前运行时支持，换下一个 */
    }
  }

  return { text: buf.toString('latin1'), encoding: 'latin1' };
}

/** 去掉 ANSI 颜色转义序列（log 文件常见） */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

/** 归一化换行与空白，去掉行尾空格 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 极简 RFC4180 CSV 解析：返回按行拼接的文本（表头 + 每行一条） */
export function csvToText(input: string): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => r.map((cell) => cell.trim()).join(' | '))
    .join('\n');
}

/** JSON：解析失败则当成普通文本处理 */
export function jsonToText(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

/** 从文本首行推断标题（markdown 一级标题 / 普通首行） */
export function inferTitle(text: string, fallback: string | null): string | null {
  const firstLine = text.split('\n').find((line) => line.trim() !== '');
  if (!firstLine) return fallback;
  const cleaned = firstLine.replace(/^#+\s*/, '').trim().slice(0, 120);
  return cleaned || fallback;
}

/**
 * 解析纯文本类文件。
 * @param buf 文件字节
 * @param ext 小写扩展名（不含点）
 * @param fallbackTitle 兜底标题（一般用文件名）
 */
export async function parseTextLike(
  buf: Buffer,
  ext: string,
  fallbackTitle: string | null = null,
): Promise<ParsedDocument> {
  const { text: raw, encoding } = sniffDecode(buf);
  let text = normalizeText(stripAnsi(raw));

  switch (ext) {
    case 'csv':
      text = normalizeText(csvToText(text));
      break;
    case 'json':
      text = normalizeText(jsonToText(text));
      break;
    case 'md':
    case 'markdown':
    case 'txt':
    case 'log':
    default:
      break;
  }

  if (!hasMeaningfulText(text)) {
    throw ParseError.empty('文件内容为空');
  }

  return {
    text,
    title: inferTitle(text, fallbackTitle),
    encoding,
    meta: { charCount: text.length },
  };
}
