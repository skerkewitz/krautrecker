/**
 * Keeps the song loop point (`Project.loopOrderIndex`) on the same order entry while the order
 * list is edited. Loop point 0 means "loop the whole song" and stays 0 whatever the edit.
 */

/** An entry was inserted at index `at`. */
export function loopAfterInsert(loop: number, at: number): number {
  return loop > 0 && at <= loop ? loop + 1 : loop;
}

/**
 * Entries were removed; `kept[i]` says whether old entry i survived. If the loop entry itself
 * was removed, the loop point moves to the entry that took its place.
 */
export function loopAfterRemove(loop: number, kept: readonly boolean[]): number {
  if (loop <= 0) return 0;
  let before = 0;
  for (let i = 0; i < loop && i < kept.length; i++) if (kept[i]) before++;
  const remaining = kept.filter(Boolean).length;
  return Math.max(0, Math.min(before, remaining - 1));
}

/** Entries `i` and `j` swapped places. */
export function loopAfterSwap(loop: number, i: number, j: number): number {
  if (loop <= 0) return loop;
  return loop === i ? j : loop === j ? i : loop;
}
