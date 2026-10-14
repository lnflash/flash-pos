/**
 * The card's covering-ladder shape (ENG-700's canonical `targetPieces`) and
 * the change split that refills it (ENG-701's `splitChangeForLadder`).
 */
import {
  MAX_EXTRA_CHANGE_PIECES,
  SPARE_PIECES,
  compareLadderScore,
  exactReach,
  isChangeSplit,
  isCoveringLadder,
  ladderScore,
  multisetDistance,
  splitChangeForLadder,
  splitPow2,
  targetPieces,
} from '../../src/utils/denominations';

const vectors = require('../fixtures/card-shape-vectors.json') as {
  source: string;
  sparePieces: number[];
  vectors: {balance: number; slotsFree?: number; pieces: number[]}[];
};

const sum = (xs: readonly number[]) => xs.reduce((t, x) => t + x, 0);
const asc = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
const isPow2 = (n: number) => n > 0 && 2 ** Math.round(Math.log2(n)) === n;

/** `whole` less one of each of `taken`, as a multiset. */
const minus = (whole: readonly number[], taken: readonly number[]) => {
  const left = [...taken];
  return whole.filter(x => {
    const i = left.indexOf(x);
    if (i < 0) {
      return true;
    }
    left.splice(i, 1);
    return false;
  });
};

describe('targetPieces: the canonical card shape (shared with flash-mobile)', () => {
  it('names the flash-mobile commit the vectors were copied from', () => {
    expect(vectors.source).toMatch(/flash-mobile [0-9a-f]{9}/);
  });

  it('uses the same spares as the vectors', () => {
    expect([...SPARE_PIECES]).toEqual(vectors.sparePieces);
    expect([...SPARE_PIECES]).toEqual([1, 2, 4, 8]);
  });

  it.each(vectors.vectors.map(v => [v.balance, v.slotsFree, v.pieces]))(
    'balance %p in %p slots is the shared vector',
    (balance, slotsFree, pieces) => {
      expect(targetPieces(balance as number, slotsFree as number)).toEqual(
        pieces,
      );
    },
  );

  it('matches the plan’s and the architect’s examples', () => {
    expect(targetPieces(0)).toEqual([]);
    expect(targetPieces(1)).toEqual([1]);
    expect(targetPieces(3)).toEqual([1, 2]);
    expect(targetPieces(5)).toEqual([1, 1, 1, 2]);
    expect(targetPieces(6)).toEqual([1, 1, 2, 2]);
    expect(targetPieces(7)).toEqual([1, 2, 4]);
    expect(targetPieces(8)).toEqual([1, 1, 2, 4]);
    expect(targetPieces(10)).toEqual([1, 1, 2, 2, 4]);
    expect(targetPieces(60)).toEqual([1, 1, 2, 2, 2, 4, 4, 4, 8, 8, 8, 16]);
    expect(targetPieces(100)).toHaveLength(13);
    expect(targetPieces(1000)).toEqual([
      1, 1, 2, 2, 2, 4, 4, 8, 8, 8, 16, 16, 32, 64, 64, 128, 128, 256, 256,
    ]);
    expect(targetPieces(1_000_000)).toHaveLength(31);
  });

  it('is a covering ladder of the whole balance for every balance 0..5000', () => {
    for (let b = 0; b <= 5000; b++) {
      const pieces = targetPieces(b);
      expect(sum(pieces)).toBe(b);
      expect(pieces).toEqual(asc(pieces));
      expect(pieces.every(isPow2)).toBe(true);
      // Sorted ascending, every piece is at most 1 + the sum below it.
      let below = 0;
      for (const p of pieces) {
        expect(p).toBeLessThanOrEqual(below + 1);
        below += p;
      }
      expect(isCoveringLadder(pieces)).toBe(true);
    }
  });

  it('short of slots, never goes below the fewest pieces, and refuses fewer', () => {
    for (const b of [5, 60, 100, 1000, 4097]) {
      const fewest = splitPow2(b).length;
      for (let slots = fewest; slots <= 20; slots++) {
        const pieces = targetPieces(b, slots);
        expect(pieces.length).toBeLessThanOrEqual(slots);
        expect(sum(pieces)).toBe(b);
      }
      expect(targetPieces(b, fewest)).toEqual(asc(splitPow2(b)));
      expect(() => targetPieces(b, fewest - 1)).toThrow(RangeError);
    }
    expect(() => targetPieces(-1)).toThrow(RangeError);
    expect(() => targetPieces(1.5)).toThrow(RangeError);
  });
});

describe('exactReach / isCoveringLadder', () => {
  it('reaches every amount up to the sum only for a covering ladder', () => {
    expect(exactReach([1, 2, 4])).toBe(7);
    expect(isCoveringLadder([4, 2, 1])).toBe(true);
    expect(exactReach([1, 4])).toBe(1);
    expect(isCoveringLadder([1, 4])).toBe(false);
    expect(isCoveringLadder([2])).toBe(false);
    expect(isCoveringLadder([])).toBe(true);
  });
});

describe('ladderScore', () => {
  it('ranks a covering card before one that is not, then by distance from the shape', () => {
    expect(ladderScore([1, 2, 4])).toEqual([0, 0]);
    expect(ladderScore([1, 2, 2, 2])).toEqual([0, 3]);
    expect(ladderScore([1, 2, 8])[0]).toBe(1);
    expect(
      compareLadderScore(ladderScore([1, 2, 4]), ladderScore([1, 2, 2, 2])),
    ).toBeLessThan(0);
    expect(
      compareLadderScore(ladderScore([1, 2, 2, 2]), ladderScore([1, 4, 2])),
    ).toBeGreaterThan(0);
  });

  it('multisetDistance is the Manhattan distance of the amount counts', () => {
    expect(multisetDistance([1, 1, 2], [1, 2, 4])).toBe(2);
    expect(multisetDistance([], [1, 2])).toBe(2);
    expect(multisetDistance([4, 4], [4, 4])).toBe(0);
  });
});

describe('splitChangeForLadder: change that refills the card (ENG-701)', () => {
  /** Every card of up to `n` pieces from `amounts`, as multisets. */
  const cards = (amounts: number[], n: number): number[][] => {
    const out: number[][] = [[]];
    const grow = (from: number, card: number[]) => {
      if (card.length === n) {
        return;
      }
      for (let i = from; i < amounts.length; i++) {
        const next = [...card, amounts[i]];
        out.push(next);
        grow(i, next);
      }
    };
    grow(0, []);
    return out;
  };

  it('splits 8 − 3 into the ladder of 5, largest first', () => {
    expect(splitChangeForLadder(5, [])).toEqual([2, 1, 1, 1]);
    expect(splitChangeForLadder(0, [])).toEqual([]);
  });

  it('fills the gaps beside what the card keeps: 16 pays 10 beside a 4', () => {
    // [4] kept + [2, 2, 1, 1] = [1, 1, 2, 2, 4], the shape of 10.
    expect(splitChangeForLadder(6, [4])).toEqual([2, 2, 1, 1]);
    expect(asc([4, ...splitChangeForLadder(6, [4])])).toEqual(targetPieces(10));
  });

  it('within the cap, degrades the shape rather than giving up on it', () => {
    expect(splitChangeForLadder(5, [], 3)).toEqual([2, 2, 1]);
    expect(isCoveringLadder([2, 2, 1])).toBe(true);
  });

  it('with no room past the fewest pieces, is splitPow2', () => {
    expect(splitChangeForLadder(5, [], 2)).toEqual(splitPow2(5));
    expect(splitChangeForLadder(6, [4], 2)).toEqual(splitPow2(6));
    // Fewer slots than even the fewest pieces: the caller's fit test refuses
    // that plan, and the split is still the fewest.
    expect(splitChangeForLadder(7, [], 1)).toEqual(splitPow2(7));
  });

  it('is never more than the fewest pieces plus the bound (decision 3)', () => {
    // 156 = 128 + 16 + 8 + 4; its full shape is 14 pieces.
    const pieces = splitChangeForLadder(156, []);
    expect(pieces.length).toBeLessThanOrEqual(4 + MAX_EXTRA_CHANGE_PIECES);
    expect(sum(pieces)).toBe(156);
  });

  it('for every small card and change: sums to the change in powers of two, within the cap, never worse than splitPow2, and reaches the target when it fits', () => {
    for (const keep of cards([1, 2, 4, 8, 16], 4)) {
      for (let change = 1; change <= 40; change++) {
        const pow2 = splitPow2(change);
        for (const cap of [Infinity, pow2.length, pow2.length + 1, 5]) {
          const pieces = splitChangeForLadder(change, keep, cap);
          expect(sum(pieces)).toBe(change);
          expect(pieces.every(isPow2)).toBe(true);
          expect(isChangeSplit(pieces, change)).toBe(true);
          expect(pieces).toEqual([...pieces].sort((a, b) => b - a));
          const limit = Math.min(cap, pow2.length + MAX_EXTRA_CHANGE_PIECES);
          if (limit >= pow2.length) {
            expect(pieces.length).toBeLessThanOrEqual(limit);
          }
          if (cap === pow2.length) {
            expect(pieces).toEqual(pow2);
          }
          expect(
            compareLadderScore(
              ladderScore([...keep, ...pieces]),
              ladderScore([...keep, ...pow2]),
            ),
          ).toBeLessThanOrEqual(0);
          // Where the card's whole shape is reachable with this change, in
          // the room there is, the change is exactly the missing pieces.
          const needed = minus(targetPieces(sum(keep) + change), keep);
          if (
            sum(needed) === change &&
            needed.length <= limit &&
            minus(keep, targetPieces(sum(keep) + change)).length === 0
          ) {
            expect(asc(pieces)).toEqual(asc(needed));
          }
        }
      }
    }
  });
});

describe('isChangeSplit', () => {
  it('accepts powers of two summing to the change, and nothing else', () => {
    expect(isChangeSplit([2, 2, 1], 5)).toBe(true);
    expect(isChangeSplit([], 0)).toBe(true);
    expect(isChangeSplit([4, 2], 5)).toBe(false);
    expect(isChangeSplit([3, 2], 5)).toBe(false);
    expect(isChangeSplit([1], 0)).toBe(false);
  });
});
