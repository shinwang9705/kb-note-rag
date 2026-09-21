/**
 * 检索查询切词。
 *
 * 设计动机（实测结论驱动）：
 *   - FTS5 trigram 分词器最小 3 字符，**1-2 字中文查询命中恒为 0**，必须 LIKE 兜底
 *   - 中文没有空格，无法像英文那样按词切分；这里用「全量 2-gram」做召回，
 *     再用覆盖率打分，等价于一个粗糙但可用的中文倒排
 *   - 英文/数字按空白与标点切词，长度 >= 2 才参与
 */

/** CJK + 日文假名范围（与 shared 的 CJK_PATTERN 保持一致） */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/u;

/** 单个查询最多允许的检索词数量，防止长查询拼出超大 SQL */
export const MAX_QUERY_TOKENS = 12;

export interface QueryTokens {
  /** 原始查询（已 trim） */
  raw: string;
  /** 送给 FTS5 的短语（已转义并用双引号包裹）；无可用短语时为 null */
  ftsPhrase: string | null;
  /** 参与 LIKE 兜底与打分的检索词 */
  terms: string[];
  /** 是否包含 CJK */
  hasCjk: boolean;
}

/** 判断字符串是否含 CJK */
export function hasCjk(input: string): boolean {
  return CJK.test(input);
}

/** 切出 ASCII/数字词：小写化，去标点，长度 >= 2 */
function asciiTerms(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 从查询中切出检索词。
 * 中文：CJK 连续段取所有 2-gram（长度 1 时取单字）
 * 英文：按空白/标点切词
 */
export function tokenizeQuery(input: string): QueryTokens {
  const raw = (input ?? '').trim();
  const cjk = hasCjk(raw);
  const terms: string[] = [];

  // 按 CJK 与非 CJK 分段处理
  const segments: Array<{ text: string; cjk: boolean }> = [];
  let buffer = '';
  let bufferCjk = false;
  for (const ch of raw) {
    const isCjk = CJK.test(ch);
    if (buffer && isCjk !== bufferCjk) {
      segments.push({ text: buffer, cjk: bufferCjk });
      buffer = '';
    }
    bufferCjk = isCjk;
    buffer += ch;
  }
  if (buffer) segments.push({ text: buffer, cjk: bufferCjk });

  for (const seg of segments) {
    if (seg.cjk) {
      if (seg.text.length === 1) {
        terms.push(seg.text);
        continue;
      }
      // 优先长词：先放 3-gram 再放 2-gram，长词命中时打分权重更高
      for (let n = 3; n >= 2; n -= 1) {
        for (let i = 0; i + n <= seg.text.length; i += 1) {
          terms.push(seg.text.slice(i, i + n));
        }
      }
    } else {
      terms.push(...asciiTerms(seg.text));
    }
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  // 长词优先保留，避免被大量 2-gram 挤掉
  for (const t of terms.slice().sort((a, b) => b.length - a.length)) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= MAX_QUERY_TOKENS) break;
  }

  return {
    raw,
    ftsPhrase: buildFtsPhrase(raw),
    terms: unique,
    hasCjk: cjk,
  };
}

/**
 * 构造 FTS5 短语查询。
 * 用双引号包裹，内部 `"` 转义为 `""` —— 否则用户查询里的引号、冒号、星号
 * 会让 FTS5 抛 "fts5: syntax error near ..."。
 */
export function buildFtsPhrase(input: string): string | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  // trigram 需要至少 3 字符才有意义
  if ([...text].length < 3) return null;
  return `"${text.replace(/"/g, '""')}"`;
}

/** LIKE 参数转义：% 与 _ 是通配符，需 ESCAPE */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
