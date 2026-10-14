/**
 * Greedy power-of-two decomposition (4 → [4]; 6 → [4,2]; 7 → [4,2,1]),
 * largest first. The mint mints change in exactly these pieces and the card
 * receives them in this order, so the charge screen animates one slip per
 * piece from the same function.
 */
export function splitPow2(amountSat: number): number[] {
  const pieces: number[] = [];
  let remaining = amountSat;
  let denom = 1;
  while (denom * 2 <= remaining) {
    denom *= 2;
  }
  while (remaining > 0) {
    if (denom <= remaining) {
      pieces.push(denom);
      remaining -= denom;
    } else {
      denom = Math.floor(denom / 2);
    }
  }
  return pieces;
}

/** How many card slots `sat` of change takes: one per power-of-two piece. */
export const pow2PieceCount = (sat: number): number =>
  sat > 0 ? splitPow2(sat).length : 0;

/**
 * The shape of the value on a Cashu card (ENG-700, ENG-701): which
 * denominations its pieces come in.
 *
 * Offline, a till takes whole pieces off a card and gives no change, so a
 * card pays a bill exactly only when some of its pieces add up to it. The
 * fewest powers of two (`splitPow2`) make a 60-sat card 32+16+8+4, which pays
 * exactly only multiples of 4. A card shaped as a covering ladder pays every
 * amount from 1 to its balance: sorted ascending, each piece is at most one
 * more than the sum of the pieces below it.
 *
 * `targetPieces` is the canonical shape, the same in flash-mobile (ENG-700),
 * flash-pos (ENG-701) and the card reshape (ENG-702), transcribed from
 * flash-mobile's `app/utils/cashu-card-shape.ts`. Both repos assert the same
 * vectors (`__tests__/fixtures/card-shape-vectors.json`): a till and a wallet
 * that disagreed on the shape would break exact offline payment without any
 * error.
 */

/** Slots on a 2.0 card (cashuCard.ts `MAX_SLOTS`). */
const CARD_SLOTS = 128;

/**
 * The spares a shaped card carries beside its ladder, added in this order
 * while each still fits, and stopping at the first that does not.
 */
export const SPARE_PIECES: readonly number[] = [1, 2, 4, 8];

/**
 * A charge's change is at most this many pieces more than the fewest
 * (`splitPow2`): each extra piece is one more SPEND_ALL_CHANGE and LOAD in
 * the tap (architect's decision 3).
 */
export const MAX_EXTRA_CHANGE_PIECES = 3;

const sum = (pieces: readonly number[]): number =>
  pieces.reduce((a, b) => a + b, 0);

const ascending = (pieces: readonly number[]): number[] =>
  [...pieces].sort((a, b) => a - b);

const isPow2 = (n: number): boolean =>
  Number.isSafeInteger(n) && n > 0 && 2 ** Math.round(Math.log2(n)) === n;

/**
 * The largest R such that every amount from 1 to R is the sum of some of
 * `pieces`, by the greedy covering test: sorted ascending, the reach grows by
 * each piece that is at most one more than the reach so far, and stops at the
 * first that is not.
 */
export function exactReach(pieces: readonly number[]): number {
  let reach = 0;
  for (const piece of ascending(pieces)) {
    if (piece > reach + 1) {
      break;
    }
    reach += piece;
  }
  return reach;
}

/**
 * The covering-ladder invariant: sorted ascending, every piece is at most 1 +
 * the sum of the smaller ones, so every amount from 1 to the pieces' sum pays
 * exactly with some of them. Empty pieces cover (nothing to pay).
 */
export const isCoveringLadder = (pieces: readonly number[]): boolean =>
  exactReach(pieces) === sum(pieces);

/**
 * One candidate shape: the ladder 1..2^k (none for k = −1), up to
 * `spareCount` of `SPARE_PIECES` (each at most 2^k and what is left, stopping
 * at the first that is not), and the fewest powers of two for the rest.
 */
function candidate(balance: number, k: number, spareCount: number): number[] {
  const pieces: number[] = [];
  const top = k < 0 ? 0 : 2 ** k;
  for (let piece = 1; piece <= top; piece *= 2) {
    pieces.push(piece);
  }
  let left = balance - sum(pieces);
  for (const spare of SPARE_PIECES.slice(0, spareCount)) {
    if (spare > left || spare > top) {
      break;
    }
    pieces.push(spare);
    left -= spare;
  }
  if (left > 0) {
    pieces.push(...splitPow2(left));
  }
  return ascending(pieces);
}

/**
 * The canonical shape of a card holding `balance`, in at most `slotsFree`
 * pieces, sorted ascending. `[]` for a balance of 0.
 *
 * With the room for it: the largest ladder 1, 2, 4, …, 2^k the balance can
 * hold (2^(k+1) − 1 ≤ balance), then the spares (`SPARE_PIECES`), then the
 * rest as the fewest powers of two, each at most 2^k.
 *
 * Short of slots it degrades, keeping what pays the most amounts longest: the
 * remainder coarsens, then the spares go (last first), then the top of the
 * ladder, never below the fewest-pieces split (`splitPow2`). Throws
 * `RangeError` for a balance that is not a non-negative safe integer, or
 * room for fewer pieces than that split.
 */
export function targetPieces(
  balance: number,
  slotsFree: number = CARD_SLOTS,
): number[] {
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new RangeError(
      `targetPieces: balance must be a non-negative integer, got ${balance}`,
    );
  }
  if (balance === 0) {
    return [];
  }
  const fewest = splitPow2(balance).length;
  if (!Number.isSafeInteger(slotsFree) || slotsFree < fewest) {
    throw new RangeError(
      `targetPieces: ${balance} takes at least ${fewest} pieces, ${slotsFree} free`,
    );
  }
  // The largest k with 2^(k+1) − 1 <= balance.
  let kMax = 0;
  while (2 ** (kMax + 2) - 1 <= balance) {
    kMax += 1;
  }
  for (let k = kMax; k >= -1; k -= 1) {
    for (
      let spareCount = SPARE_PIECES.length;
      spareCount >= 0;
      spareCount -= 1
    ) {
      const pieces = candidate(balance, k, spareCount);
      if (pieces.length <= slotsFree) {
        return pieces;
      }
    }
  }
  // Unreachable: k = −1 with no spares is splitPow2(balance), which fits.
  throw new RangeError(
    `targetPieces: no shape of ${balance} in ${slotsFree} slots`,
  );
}

/** `whole` less one of each of `taken`, as a multiset. */
function without(whole: readonly number[], taken: readonly number[]): number[] {
  const left = new Map<number, number>();
  taken.forEach(piece => left.set(piece, (left.get(piece) ?? 0) + 1));
  return whole.filter(piece => {
    const count = left.get(piece) ?? 0;
    if (count === 0) {
      return true;
    }
    left.set(piece, count - 1);
    return false;
  });
}

/**
 * The Manhattan distance between two multisets of amounts: over every
 * amount, the difference in how many times each holds it.
 */
export function multisetDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  return without(a, b).length + without(b, a).length;
}

/**
 * How far `pieces` (a whole card) are from its canonical shape, lower is
 * better, compared with `compareLadderScore`: first whether they cover every
 * amount (0) or not (1), then their distance from `targetPieces` of their sum.
 */
export type LadderScore = readonly [number, number];

export function ladderScore(pieces: readonly number[]): LadderScore {
  return [
    isCoveringLadder(pieces) ? 0 : 1,
    multisetDistance(pieces, targetPieces(sum(pieces))),
  ];
}

/** Lexicographic: negative when `a` is the better (lower) score. */
export const compareLadderScore = (a: LadderScore, b: LadderScore): number =>
  a[0] - b[0] || a[1] - b[1];

/**
 * The gap-filling split (as flash-mobile's top-up `complement`): the pieces
 * of the whole card's target shape the card lacks, smallest first while each
 * fits what is left of the change and the slots, and the fewest powers of
 * two for the rest. Undefined when that does not fit `slots`.
 */
function fillGaps(
  changeSat: number,
  keep: readonly number[],
  slots: number,
): number[] | undefined {
  let target: number[];
  try {
    target = targetPieces(sum(keep) + changeSat, keep.length + slots);
  } catch {
    return undefined;
  }
  const pieces: number[] = [];
  let left = changeSat;
  for (const piece of ascending(without(target, keep))) {
    if (piece > left || pieces.length >= slots) {
      break;
    }
    pieces.push(piece);
    left -= piece;
  }
  if (left > 0) {
    pieces.push(...splitPow2(left));
  }
  return pieces.length <= slots ? pieces : undefined;
}

/**
 * The gaps of the card's uncapped target shape filled (smallest first, the
 * rest as the fewest powers of two), then the smallest equal pair merged
 * while there are more pieces than `slots`. Merging two equal powers of two
 * makes one, and a split with no equal pair is `splitPow2`'s, so this always
 * reaches the fewest pieces when it must.
 */
function fillGapsMerged(
  changeSat: number,
  keep: readonly number[],
  slots: number,
): number[] | undefined {
  const needed = without(targetPieces(sum(keep) + changeSat), keep);
  const pieces: number[] = [];
  let left = changeSat;
  for (const piece of ascending(needed)) {
    if (piece > left) {
      break;
    }
    pieces.push(piece);
    left -= piece;
  }
  if (left > 0) {
    pieces.push(...splitPow2(left));
  }
  let merged = ascending(pieces);
  while (merged.length > slots) {
    const i = merged.findIndex((p, j) => j > 0 && merged[j - 1] === p);
    if (i < 0) {
      return undefined;
    }
    merged = ascending([
      ...merged.slice(0, i - 1),
      merged[i] * 2,
      ...merged.slice(i + 1),
    ]);
  }
  return merged;
}

/**
 * How a charge's change of `changeSat` comes back to a card that keeps
 * `keep` (its unspent pieces less the ones the charge burns), as at most
 * `maxPieces` power-of-two pieces, largest first (the order the card
 * receives them).
 *
 * The change refills the card's covering ladder (ENG-701): of the splits that
 * fit — the gaps of the card's target shape filled within the slots, and the
 * gaps of the full target filled and merged down to them — the one whose card
 * afterwards scores best (`ladderScore`) wins, and wins over `splitPow2` only
 * when it scores strictly better, so the result is never further from the
 * shape than today's. At most `MAX_EXTRA_CHANGE_PIECES` more pieces than
 * `splitPow2`; when nothing better fits, `splitPow2`. Pure.
 */
export function splitChangeForLadder(
  changeSat: number,
  keep: readonly number[],
  maxPieces: number = Infinity,
): number[] {
  if (changeSat <= 0) {
    return [];
  }
  const pow2 = splitPow2(changeSat);
  const cap = Math.min(maxPieces, pow2.length + MAX_EXTRA_CHANGE_PIECES);
  if (cap <= pow2.length) {
    return pow2;
  }
  const scored = (pieces: number[]) => ({
    pieces,
    score: ladderScore([...keep, ...pieces]),
  });
  let best = scored(pow2);
  for (const pieces of [
    fillGaps(changeSat, keep, cap),
    fillGapsMerged(changeSat, keep, cap),
  ]) {
    if (!pieces) {
      continue;
    }
    const next = scored(pieces);
    const cmp = compareLadderScore(next.score, best.score);
    if (cmp < 0 || (cmp === 0 && pieces.length < best.pieces.length)) {
      best = next;
    }
  }
  const out = ascending(best.pieces).reverse();
  if (sum(out) !== changeSat || out.length > cap || !out.every(isPow2)) {
    throw new Error(
      `splitChangeForLadder: [${out.join(
        ',',
      )}] is not ${changeSat} sat in at most ${cap} power-of-two pieces`,
    );
  }
  return out;
}

/** Every piece a power of two and the pieces summing to `changeSat`. */
export const isChangeSplit = (
  pieces: readonly number[],
  changeSat: number,
): boolean => pieces.every(isPow2) && sum(pieces) === Math.max(0, changeSat);
