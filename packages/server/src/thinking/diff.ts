/**
 * 两轮要点结构化 diff（手写，零依赖）。
 *
 * 用途：
 *   1. 早停判定：jaccard(outline_n, outline_{n-1}) ≥ diffConvergeThreshold；
 *   2. 产物解析三级降级之一：缺 <changes> 时按 outline 行级 diff 反推 ChangeItem。
 */
import type { ChangeItem } from '@kb/shared';

/** 规范化一条 outline 要点（去空白/标点差异，避免 diff 被空格干扰） */
function normalizeItem(input: string): string {
  return input.replace(/^[-*•\s]+/, '').replace(/\s+/g, ' ').trim();
}

/** 两列表的 Jaccard 相似度（基于规范化要点集合），范围 0..1 */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.map(normalizeItem).filter(Boolean));
  const setB = new Set(b.map(normalizeItem).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * 由前后两轮 outline 反推结构化差异（缺 <changes> 时的降级）。
 *   - 新增 -> added；消失 -> removed；
 *   - 两侧都有但措辞变化 -> reworded（简单启发）。
 */
export function diffOutlines(previous: readonly string[], next: readonly string[]): ChangeItem[] {
  const prev = new Map<string, string>();
  for (const item of previous) prev.set(normalizeItem(item), item);

  const nextSet = new Set<string>();
  const nextRaw = new Map<string, string>();
  for (const item of next) {
    const key = normalizeItem(item);
    nextSet.add(key);
    nextRaw.set(key, item);
  }

  const changes: ChangeItem[] = [];
  for (const key of nextSet) {
    if (!prev.has(key)) {
      changes.push({ type: 'added', target: nextRaw.get(key) ?? key, detail: '新增要点' });
    } else if (prev.get(key) !== nextRaw.get(key)) {
      changes.push({ type: 'reworded', target: nextRaw.get(key) ?? key, detail: '措辞调整' });
    }
  }
  for (const [key, raw] of prev) {
    if (!nextSet.has(key)) {
      changes.push({ type: 'removed', target: raw, detail: '要点移除' });
    }
  }
  return changes;
}
