import { describe, expect, it } from 'vitest';
import { loopAfterInsert, loopAfterRemove, loopAfterSwap } from './orderEdit';

describe('loop point follows order list edits', () => {
  it('inserting before or at the loop entry shifts it', () => {
    expect(loopAfterInsert(2, 1)).toBe(3);
    expect(loopAfterInsert(2, 2)).toBe(3);
    expect(loopAfterInsert(2, 3)).toBe(2);
  });

  it('removing entries before the loop entry shifts it back', () => {
    expect(loopAfterRemove(3, [true, false, true, true, true])).toBe(2);
    expect(loopAfterRemove(3, [true, true, true, true, false])).toBe(3);
  });

  it('removing the loop entry moves the loop point to the entry that took its place', () => {
    expect(loopAfterRemove(2, [true, true, false, true])).toBe(2);
    expect(loopAfterRemove(3, [true, true, true, false])).toBe(2);
  });

  it('swapping entries carries the loop point along', () => {
    expect(loopAfterSwap(2, 2, 3)).toBe(3);
    expect(loopAfterSwap(3, 2, 3)).toBe(2);
    expect(loopAfterSwap(1, 2, 3)).toBe(1);
  });

  it('loop point 0 (the whole song) stays 0', () => {
    expect(loopAfterInsert(0, 0)).toBe(0);
    expect(loopAfterRemove(0, [false, true])).toBe(0);
    expect(loopAfterSwap(0, 0, 1)).toBe(0);
  });
});
