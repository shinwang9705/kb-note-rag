/**
 * 结构化轮次产物解析 + 标签分段三级降级（永不丢正文）。
 *
 * 模板输出：<outline>/<changes>/<score>/<has_further_improvement>/<draft>（XML-like）。
 * 三级降级链：
 *   完整解析 -> 缺 outline 置空 -> 缺 changes 按 outline 行级 diff -> 无 <draft> 整段作 draft。
 */
import type { ChangeItem, ChangeType, RoundArtifact, SelfScore } from '@kb/shared';
import { diffOutlines } from './diff.js';

const CHANGE_TYPES: readonly ChangeType[] = [
  'added',
  'removed',
  'reworded',
  'restructured',
  'evidence_added',
  'conclusion_changed',
];

function normalizeType(input: string | undefined): ChangeType {
  const value = (input ?? '').trim().toLowerCase();
  return (CHANGE_TYPES as readonly string[]).includes(value) ? (value as ChangeType) : 'added';
}

/** 提取 <tag>…</tag> 之间内容；缺失返回 null */
function extractBlock(text: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const startIdx = text.indexOf(open);
  if (startIdx < 0) return null;
  const contentStart = startIdx + open.length;
  const endIdx = text.indexOf(close, contentStart);
  if (endIdx < 0) return null;
  return text.slice(contentStart, endIdx);
}

function parseOutline(block: string): string[] {
  const items: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const clean = line.replace(/^[-*•\s\d.、]+/, '').trim();
    if (clean) items.push(clean);
  }
  return items;
}

function parseChanges(block: string): ChangeItem[] {
  const trimmed = block.trim();
  if (!trimmed) return [];

  // JSON 数组兜底
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ type?: string; target?: string; detail?: string }>;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => ({
            type: normalizeType(item.type),
            target: String(item.target ?? ''),
            detail: String(item.detail ?? ''),
          }))
          .filter((item) => item.target.length > 0);
      }
    } catch {
      /* 落到行解析 */
    }
  }

  const items: ChangeItem[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const clean = line.replace(/^[-*•\s]+/, '').trim();
    if (!clean) continue;
    const parts = clean.split('|').map((part) => part.trim());
    if (parts.length >= 2) {
      items.push({
        type: normalizeType(parts[0]),
        target: parts[1] ?? '',
        detail: parts.slice(2).join(' | '),
      });
    } else {
      items.push({ type: 'added', target: clean, detail: '' });
    }
  }
  return items.filter((item) => item.target.length > 0);
}

function parseScore(block: string | null): SelfScore | undefined {
  if (!block) return undefined;
  const read = (key: string): number | undefined => {
    const match = new RegExp(`${key}\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)`).exec(block);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : undefined;
  };
  const clarity = read('clarity');
  const coverage = read('coverage');
  const evidence = read('evidence');
  const concision = read('concision');
  if (clarity === undefined && coverage === undefined && evidence === undefined && concision === undefined) {
    return undefined;
  }
  return {
    clarity: clarity ?? 0,
    coverage: coverage ?? 0,
    evidence: evidence ?? 0,
    concision: concision ?? 0,
  };
}

function parseBool(block: string | null): boolean | null {
  if (!block) return null;
  const text = block.trim().toLowerCase();
  // 优先判定 false/否，避免把含 "是" 的文本误判为 true
  if (/(false|0|否|no)/.test(text)) return false;
  if (/(true|1|是|yes)/.test(text)) return true;
  return null;
}

export interface ParseArtifactOptions {
  runId: number;
  index: number;
  strategy: string;
  instruction: string;
  tokenIn: number;
  tokenOut: number;
  latencyMs: number;
  startedAt: string;
  endedAt: string | null;
  previousOutline?: string[];
}

/** 解析一轮产物；任何情况下都不丢正文（draft 兜底整段） */
export function parseArtifact(text: string, options: ParseArtifactOptions): RoundArtifact {
  const raw = (text ?? '').trim() || '';
  const outlineBlock = extractBlock(raw, 'outline');
  const changesBlock = extractBlock(raw, 'changes');
  const scoreBlock = extractBlock(raw, 'score');
  const hfiBlock = extractBlock(raw, 'has_further_improvement');
  const draftBlock = extractBlock(raw, 'draft');

  // 降级①：缺 outline -> 置空
  const outline = outlineBlock !== null ? parseOutline(outlineBlock) : [];

  // 降级②：缺 changes -> 基于 outline 行级 diff（有上一轮则 diff，首轮全 added）
  let changes = parseChanges(changesBlock ?? '');
  if (changesBlock === null) {
    changes =
      options.previousOutline && options.previousOutline.length > 0
        ? diffOutlines(options.previousOutline, outline)
        : outline.map((item) => ({ type: 'added' as const, target: item, detail: '新增要点' }));
  }

  // 降级③：无 <draft> -> 整段作 draft（永不丢正文）
  const draft = draftBlock !== null ? draftBlock.trim() : raw;

  return {
    runId: options.runId,
    index: options.index,
    strategy: options.strategy,
    instruction: options.instruction,
    draft,
    outline,
    changes,
    selfScore: parseScore(scoreBlock),
    hasFurtherImprovement: parseBool(hfiBlock) ?? true,
    status: 'done',
    tokenIn: options.tokenIn,
    tokenOut: options.tokenOut,
    latencyMs: options.latencyMs,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
  };
}
