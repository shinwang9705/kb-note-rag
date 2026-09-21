/**
 * xlsx 解析：exceljs 逐 sheet、逐行抽取单元格文本。
 * 输出格式：每个 sheet 一行 `[sheet名]` 标题，随后每行单元格用 " | " 连接。
 */
import ExcelJS from 'exceljs';
import { hasMeaningfulText, ParseError, type ParsedDocument } from './types.js';
import { normalizeText } from './text.js';

/** 单元格值 -> 字符串（日期转为 ISO，公式取计算后的值） */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value && typeof (value as { text?: unknown }).text === 'string') {
      return (value as { text: string }).text;
    }
    if ('result' in value) return String((value as { result?: unknown }).result ?? '');
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export async function parseXlsx(
  buf: Buffer,
  fallbackTitle: string | null = null,
): Promise<ParsedDocument> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs 的 load 需要 ArrayBuffer 视图，这里转成 Uint8Array 保证类型一致
    await workbook.xlsx.load(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) as unknown as ArrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw ParseError.failed(`xlsx 解析失败：${message}`);
  }

  const chunks: string[] = [];
  const sheets: string[] = [];

  workbook.eachSheet((worksheet) => {
    sheets.push(worksheet.name);
    chunks.push(`[${worksheet.name}]`);
    worksheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellToString(cell.value).trim();
        if (text !== '') cells.push(text);
      });
      if (cells.length > 0) chunks.push(cells.join(' | '));
    });
  });

  const text = normalizeText(chunks.join('\n'));
  if (!hasMeaningfulText(text)) {
    throw ParseError.empty('xlsx 中没有可检索的文本（可能是空表）');
  }

  return {
    text,
    title: fallbackTitle,
    meta: { charCount: text.length, sheets, source: 'exceljs' },
  };
}
