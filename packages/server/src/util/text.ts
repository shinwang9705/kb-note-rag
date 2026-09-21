/**
 * 文本工具：分块、HTML 清洗、中文判定。
 *
 * 分块契约（下批检索依赖）：
 *   - 窗口默认 400 字、重叠 80 字（由 config.chunk 注入，见 CHUNK_SIZE / CHUNK_OVERLAP）
 *   - 每个块必须带 charStart / charEnd，是相对**原文**的字符偏移，用于高亮定位与引用回溯
 *   - 优先在句读（。！？；\n）处切分，避免把句子拦腰截断
 *   - 若整段不足一个窗口，则整段作为一个块
 */
import { CJK_PATTERN } from '@kb/shared';

export interface TextChunk {
  seq: number;
  content: string;
  /** 在原文中的起始字符偏移（含） */
  charStart: number;
  /** 在原文中的结束字符偏移（不含） */
  charEnd: number;
  /** 章节路径（如「一、概述 > 1.2 架构」）；无标题时为 undefined */
  sectionPath?: string;
}

export interface ChunkOptions {
  /** 窗口字符数 */
  size?: number;
  /** 重叠字符数，必须小于 size */
  overlap?: number;
}

const DEFAULT_SIZE = 700;
const DEFAULT_OVERLAP = 80;

/** 句读与换行优先切分点 */
const SENTENCE_END = /[。！？；!?;\n]/u;

/**
 * 把长文本切成带偏移的块。
 * @param text 原文（调用前请自行 normalize）
 * @param options 窗口与重叠
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const size = Math.max(1, Math.trunc(options.size ?? DEFAULT_SIZE));
  const overlap = Math.min(Math.max(0, Math.trunc(options.overlap ?? DEFAULT_OVERLAP)), size - 1);
  const source = text ?? '';
  const total = source.length;

  if (total === 0) return [];
  if (total <= size) {
    return [{ seq: 0, content: source, charStart: 0, charEnd: total }];
  }

  const chunks: TextChunk[] = [];
  const step = size - overlap;
  let start = 0;
  let seq = 0;

  while (start < total) {
    let end = Math.min(start + size, total);

    // 不在文末时，尽量回退到最近的句读处，避免切断句子
    if (end < total) {
      const window = source.slice(start, end);
      let breakAt = -1;
      for (let i = window.length - 1; i >= Math.floor(window.length * 0.6); i -= 1) {
        if (SENTENCE_END.test(window[i] ?? '')) {
          breakAt = i + 1;
          break;
        }
      }
      if (breakAt > 0) end = start + breakAt;
    }

    const content = source.slice(start, end);
    if (content.trim().length > 0) {
      chunks.push({ seq, content, charStart: start, charEnd: end });
      seq += 1;
    }

    if (end >= total) break;
    start = end - overlap > start ? end - overlap : end;
    // 防御：step 退化时强制前进，避免死循环
    if (start >= end) start = end;
    void step;
  }

  return chunks;
}

/** 按换行切行，并记录每行在原文中的字符偏移（不含末尾换行符） */
function splitLines(source: string): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      lines.push({ text: source.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  if (start < source.length) {
    lines.push({ text: source.slice(start), start, end: source.length });
  }
  return lines;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;

/**
 * 结构感知分块：先按 Markdown 标题（\n#{1,6} ）与空行做「标题/段落优先」切割，
 * 维护标题栈得到章节路径（sectionPath），超长段落再走窗口 + 句读二次切。
 *
 * 与 chunkText 的差异：段落边界不再被拦腰截断，且每个块携带其所属章节路径，
 * 供检索 / 引用 / 原文溯源展示「文档名 > 章节路径 > 片段」。
 *
 * @param text 原文（调用前请自行 normalize）
 * @param options 窗口与重叠（透传给二次切的 chunkText）
 */
export function chunkTextStructured(text: string, options: ChunkOptions = {}): TextChunk[] {
  const source = text ?? '';
  const total = source.length;
  if (total === 0) return [];

  const size = Math.max(1, Math.trunc(options.size ?? DEFAULT_SIZE));
  const overlap = Math.min(Math.max(0, Math.trunc(options.overlap ?? DEFAULT_OVERLAP)), size - 1);

  // 段落：{ start, end, path }，end 为段落正文结束（不含末尾空行/换行）
  interface Paragraph {
    start: number;
    end: number;
    path: string;
  }

  const paragraphs: Paragraph[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let currentPath = '';
  let paraStart = -1;
  let paraEnd = -1;

  const flush = (): void => {
    if (paraStart >= 0 && paraEnd > paraStart) {
      paragraphs.push({ start: paraStart, end: paraEnd, path: currentPath });
    }
    paraStart = -1;
    paraEnd = -1;
  };

  for (const line of splitLines(source)) {
    const heading = HEADING_RE.exec(line.text);
    if (heading) {
      // 标题 = 段落边界 + 更新标题栈
      flush();
      const level = (heading[1] ?? '').length;
      const title = (heading[2] ?? '').trim();
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
        stack.pop();
      }
      stack.push({ level, title });
      currentPath = stack
        .map((entry) => entry.title)
        .filter((entry) => entry.length > 0)
        .join(' > ');
      continue;
    }

    if (line.text.trim() === '') {
      // 空行 = 段落边界
      flush();
      continue;
    }

    // 普通行并入当前段落
    if (paraStart < 0) paraStart = line.start;
    paraEnd = line.end;
  }
  flush();

  // 超长段落二次切：复用 chunkText 的窗口 + 句读回退，偏移回映射到原文
  const chunks: TextChunk[] = [];
  let seq = 0;
  for (const paragraph of paragraphs) {
    const sub = source.slice(paragraph.start, paragraph.end);
    for (const part of chunkText(sub, { size, overlap })) {
      chunks.push({
        seq,
        content: part.content,
        charStart: paragraph.start + part.charStart,
        charEnd: paragraph.start + part.charEnd,
        ...(paragraph.path.length > 0 ? { sectionPath: paragraph.path } : {}),
      });
      seq += 1;
    }
  }

  return chunks;
}

/** 去除 HTML 标签与实体，得到纯文本 */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 是否包含中日韩字符 */
export function hasCJK(input: string): boolean {
  return CJK_PATTERN.test(input);
}

/** 粗略判断"是否纯 ASCII 词"（决定是否走 FTS 的 ASCII 路径） */
export function isAsciiToken(input: string): boolean {
  return /^[\x20-\x7e]+$/.test(input);
}

/** 截取摘要（用于列表展示，不带 HTML） */
export function excerpt(input: string, maxLength = 120): string {
  const flat = input.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength)}…`;
}
