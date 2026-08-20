/**
 * Reciprocal Rank Fusion (RRF) merge utility.
 *
 * RRF is a simple yet effective method for merging multiple ranked lists.
 * Each item's RRF score is calculated as: 1 / (k + rank), where k is a constant.
 * Items appearing in multiple lists get their RRF scores summed.
 */

const RRF_K = 60;

export interface RrfItem {
  id: string;
  score: number;
}

/**
 * Merge multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param lists - Multiple ranked lists to merge
 * @returns Merged list sorted by descending RRF score, with score field updated
 */
export function rrfMerge<T extends RrfItem>(...lists: T[][]): T[] {
  const map = new Map<string, { item: T; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = map.get(item.id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(item.id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore }));
}
