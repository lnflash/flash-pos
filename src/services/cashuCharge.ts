/**
 * Model B charging on a 2.0 card: the merchant enters an amount, the customer
 * taps, the card pays with ONE signature and makes its own change.
 *
 * Protocol 2.0 (NUT-11 SIG_ALL) signs the swap's OUTPUTS with its inputs, so
 * everything the swap will produce exists before the card signs: the
 * merchant's outputs are blinded here (`prepareChargeOutputs`) and the
 * customer's change is made by the card itself (SPEND_ALL_CHANGE — locked to
 * its own key, its opening kept on the card). The swap then settles the
 * payment and the mint's signatures on the change are finished from the
 * card's openings (GET_CHANGE) and loaded back (LOAD_PROOF with the mint's
 * DLEQ).
 *
 * Ordering guarantees:
 *   - the PIN gate runs before anything: verify in-session first, so a wrong
 *     PIN never burns a piece. A card whose no-PIN allowance covers the bill
 *     is not asked for its PIN (decision 11); if the card disagrees at SIGN
 *     (`6A94`) nothing is burned and the PIN is asked for;
 *   - the plan is computed BEFORE anything burns — a plan whose change the
 *     card has no room for, or that is over the card's daily limit, is
 *     refused up front rather than stranding the customer mid-transaction;
 *   - the change the mint signed is recorded owed before the first LOAD, and
 *     a failure after the swap is PAID (ENG-642): the screen never runs the
 *     charge again for the same bill.
 */
import {blindMessage} from '@cashu/cashu-ts';
import {utf8ToBytes} from '@noble/hashes/utils';

import {cachedTipHeader} from './blockHeader';
import {
  CardAuthError,
  CardNeedsUpdateError,
  CardProtocolError,
  getBalance,
  getCard,
  getChange,
  getDleqs,
  getInfo,
  getPiecesNamed,
  getPiecesShort,
  getPubkey,
  isAlreadyOnCard,
  loadProof,
  proveCardKey,
  selectApplet,
  verifyCardPin,
  toHex,
  type CardInfo,
  type CardProofSlot,
  type CardRecord,
  type ChangeOpening,
  type ListedPiece,
  type Transceiver,
} from './cashuCard';
import {
  appendSettledProofsTill,
  buildCardSigAllSecret,
  cachedKeysets,
  expandKeysetId,
  finishCardChange,
  keysetFor,
  mapSwapError,
  mintReachable,
  prepareChargeOutputs,
  refreshKeysets,
  swapSigned,
  verifyPieceDleq,
  type CachedKeyset,
  type SwapSignedResult,
} from './cashuMint';
import {recoverNeedsCard, spendAll} from './cashuSpend';
import {PhaseError} from './phaseError';
import {
  allAttempted,
  isCardChange,
  markEntriesSettled,
  markFailed,
  markOwedChangeAttemptFailed,
  markOwedChangeOpened,
  markOwedChangeSending,
  markOwedChangeWritten,
  outstandingChangeForCard,
  owedCardChangeId,
  PermanentSettlementError,
  recordOwedCardChange,
  recoverableForCard,
  type OwedChangeEntry,
  type SettlementEntry,
  type SettlementInput,
} from './cashuSettlement';
import {
  compareLadderScore,
  ladderScore,
  pow2PieceCount,
  splitChangeForLadder,
  splitPow2,
  type LadderScore,
} from '../utils/denominations';
import {isLadderChangeEnabled} from '../utils/featureFlags';
import {recordRefusal} from './refusalLog';

import {FLASH_CASHU_MINT_URL} from '@env';

export {PhaseError, isPaidFailure} from './phaseError';

export const DEFAULT_UNIT = 'sat';

/** Change openings a 2.0 card keeps: a payment's change is at most this many pieces. */
export const MAX_CHANGE_OPENINGS = 8;

/** One day of the card's clock, seconds. */
const DAY_SECONDS = 86400;

/** The copy for a bill over the card's daily limit (decision 10: final wording reviewed in the PR). */
export const DAILY_LIMIT_REACHED =
  "This card has reached today's spending limit.";

/**
 * The copy for a card its owner has locked (`LOCK_CARD`, GET_INFO byte 10).
 * A locked card loads nothing more (spec/APDU.md LOAD_PROOF `6986`), so a
 * payment with change would strand the change: it is refused before
 * anything burns, whatever the bill.
 */
export const CARD_LOCKED = "This card is locked and can't be used to pay.";

/**
 * The copy for a card whose pieces are not in sats (GET_CARD's unit byte,
 * spec/APDU.md GET_CARD: `00` sat). Refused before anything burns.
 */
export const CARD_NOT_SATS =
  "This card's balance isn't in sats, and this terminal only takes sats.";

/** The piece format this terminal signs for: format-4 SIG_ALL pieces (GET_INFO byte 8, GET_CARD byte 0). */
export const CARD_PIECE_FORMAT = 4;

/**
 * How long the charge waits on the mint inside the tap, for the ping and
 * then for the keyset refresh: the card is held on the reader meanwhile.
 */
export const MINT_BUDGET_MS = 3000;

/**
 * The copy for a card whose pieces cannot be checked offline, with the mint
 * out of reach or answering without its keysets.
 */
export const ONLINE_ONLY =
  'This card can only be charged while this terminal is online.';

/**
 * The copy for a bill whose change is due, with the mint out of reach
 * (ENG-674 blocking 2a): SIG_ALL binds the change keyset and fee into the
 * outputs for good, so the mint must confirm them before the card signs —
 * never after. Refused before anything burns.
 */
export const CHANGE_NEEDS_MINT =
  "This bill needs change, and this terminal needs to reach the mint first. Try again once it's back online.";

/**
 * The copy for a second tap by a card that is not the one the first tap
 * read (ENG-674): AUTH against the key read in session 1 failed, before the
 * PIN, any owed-change write, any SPEND_ALL_AGAIN or any burn. The plan,
 * the owed change and the needs-card payments all belong to the first card,
 * so nothing is sent to this one.
 */
export const NOT_THE_CARD_READ =
  "This isn't the card that was read. Nothing was taken.";

/**
 * Rank the ways to cover `amountSat` from the card's unspent slots, cheapest
 * change first. A proof is atomic, so "enter amount" means coin selection:
 * exact subsets when the denominations allow, otherwise the smallest
 * over-cover. Greedy largest-first is NOT among the strategies — burning a
 * 256-sat proof for a 14-sat bill would demand 242 sat of change from a till
 * that may hold pocket change (found in the field).
 *
 * Candidates are deduplicated by slot-set and sorted by change; the caller
 * walks them until one fits the card (`selectFittingPlan`).
 *
 * ENG-701 (`isLadderChangeEnabled`): among candidates with the same change,
 * the one that leaves the card closest to its covering ladder wins (the
 * pieces kept plus the change, split as `splitChangeForLadder` splits it),
 * then the fewest slots. Change stays the first key: more change is never
 * taken for a better shape. The exact subset is the one that leaves the
 * best-shaped card (`bestExactSubset`), not the DP's first witness.
 */
export interface PurchasePlan {
  slots: number[];
  burnedSat: number;
  changeSat: number;
  /**
   * How the card makes this plan's change, largest first: set by
   * `selectFittingPlan` once the plan is chosen, so the slot pre-flight,
   * `spendAll` and the stage all read the one list (ENG-701). Absent:
   * `splitPow2(changeSat)`.
   */
  changePieces?: number[];
}

type PlannedPiece = Pick<CardProofSlot, 'slot' | 'amount'> & {date?: number};

/** The amounts of `all` a plan burning `slots` leaves on the card. */
const keptAmounts = (
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[],
  slots: readonly number[],
): number[] => {
  const burned = new Set(slots);
  return all.filter(p => !burned.has(p.slot)).map(p => p.amount);
};

/**
 * The card's shape after a plan: what it keeps plus its change, split as the
 * card will make it (uncapped: the slots are checked later).
 */
const shapeAfter = (
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[],
  plan: PurchasePlan,
): LadderScore => {
  const kept = keptAmounts(all, plan.slots);
  return ladderScore([...kept, ...splitChangeForLadder(plan.changeSat, kept)]);
};

/**
 * The plan ranking: least change, then (ENG-701, `all` given) the card
 * closest to its ladder afterwards, then the fewest slots.
 */
function planOrder(
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[] | null,
): (a: PurchasePlan, b: PurchasePlan) => number {
  const scores = new Map<PurchasePlan, LadderScore>();
  const score = (plan: PurchasePlan) => {
    let got = scores.get(plan);
    if (!got) {
      got = shapeAfter(all!, plan);
      scores.set(plan, got);
    }
    return got;
  };
  return (a, b) =>
    a.changeSat - b.changeSat ||
    (all ? compareLadderScore(score(a), score(b)) : 0) ||
    a.slots.length - b.slots.length;
}

/** Past this many count vectors `bestExactSubset` gives up (the DP's witness stays). */
export const EXACT_SUBSET_LIMIT = 4096;

/**
 * The exact subset of `group` paying `amountSat` that leaves the card
 * (`all`) closest to its covering ladder, fewest slots on a tie. Enumerates
 * how many pieces of each amount to take (few distinct amounts on a card:
 * powers of two), at most `EXACT_SUBSET_LIMIT` of them; `null` past that or
 * when no subset is exact. Pieces of one amount are taken in `group`'s order.
 */
export function bestExactSubset(
  group: readonly Pick<CardProofSlot, 'slot' | 'amount'>[],
  amountSat: number,
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[] = group,
): number[] | null {
  const byAmount = new Map<number, number[]>();
  for (const p of group) {
    byAmount.set(p.amount, [...(byAmount.get(p.amount) ?? []), p.slot]);
  }
  const amounts = [...byAmount.keys()].sort((a, b) => b - a);
  // What the amounts from i on can still pay at most.
  const reach = amounts.map((_, i) =>
    amounts.slice(i).reduce((t, a) => t + a * byAmount.get(a)!.length, 0),
  );
  let visited = 0;
  let best: {slots: number[]; score: LadderScore} | null = null;
  const counts: number[] = [];
  const walk = (i: number, left: number): boolean => {
    visited += 1;
    if (visited > EXACT_SUBSET_LIMIT) {
      return false;
    }
    if (left === 0) {
      const slots = amounts.flatMap((a, j) =>
        byAmount.get(a)!.slice(0, counts[j] ?? 0),
      );
      const score = ladderScore(keptAmounts(all, slots));
      const cmp = best ? compareLadderScore(score, best.score) : -1;
      if (cmp < 0 || (cmp === 0 && slots.length < best!.slots.length)) {
        best = {slots, score};
      }
      return true;
    }
    if (i >= amounts.length || reach[i] < left) {
      return true;
    }
    const a = amounts[i];
    for (
      let n = Math.min(byAmount.get(a)!.length, Math.floor(left / a));
      n >= 0;
      n--
    ) {
      counts[i] = n;
      if (!walk(i + 1, left - n * a)) {
        return false;
      }
    }
    counts[i] = 0;
    return true;
  };
  if (!walk(0, amountSat)) {
    return null;
  }
  return best ? (best as {slots: number[]}).slots : null;
}

export function planPurchase(
  unspent: PlannedPiece[],
  amountSat: number,
): PurchasePlan[] {
  if (amountSat <= 0) {
    return [];
  }
  // ENG-701: rank by the shape the whole card is left in (every date's
  // pieces), or, switched off, exactly as before.
  const all = isLadderChangeEnabled() ? unspent : null;
  // One payment's pieces share one date (SPEND_ALL_BEGIN refuses a mix with
  // 6A80: pieces of different dates have different lock conditions, and a
  // mint takes no one signature for those). Plan each date apart.
  const dates = new Set(unspent.map(p => p.date ?? 0));
  if (dates.size > 1) {
    return mergePlans(
      [...dates].map(date =>
        planOneDate(
          unspent.filter(p => (p.date ?? 0) === date),
          amountSat,
          all,
        ),
      ),
      all,
    );
  }
  return planOneDate(unspent, amountSat, all);
}

/** Every date's candidates in one ranking, as `planOneDate` ranks one. */
function mergePlans(
  groups: PurchasePlan[][],
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[] | null,
): PurchasePlan[] {
  return groups.flat().sort(planOrder(all)).slice(0, 8);
}

function planOneDate(
  unspent: Pick<CardProofSlot, 'slot' | 'amount'>[],
  amountSat: number,
  all: readonly Pick<CardProofSlot, 'slot' | 'amount'>[] | null,
): PurchasePlan[] {
  const total = unspent.reduce((t, p) => t + p.amount, 0);
  if (total < amountSat) {
    return [];
  }

  const candidates: PurchasePlan[] = [];

  // 1. Exact subsets: DP over reachable sums, fewest-slot witness each.
  const reach: (number[] | null)[] = new Array(total + 1).fill(null);
  reach[0] = [];
  for (const p of unspent) {
    for (let s = total; s >= p.amount; s--) {
      const prev = reach[s - p.amount];
      if (prev !== null && reach[s] === null) {
        reach[s] = [...prev, p.slot];
      }
    }
  }
  // ENG-701: the exact subset that leaves the best-shaped card, in place of
  // the DP's first witness (which is neither the fewest slots nor the best
  // shape). Past the enumeration limit the witness stays.
  if (all && reach[amountSat]) {
    reach[amountSat] =
      bestExactSubset(unspent, amountSat, all) ?? reach[amountSat];
  }
  for (let sum = amountSat; sum <= total; sum++) {
    if (reach[sum]) {
      candidates.push({
        slots: reach[sum]!,
        burnedSat: sum,
        changeSat: sum - amountSat,
      });
    }
  }

  // 2. The smallest single proof that covers the bill.
  const ascending = [...unspent].sort((a, b) => a.amount - b.amount);
  const single = ascending.find(p => p.amount >= amountSat);
  if (single) {
    candidates.push({
      slots: [single.slot],
      burnedSat: single.amount,
      changeSat: single.amount - amountSat,
    });
  }

  // 3. Ascending accumulation: the smallest overage from mixed small proofs.
  let sum = 0;
  const acc: number[] = [];
  for (const p of ascending) {
    if (sum >= amountSat) {
      break;
    }
    acc.push(p.slot);
    sum += p.amount;
  }
  if (sum >= amountSat) {
    candidates.push({slots: acc, burnedSat: sum, changeSat: sum - amountSat});
  }

  // Dedupe by slot-set, cheapest change first, then (ENG-701) the card's
  // shape afterwards, fewest slots as the last tiebreak.
  const seen = new Set<string>();
  return candidates
    .sort(planOrder(all))
    .filter(c => {
      const key = [...c.slots].sort((x, y) => x - y).join(',');
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

/**
 * The first plan (in `planPurchase`'s order, cheapest change first) whose
 * change fits the card's free slots: the card makes its change in
 * power-of-two pieces and takes one slot per piece, so a plan whose change
 * needs more slots than the card has free would burn and then strand the
 * change. The fit test is the fewest pieces (`splitPow2`), so which plans
 * are accepted is what it was before ENG-701. An exact plan (`changeSat` 0)
 * always fits. `null` when none does.
 *
 * Given the card's `unspent` pieces, the plan comes back with its
 * `changePieces` (`withChangePieces`): the change split to refill the card's
 * covering ladder (`splitChangeForLadder`, ENG-701), or `splitPow2` with the
 * kill switch off. Computed here, before anything burns, so the pre-flight,
 * the card and the stage read one list.
 *
 * `opts.loading` is the owed change this tap writes to the card before the
 * change: the split counts it as kept, so the extra pieces do not fill gaps
 * the owed pieces are about to fill.
 */
export function selectFittingPlan(
  plans: PurchasePlan[],
  freeSlots: number,
  unspent?: readonly Pick<CardProofSlot, 'slot' | 'amount'>[],
  opts: {loading?: readonly number[]} = {},
): PurchasePlan | null {
  const plan =
    plans.find(p => pow2PieceCount(p.changeSat) <= freeSlots) ?? null;
  if (!plan || !unspent) {
    return plan;
  }
  return withChangePieces(plan, unspent, freeSlots, opts.loading);
}

/**
 * `plan` with its `changePieces`: the change split to refill the ladder of
 * what the card keeps plus `loading` (owed pieces written this tap), in at
 * most `maxPieces` pieces but never fewer than `splitPow2`'s (ENG-701); the
 * fewest pieces with the kill switch off.
 */
export function withChangePieces(
  plan: PurchasePlan,
  unspent: readonly Pick<CardProofSlot, 'slot' | 'amount'>[],
  maxPieces: number,
  loading: readonly number[] = [],
): PurchasePlan {
  return {
    ...plan,
    changePieces: isLadderChangeEnabled()
      ? splitChangeForLadder(
          plan.changeSat,
          [...keptAmounts(unspent, plan.slots), ...loading],
          Math.max(pow2PieceCount(plan.changeSat), maxPieces),
        )
      : splitPow2(plan.changeSat),
  };
}

/** The change pieces a chosen plan makes, largest first. */
export const planChangePieces = (plan: PurchasePlan): number[] =>
  plan.changePieces ?? splitPow2(plan.changeSat);

/** The blinded message a change opening makes, rebuilt as the card made it. */
function openingB_(
  opening: ChangeOpening,
  cardPubkey: string,
  refundKey: string | null,
): {B_: string; secret: string} | null {
  if (opening.date && !refundKey) {
    return null;
  }
  const secret = buildCardSigAllSecret(
    opening.nonce,
    cardPubkey,
    opening.date,
    refundKey,
  );
  const {B_} = blindMessage(utf8ToBytes(secret), BigInt(`0x${opening.r}`));
  return {B_: B_.toHex(true), secret};
}

/** An owed 2.0 entry the card's opening has been matched to: a whole piece. */
const isOpened = (e: OwedChangeEntry): boolean =>
  isCardChange(e) && !!e.nonce && !!e.C && !!e.r;

/**
 * Settle the owed-change record against what the card holds. Read-only on
 * the card. Nothing owed → `[]` without an APDU.
 *
 * Owed change on a 2.0 card is the card's own change (`SPEND_ALL_CHANGE`):
 * the store holds the mint's half (B_, C_), the card holds the opening
 * (nonce, r, date) until the piece is back on it — and lets the opening go
 * only then. So, against the card's openings (`GET_CHANGE`, read here unless
 * the caller already has them):
 *
 *   - an owed piece whose B_ an opening rebuilds is still owed: the opening
 *     is copied into the record (`markOwedChangeOpened`, with the piece's C
 *     finished from the mint's keys kept on this terminal) and it comes back;
 *   - an owed piece no opening rebuilds is on the card: it is marked written.
 *
 * The card refuses a LOAD of a piece it holds (`6A94`), so a re-send can no
 * longer put a duplicate on it; the reconcile is still what keeps a stale
 * record from being sent at all. 0.x change (terminal-made SIG_INPUTS
 * pieces) is never written to a 2.0 card (decision 8) and is not returned.
 */
export async function reconcileOwedChange({
  transceive,
  cardPubkey,
  refundKey = null,
  openings,
  mintUrl = FLASH_CASHU_MINT_URL,
  now,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  cardPubkey: string;
  /** The card's refund key (GET_CARD): a dated opening's secret names it. */
  refundKey?: string | null;
  /** The card's openings, when the caller has just read them. */
  openings?: ChangeOpening[];
  mintUrl?: string;
  now: number;
  onPhase?: (phase: string) => void;
}): Promise<OwedChangeEntry[]> {
  const owed = (await outstandingChangeForCard(cardPubkey)).filter(
    isCardChange,
  );
  if (owed.length === 0) {
    return [];
  }
  const step = makeStep(onPhase);
  const held =
    openings ?? (await step('reading card', () => getChange(transceive)));
  const byB_ = new Map<string, {opening: ChangeOpening; secret: string}>();
  for (const opening of held) {
    const rebuilt = openingB_(opening, cardPubkey, refundKey);
    if (rebuilt) {
      byB_.set(rebuilt.B_, {opening, secret: rebuilt.secret});
    }
  }
  const remaining: OwedChangeEntry[] = [];
  let markRefused = false;
  const warnOnce = (what: string, error: unknown) => {
    if (!markRefused) {
      markRefused = true;
      console.warn(
        `[charge] ${what}; leaving the stale record for the next reconcile`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  for (const entry of owed) {
    const match = byB_.get(entry.B_!.toLowerCase());
    if (!match) {
      // The card let the opening go: the piece is on it. Not owed, whatever
      // the store will take right now; a stale 'owed' record is harmless,
      // because every path that writes owed change reconciles first.
      try {
        await markOwedChangeWritten(entry.id, entry.slot, now);
      } catch (error) {
        warnOnce(
          'owed change found on the card but its written mark was refused',
          error,
        );
      }
      continue;
    }
    if (isOpened(entry)) {
      remaining.push(entry);
      continue;
    }
    const {opening, secret} = match;
    let C: string;
    try {
      const keyset = await keysetFor(mintUrl, entry.keysetId, {online: false});
      C = finishCardChange(entry.C_!, opening.r, entry.amount, keyset.keys);
    } catch {
      // No keys kept for the change's keyset: still owed, not loadable from
      // here until the terminal has seen the mint.
      remaining.push(entry);
      continue;
    }
    const opened = {
      nonce: opening.nonce,
      secret,
      C,
      date: opening.date,
      r: opening.r,
    };
    try {
      await markOwedChangeOpened(entry.id, opened, now);
    } catch (error) {
      warnOnce('an owed piece was opened but the record was refused', error);
    }
    remaining.push({...entry, ...opened});
  }
  return remaining;
}

/** The phase string `writeOwedChange` emits per piece; `phaseToStation` keys on it. */
export const owedChangePhase = (amount: number): string =>
  `adding ${amount} sat of change owed from an earlier charge`;

/** The change-write phase as `executeCharge` emits it; `phaseToStation` keys on it. */
export const PHASE_WRITING_CHANGE = 'writing change to card';

/** The swap's phase as `executeCharge` emits it; `phaseToStation` keys on it. */
export const PHASE_SETTLING = 'settling payment and minting change';

/**
 * ENG-674 (blocking 1): the swap failed in a way that may or may not have
 * reached the mint, for a payment whose pieces could not all be checked
 * offline (no DLEQ kept, or one that did not verify) — `requiresOnline`.
 * The card has already signed and burned: a retry would burn it again for
 * the same bill, so `PhaseError.paid` is still set (ENG-642's rule — once
 * burned, never recharge). The phase is kept distinct from `PHASE_SETTLING`
 * so nothing claims the swap confirmed when the mint never answered it.
 */
export const PHASE_SETTLING_UNCONFIRMED =
  'settling payment — the mint has not confirmed it';

/**
 * ENG-674: the card signed and burned, and the mint then refused the swap
 * for good (`PermanentSettlementError`: a mint error, any HTTP 4xx). The
 * bill is not paid; the payment is marked `failed` for a human. Thrown with
 * `PhaseError.refused`: the screen ends on the refusal with Done, never
 * "Tap card again", since the card has already burned.
 */
export const PHASE_SETTLING_REFUSED = 'settling payment — the mint refused it';

/**
 * ENG-674: the card ANSWERED SPEND_ALL_SIGN, and neither that answer nor
 * SPEND_ALL_AGAIN's verifies against the payment (`failed` in the queue: a
 * broken card, or one that is not the card holding the key). Nothing reached
 * the mint and nothing ever will: the payment has no witness, the drain
 * skips it, and AGAIN is never asked for it again. Not paid — thrown with
 * `PhaseError.refused`, so the screen ends on Done, records no sale and
 * never charges the card again (it has burned).
 */
export const PHASE_CARD_SIGNATURE_INVALID =
  "settling payment — the card's signature is not valid";

/**
 * ENG-674: the card burned the payment and its answer was lost, SIGN's and
 * AGAIN's both (`needs-card`). Not confirmed, and not paid yet: the only way
 * back is SPEND_ALL_AGAIN when this card next pays on this terminal (the
 * till's `recoverNeedsCard`, before the next SPEND_ALL_BEGIN). Thrown with
 * `PhaseError.paid` (the card has burned: never charge it again for this
 * bill) under a phase that reads "Not confirmed yet", with its own body.
 */
export const PHASE_SETTLING_NEEDS_CARD = `${PHASE_SETTLING_UNCONFIRMED} (signature lost, next tap)`;

/**
 * ENG-674 (blocking 2b): the swap failed in a way that may or may not have
 * reached the mint (a transport failure, a 5xx, a timeout), for a payment
 * whose pieces all verified offline and whose change is due. The card has
 * burned and signed for the bill and its own change together: the payment
 * is paid and stays queued for the drain, same as an exact bill's deferred
 * swap, and the change — still owed, never loaded — goes onto the card at
 * its next tap.
 */
export const PHASE_SETTLING_CHANGE_OWED = `${PHASE_SETTLING} (change owed, next tap)`;

/**
 * The phase a change-write failure is reported under when the owed-change
 * record did NOT land first. The phase emitted to the stage is unchanged
 * (`PHASE_WRITING_CHANGE`); only the thrown `PhaseError` carries this, so the
 * UI can tell "saved, written on the next tap" from "not saved anywhere"
 * and never claims the first when the second is true.
 */
export const PHASE_WRITING_CHANGE_UNRECORDED =
  'writing change to card (unrecorded)';

/**
 * The phase a change-write failure is thrown under. Pieces the card already
 * took this session are named in it (`(4 sat on card)`, or
 * `(unrecorded, 4 sat on card)`), so the body can say how much of the change
 * landed and how much did not instead of calling the whole change missing
 * (ENG-645). With nothing landed it is `PHASE_WRITING_CHANGE` or
 * `PHASE_WRITING_CHANGE_UNRECORDED` exactly. Only pieces the card ANSWERED
 * count: a piece whose answer was lost may be on the card too, and the next
 * tap's reconcile finds it, but the copy promises only what is known.
 */
export function changeWriteFailurePhase({
  recorded,
  landedSat,
}: {
  recorded: boolean;
  landedSat: number;
}): string {
  if (landedSat <= 0) {
    return recorded ? PHASE_WRITING_CHANGE : PHASE_WRITING_CHANGE_UNRECORDED;
  }
  return recorded
    ? `${PHASE_WRITING_CHANGE} (${landedSat} sat on card)`
    : `${PHASE_WRITING_CHANGE} (unrecorded, ${landedSat} sat on card)`;
}

/**
 * The phase a failure of the post-swap bookkeeping (the burned entries
 * marked settled, the merchant's take into the till) is reported under. It
 * is never emitted to the stage: it only names the step on the thrown, paid
 * `PhaseError`.
 */
export const PHASE_RECORDING_PAYMENT = 'recording the payment';

/**
 * The post-swap bookkeeping failed, but every piece of change was then
 * written onto the card (the loads run regardless; see `executeCharge`).
 * Like `PHASE_RECORDING_PAYMENT`, never emitted to the stage: it lets the
 * UI headline and word a paid failure without claiming the change is
 * missing when it is on the card.
 */
export const PHASE_RECORDING_PAYMENT_CHANGE_ON_CARD =
  'recording the payment (change on card)';

/** The catch-all phase for a post-swap failure that carries no phase of its own. */
export const PHASE_AFTER_SWAP = 'finishing the charge';

/**
 * Write change owed from an earlier charge onto the card, piece by piece,
 * marking each written as the card answers. A piece the card refuses (a
 * `6A84` — no free slot — or a lost tag) stays owed with the attempt
 * recorded, and the error surfaces as a `PhaseError` so the caller can
 * class it. A `6A94` is the card saying it already holds the piece: written,
 * never a failure. Run after the PIN verify (LOAD_PROOF needs the PIN, a
 * card with none, or the change grant) and before any burn, so a failure
 * here is a clean refusal with nothing taken.
 *
 * Only whole pieces go out: an entry the card's opening has not been matched
 * to (`reconcileOwedChange`), and 0.x change, are left owed.
 *
 * Resolves with the pieces this call put on the card — and ONLY those. It
 * resolves short, without throwing, when the store refuses the write-ahead
 * mark: nothing is sent for that piece or the rest. A caller that tells the
 * customer what was added must read it from the result, never from `owed`.
 */
export async function writeOwedChange({
  transceive,
  owed,
  now,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  owed: OwedChangeEntry[];
  now: number;
  onPhase?: (phase: string) => void;
}): Promise<OwedChangeEntry[]> {
  const written: OwedChangeEntry[] = [];
  for (const entry of owed.filter(isOpened)) {
    const phase = owedChangePhase(entry.amount);
    onPhase(phase);
    // Write-ahead: the attempt is counted BEFORE the LOAD goes out, so
    // whatever fails after this point — the answer lost, the `written` mark
    // refused by the keychain, the process killed — the next try sees
    // `attempts > 0` and reconciles against the card before sending this
    // piece again. If the store will not take the mark, nothing is sent:
    // this piece and the rest stay `owed` for a later tap.
    try {
      await markOwedChangeSending(entry.id, now);
    } catch (error) {
      console.warn(
        '[charge] owed-change attempt could not be recorded; leaving the rest owed for a later tap',
        error instanceof Error ? error.message : String(error),
      );
      return written;
    }
    let slot: number | undefined;
    try {
      slot = await loadProof(
        transceive,
        {
          keysetId: entry.keysetId,
          amount: entry.amount,
          nonce: entry.nonce!,
          C: entry.C!,
          date: entry.date ?? 0,
        },
        entry.dleqE && entry.dleqS
          ? {e: entry.dleqE, s: entry.dleqS, r: entry.r!}
          : undefined,
      );
    } catch (error) {
      if (!isAlreadyOnCard(error)) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          await markOwedChangeAttemptFailed(entry.id, reason, now);
        } catch {
          // The entry stays 'owed' on disk either way; the reason is
          // bookkeeping and must not mask the card's answer.
        }
        throw new PhaseError(phase, error);
      }
      slot = undefined;
    }
    try {
      await markOwedChangeWritten(entry.id, slot, now);
    } catch {
      // The piece is on the card. A stale 'owed' record is harmless: the
      // card lets the opening go, so the next reconcile marks it.
    }
    written.push(entry);
  }
  return written;
}

export interface ChargeArgs {
  transceive: Transceiver;
  amountSat: number;
  /** The CUSTOMER's card PIN — required only when their card asks for it. The
   *  terminal learns that from GET_INFO (the PIN state and the no-PIN
   *  allowance) and prompts accordingly. */
  pin?: string;
  mintUrl: string;
  unit?: string;
  now?: number;
  /** Progress callback — the trust surface: the screen renders exactly where
   *  the charge is, and an error names the step it died on. */
  onPhase?: (phase: string) => void;
}

export interface ChargeResult {
  amountSat: number;
  /** The payment as recorded: one entry holding every piece it burned. */
  burned: SettlementEntry[];
  changeSat: number;
  changeLoaded: number;
  /**
   * The card's balance read after the charge, for display. `null` when the
   * card had left the field by then: the charge is complete either way.
   */
  balanceAfter: number | null;
}

const makeStep =
  (onPhase: (phase: string) => void) =>
  async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    onPhase(phase);
    try {
      return await fn();
    } catch (error) {
      // A card that needs an update is refused as itself, whatever the step:
      // every screen short-circuits on it before any PIN or charge UI.
      if (error instanceof CardNeedsUpdateError) {
        throw error;
      }
      throw new PhaseError(phase, error);
    }
  };

/** The phase the payment's pre-signature commands run under (TELL_TIME … CHANGE). */
export const PHASE_PREPARING = 'preparing the payment';

/** The burn phase `phaseToStation` animates, one per piece. */
export const burnPhase = (amount: number, index: number, total: number) =>
  `burning ${amount} sat (proof ${index}/${total})`;

/** The time in a block header (bytes 68–71, little-endian), seconds. */
export function headerTime(header: number[] | null | undefined): number {
  if (!header || header.length !== 80) {
    return 0;
  }
  return (
    header[68] +
    header[69] * 0x100 +
    header[70] * 0x10000 +
    header[71] * 0x1000000
  );
}

/**
 * Whether `amountSat` leaving the card would take its day past the owner's
 * daily limit, by what GET_INFO and GET_CARD say — refused before anything
 * burns. The card's own word (`6A8F` at SIGN) is final; this only spares a
 * payment the card would certainly refuse. The day begins again (and what
 * it counted goes) when the card's clock — or the header about to be shown
 * to it — is a day past the window's start, while the rollover budget lasts.
 */
export function overDailyLimit(
  info: Pick<CardInfo, 'dailyLimit' | 'now' | 'windowStart' | 'spentToday'>,
  record: Pick<CardRecord, 'rolls' | 'rollBudget'>,
  amountSat: number,
  tipTime = 0,
): boolean {
  if (!info.dailyLimit) {
    return false;
  }
  const now = Math.max(info.now, tipTime);
  const dayOver = now >= info.windowStart + DAY_SECONDS;
  const rolls =
    dayOver && (info.windowStart === 0 || record.rolls < record.rollBudget);
  const counted = rolls ? 0 : info.spentToday;
  return counted + amountSat > info.dailyLimit;
}

/**
 * Whether the card's no-PIN allowance covers `amountSat` today (decision 11):
 * then the till does not ask for the PIN. Conservative: what the allowance
 * has already counted is taken as standing, even where the day would begin
 * again — the card's own word at SIGN (`6A94`) asks for the PIN otherwise.
 */
export function allowanceCovers(
  info: Pick<CardInfo, 'allowance' | 'noPinSpent'>,
  amountSat: number,
): boolean {
  const allowance = info.allowance ?? 0;
  if (allowance <= 0) {
    return false;
  }
  return allowance - (info.noPinSpent ?? 0) >= amountSat;
}

/**
 * Session 1: read the card and rank the covers — NO PIN yet. The customer's
 * card is only on the antenna for the silent read; a PIN-required card gets
 * the pad afterwards (tap → PIN → tap; the fresh verify inside session 2).
 */
export interface PreReadCharge {
  plan: PurchasePlan;
  /** Every unspent piece, as the short listing names it (GET_PIECES P2 = 3). */
  unspent: ListedPiece[];
  /**
   * The planned pieces whole (GET_PIECES P2 = 2), each checked against the
   * listing: what the payment's secrets are rebuilt from.
   */
  pieces: CardProofSlot[];
  cardPubkey: string;
  /**
   * Ask for the PIN before session 2: the card has one, and either its
   * no-PIN allowance does not cover the bill or a payment it signed with
   * its PIN lost its signature (`needs-card`): SPEND_ALL_AGAIN needs the PIN
   * for that one (spec/APDU.md SPEND_ALL_AGAIN).
   */
  pinRequired: boolean;
  /** The card has a PIN (whether or not this bill needs it). */
  pinSet?: boolean;
  /** The card's refund key, which a dated piece's secret names. */
  refundKey?: string | null;
  /**
   * A planned piece could not be checked offline (no DLEQ kept with it, one
   * that does not verify, or no mint keys kept on this terminal): the charge
   * pays only once the mint has answered (`mintReachable`), so the swap
   * checks it in the same tap.
   */
  requiresOnline?: boolean;
  /**
   * Change from an earlier charge this card is still owed, does not yet
   * hold, and has a free slot for AFTER the bill's own change is placed.
   * `executeCharge` writes it first, so it is counted against the card's
   * empty slots when the plan is chosen — but the bill wins: when no plan
   * fits beside the owed pieces, the bill takes the empties and only the
   * owed pieces with room left are here. The others stay `owed` on disk
   * for a later tap and never refuse a charge the card can physically take.
   */
  owedChange: OwedChangeEntry[];
}

export async function readAndPlan({
  transceive,
  amountSat,
  mintUrl = FLASH_CASHU_MINT_URL,
  now = Date.now(),
  header,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  amountSat: number;
  mintUrl?: string;
  now?: number;
  /** The tip header the charge will show the card; defaults to the cached tip. */
  header?: number[] | null;
  onPhase?: (phase: string) => void;
}): Promise<PreReadCharge> {
  const step = makeStep(onPhase);

  await step('reading card', () => selectApplet(transceive));
  const info = await step('reading card', () => getInfo(transceive));
  // Refusals on the card's own word, before anything is planned or burned.
  // The owner's lock (GET_INFO byte 10) is not the PIN's block (byte 7).
  // The applet still lets a locked card sign (CashuApplet.java: "lock
  // disables writes, not the bearer's ability to pay"), and spec/APDU.md
  // says nothing of what a till should do with one; but LOCK_CARD is "no
  // more loads", so a payment's change could never go back on: swapped,
  // recorded owed, and stranded on this terminal. This till takes no
  // payment from a locked card, exact or not.
  if (info.locked) {
    throw new Error(CARD_LOCKED);
  }
  if (info.pinState === 'blocked') {
    throw new Error('card PIN is blocked — the card must be re-provisioned');
  }
  // NUT-XX: the secrets the till rebuilds are format-4. A card whose pieces
  // are in another format would sign its own secrets, the till would rebuild
  // others, and the mint would refuse the swap after the burn.
  if (info.format !== CARD_PIECE_FORMAT) {
    throw new CardNeedsUpdateError(`piece format ${info.format}`);
  }
  const record = await step('reading card', () => getCard(transceive));
  if (record.format !== CARD_PIECE_FORMAT) {
    throw new CardNeedsUpdateError(`record format ${record.format}`);
  }
  if (record.unit !== 0) {
    throw new Error(CARD_NOT_SATS);
  }
  const cardPubkey = await step('reading card', () =>
    getPubkey(transceive).then(toHex),
  );
  // The short listing (spec/APDU.md "Payment Flow": GET_PIECES P2 = 3):
  // what each piece is worth, its date and keyset — all a plan needs, in an
  // answer or two where the whole form takes up to forty-three.
  const unspent = await step('reading card', () => getPiecesShort(transceive));
  const openings = await step('reading card', () => getChange(transceive));

  const plans = planPurchase(unspent, amountSat);
  if (plans.length === 0) {
    throw new Error(
      `card holds ${unspent.reduce(
        (t, p) => t + p.amount,
        0,
      )} sat; the bill is ${amountSat} sat`,
    );
  }

  // The card's daily limit, BEFORE anything burns: a payment over it is
  // refused by the card at SIGN with nothing burned (6A8F), but the till can
  // see most of them coming and spare the customer the tap.
  const tip = header === undefined ? cachedTipHeader(now) : header;
  if (overDailyLimit(info, record, amountSat, headerTime(tip))) {
    throw new Error(DAILY_LIMIT_REACHED);
  }

  const pinSet = info.pinState === 'set';
  // A payment this card signed and whose signature was lost is recovered by
  // SPEND_ALL_AGAIN before this one signs — and AGAIN needs the PIN unless
  // that signature was given without it (spec/APDU.md SPEND_ALL_AGAIN). A
  // bill the allowance covers would send no PIN, AGAIN would be refused, and
  // this payment's SIGN would replace the card's last signature for good:
  // the earlier payment, recoverable until then, would be lost. So a card
  // with a PIN and such a payment outstanding is asked for its PIN.
  const pinRequired =
    pinSet &&
    (!allowanceCovers(info, amountSat) ||
      (await hasRecoverableSignature(cardPubkey)));
  // Owed change goes on only in a tap that may load: a card with no PIN, or
  // one whose PIN is verified before the burn. A bill the allowance pays
  // sends no PIN, so it writes nothing owed.
  const mayLoad = !pinSet || pinRequired;

  // Slot pre-flight, BEFORE anything burns: the change goes back one slot
  // per power-of-two piece, and a LOAD the card answers 6A84 (no free slot)
  // after the swap strands mint-signed change (field-found: ENG-630). The
  // card also keeps at most eight change openings: a payment whose change
  // needs more than are free is refused by the card at SPEND_ALL_CHANGE.
  // Change still owed from an earlier charge is written first, as much of it
  // as the card has room for, and takes those slots off the top.
  const emptySlots = info.empty;
  const freeOpenings = MAX_CHANGE_OPENINGS - openings.length;
  const stillOwed = await reconcileOwedChange({
    transceive,
    cardPubkey,
    refundKey: record.refundKey,
    openings,
    mintUrl,
    now,
    onPhase,
  });
  const loadable = mayLoad ? stillOwed.filter(isOpened) : [];
  // The bill comes first. Owed change is written this tap only out of the
  // slots the bill's own change does not need; the rest stays 'owed' on
  // disk for a later tap. Owed change must never refuse a charge on its
  // own: a card that reported one empty slot and could physically take the
  // change must not be declined because an earlier piece wanted that slot
  // (an exact bill needs no slot, and the card ENG-630 came from — full,
  // with change owed — has to be able to pay again). So: try the plan with
  // the owed pieces counted first; when nothing fits, give the bill every
  // empty slot and write only the owed pieces that still have room. An owed
  // piece that lands lets its opening go, which the bill's change can use.
  const room = (owedWritten: number) =>
    Math.min(emptySlots - owedWritten, freeOpenings + owedWritten);
  let owedChange = loadable.slice(0, emptySlots);
  // The cap is the fewest pieces' test (`pow2PieceCount`) for which plan,
  // and the most pieces the change may split into (ENG-701's ladder): a
  // longer split only leaves more owed pieces for a later tap. The split
  // counts the owed pieces this tap writes first as already on the card.
  let plan = selectFittingPlan(plans, room(owedChange.length), unspent, {
    loading: owedChange.map(e => e.amount),
  });
  if (!plan) {
    // The bill gets every empty slot for its fit test, and its change is
    // the fewest pieces (`splitPow2`): no ENG-701 ladder here. This branch
    // is reached only when the owed pieces crowd the slots, so any slot a
    // longer split would take is one an owed piece wants, and a longer
    // split would push owed change (whole sats the customer is owed) off
    // the card to make the card's shape nicer. Owed pieces fill whatever
    // empty slots the fewest pieces leave.
    const fitSlots = Math.min(emptySlots, freeOpenings);
    plan = selectFittingPlan(plans, fitSlots);
    if (!plan) {
      const first = plans[0].changeSat;
      const pieces = pow2PieceCount(first);
      throw new Error(
        pieces > emptySlots
          ? `this card is full: ${first} sat of change needs ${pieces} free slots and the card has ${emptySlots}`
          : `this card is full: ${first} sat of change needs ${pieces} change openings and the card has ${freeOpenings} free`,
      );
    }
    owedChange = loadable.slice(
      0,
      Math.max(0, emptySlots - pow2PieceCount(plan.changeSat)),
    );
    // The room the owed pieces leave is never more than the fewest pieces
    // (more would have passed the first try's fit test), so this is always
    // `splitPow2`; it is set here so the pre-flight, the card and the stage
    // read one list.
    plan = withChangePieces(
      plan,
      unspent,
      room(owedChange.length),
      owedChange.map(e => e.amount),
    );
  }

  // The chosen pieces whole, by slot (GET_PIECES P2 = 2), each held to what
  // the listing said: unspent, the same amount, date and keyset. Their nonce
  // and C are what the payment's secrets are rebuilt from.
  const chosen = await step('reading card', async () => {
    const named = await getPiecesNamed(transceive, plan!.slots);
    return plan!.slots.map(slot => {
      const listed = unspent.find(p => p.slot === slot)!;
      const got = named.find(n => n.slot === slot)?.piece;
      if (
        !got ||
        got.status !== 'unspent' ||
        got.amount !== listed.amount ||
        got.date !== listed.date ||
        got.keysetId !== listed.keysetId
      ) {
        throw new CardProtocolError(
          `slot ${slot} does not hold the piece the card listed`,
        );
      }
      return got;
    });
  });

  // NUT-12, offline: each planned piece's DLEQ, checked with the mint keys
  // kept on this terminal. A piece that cannot be checked here (no proof
  // kept with it, one that does not verify, no keys) is accepted only when
  // the mint is there to swap it in the same tap.
  const dleqs = await step('reading card', () =>
    getDleqs(transceive, plan!.slots),
  );
  const keysets = await cachedKeysets(mintUrl);
  const requiresOnline = !chosen.every(piece => {
    let keyset: CachedKeyset;
    try {
      keyset = expandKeysetId(piece.keysetId, keysets);
    } catch {
      return false;
    }
    if (piece.date && !record.refundKey) {
      return false;
    }
    return verifyPieceDleq(
      {
        secret: buildCardSigAllSecret(
          piece.nonce,
          cardPubkey,
          piece.date,
          record.refundKey,
        ),
        C: piece.C,
        amount: piece.amount,
      },
      dleqs.get(piece.slot),
      keyset.keys,
    );
  });

  return {
    plan,
    cardPubkey,
    pinRequired,
    pinSet,
    refundKey: record.refundKey,
    requiresOnline,
    unspent,
    pieces: chosen,
    owedChange,
  };
}

/**
 * Whether this card has a SIG_ALL payment recorded `needs-card` (burned, its
 * signature lost): SPEND_ALL_AGAIN at this tap is its only way back. An
 * unreadable store says no: recovery is skipped then anyway.
 */
async function hasRecoverableSignature(cardPubkey: string): Promise<boolean> {
  try {
    return (await recoverableForCard(cardPubkey)).some(
      e => e.sigflag === 'SIG_ALL' && !!e.message,
    );
  } catch {
    return false;
  }
}

/**
 * The one-session charge used by the dev harness: readAndPlan + executeCharge
 * composed into a single session (the PIN, when required, must be provided
 * up front).
 */
export async function chargeCard({
  transceive,
  amountSat,
  pin,
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
  onPhase = () => {},
}: ChargeArgs): Promise<ChargeResult> {
  const preRead = await readAndPlan({
    transceive,
    amountSat,
    mintUrl,
    now,
    onPhase,
  });
  if (preRead.pinRequired && !pin) {
    throw new Error(
      'this card has a PIN — ask the customer for it before tapping',
    );
  }
  return executeCharge({
    ...preRead,
    transceive,
    amountSat,
    pin,
    mintUrl,
    unit,
    now,
    onPhase,
  });
}

/**
 * The STORE's entries for the subset of `owedChange` it still calls `owed`
 * on this card, in the caller's order — the store's, not the caller's
 * snapshot, so `attempts` is live and the caller can tell a first write from
 * a retry. `[]` when the store cannot be read: writing nothing is the safe
 * side (a later tap reconciles), writing a duplicate is not.
 */
async function stillOwedOf(
  cardPubkey: string,
  owedChange: OwedChangeEntry[],
): Promise<OwedChangeEntry[]> {
  let live: Map<string, OwedChangeEntry>;
  try {
    live = new Map(
      (await outstandingChangeForCard(cardPubkey)).map(e => [e.id, e]),
    );
  } catch (error) {
    console.warn(
      '[charge] owed-change store unreadable; skipping the owed write this tap',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
  return owedChange.flatMap(e => {
    const entry = live.get(e.id);
    return entry ? [entry] : [];
  });
}

export interface ExecuteChargeArgs {
  transceive: Transceiver;
  amountSat: number;
  plan: PurchasePlan;
  /** Every unspent piece the read listed (`readAndPlan`'s `unspent`). */
  unspent: ListedPiece[];
  /**
   * The planned pieces whole (`readAndPlan`'s `pieces`). A planned slot
   * found in neither this nor `unspent` (as a whole piece) is refused before
   * anything is sent to the card.
   */
  pieces?: CardProofSlot[];
  cardPubkey: string;
  pin?: string;
  pinRequired: boolean;
  /** The card has a PIN; defaults to `pinRequired`. */
  pinSet?: boolean;
  /** The card's refund key (GET_CARD), for a dated piece's secret. */
  refundKey?: string | null;
  /** From `readAndPlan`: pay only once the mint has answered. */
  requiresOnline?: boolean;
  /** From `readAndPlan`: change still owed to this card, written before the burn. */
  owedChange?: OwedChangeEntry[];
  mintUrl: string;
  unit?: string;
  now?: number;
  /** The tip header to show the card; defaults to the cached tip. */
  header?: number[] | null;
  onPhase?: (phase: string) => void;
  /**
   * Called once, synchronously, just before the card is asked to sign (and
   * so to burn): from here on the card may be spent, so the charge must run
   * to its end where the merchant can see it. The screen holds every exit
   * (header Back, hardware Back, the stack's swipe) from this call until
   * `executeCharge` settles (ENG-645). Not called when the charge fails
   * earlier: a failed PIN verify or owed-change write burns nothing.
   */
  onBurnStart?: () => void;
}

/**
 * Count an offline refusal in the local log (ENG-701): the bill and the
 * card's piece sizes only. Never awaited and never thrown: the refusal is
 * what the merchant sees, and a log that will not write must not delay or
 * mask it.
 */
function noteRefusal(
  kind: 'online_only' | 'change_needs_mint',
  amountSat: number,
  unspent: readonly Pick<CardProofSlot, 'amount'>[],
): void {
  try {
    recordRefusal(
      kind,
      amountSat,
      unspent.map(p => p.amount),
    ).catch(() => {});
  } catch {
    // The log is best effort.
  }
}

/**
 * The keysets of the planned pieces, from what is kept or, failing that and
 * only when the mint has just answered in full (`fresh`), the mint.
 */
async function plannedKeysets(
  mintUrl: string,
  pieces: CardProofSlot[],
  fresh: boolean,
): Promise<CachedKeyset[]> {
  const out: CachedKeyset[] = [];
  for (const piece of pieces) {
    let keyset: CachedKeyset;
    try {
      keyset = await keysetFor(mintUrl, piece.keysetId, {online: false});
    } catch (error) {
      if (!fresh) {
        throw error;
      }
      keyset = await keysetFor(mintUrl, piece.keysetId, {online: true});
    }
    out.push(keyset);
  }
  return out;
}

/**
 * The money leg: verify the PIN if the card asks for one, write any change
 * the card is still owed, recover a payment whose signature was lost, then
 * pay — one SIG_ALL signature over the planned pieces, the merchant's
 * outputs and the card's own change — swap at the mint, record the change,
 * finish it from the card's openings and load it back.
 */
export async function executeCharge({
  transceive,
  amountSat,
  plan,
  unspent,
  pieces: readPieces = [],
  cardPubkey,
  pin,
  pinRequired,
  pinSet = pinRequired,
  refundKey = null,
  requiresOnline = false,
  owedChange = [],
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
  header,
  onPhase = () => {},
  onBurnStart = () => {},
}: ExecuteChargeArgs): Promise<ChargeResult> {
  const step = makeStep(onPhase);

  // Every planned piece whole, as the read took it — before anything is
  // sent: a plan this terminal cannot rebuild the secrets of must not reach
  // the card.
  const pieces = plan.slots.map(slot => {
    const piece =
      readPieces.find(p => p.slot === slot) ??
      (unspent.find(p => p.slot === slot) as CardProofSlot | undefined);
    if (!piece || !piece.nonce || !piece.C) {
      throw new CardProtocolError(
        `the plan names slot ${slot}, whose piece this terminal has not read`,
      );
    }
    return piece;
  });

  // Session 2 opens a FRESH IsoDep channel: the card's active applet resets
  // to the default, so the applet SELECT must run again before any gated
  // command — without it Android answers 0x6E00 (CLA not supported) for
  // every verify/burn. Idempotent for the one-session wrapper.
  await step('reading card', () => selectApplet(transceive));

  // AUTH against the key the FIRST tap read (spec/APDU.md, Payment Flow:
  // AUTH before SPEND_ALL_BEGIN). Session 2 is a fresh tap: whatever is on
  // the antenna now must prove it is that card before anything of that
  // card's is sent to it — its PIN, the change it is owed (locked to its
  // key), a SPEND_ALL_AGAIN whose answer would mark its needs-card payments
  // failed, and the burn itself. The SIG_ALL signature proves the key too,
  // but only after the card has burned (ENG-674).
  const cardKey = await step('reading card', async () => {
    try {
      return await proveCardKey(transceive, cardPubkey);
    } catch (error) {
      throw error instanceof CardAuthError
        ? new CardAuthError(NOT_THE_CARD_READ)
        : error;
    }
  });

  if (pinRequired) {
    if (!pin) {
      throw new Error('this card has a PIN — ask the customer for it');
    }
    await step('verifying PIN', () => verifyCardPin(transceive, pin));
  }
  const pinVerified = pinRequired;
  // LOAD_PROOF needs the PIN verified in this tap, a card with no PIN, or
  // the change grant of the tap after a payment.
  const mayLoad = !pinSet || pinVerified;

  // Change owed from an earlier charge goes on first: the PIN is verified,
  // nothing has burned, so a slot the card refuses here is a clean refusal.
  // Gated on the STORE, not on the caller's snapshot: the PIN flow keeps
  // `owedChange` across a failed attempt and calls back in with the same
  // args — a piece the first attempt already landed (marked written as the
  // card answered) is not sent again. If the store will not read, nothing
  // owed is written this tap and a later one reconciles.
  //
  // The store alone is not enough on a retry: a LOAD whose answer was lost
  // leaves the piece ON the card and still `owed` on disk, with the attempt
  // counted (it is counted BEFORE the LOAD goes out). So any piece that has
  // already been attempted, or whose opening the read did not reach, is
  // settled against the card's openings first (`reconcileOwedChange`) and
  // only what the card does not hold goes on. A first attempt (`attempts`
  // 0) of a piece the read opened was never sent: it skips the read.
  if (owedChange.length > 0 && mayLoad) {
    let toWrite = await stillOwedOf(cardPubkey, owedChange);
    if (toWrite.some(e => e.attempts > 0 || !isOpened(e))) {
      const remaining = await reconcileOwedChange({
        transceive,
        cardPubkey,
        refundKey,
        mintUrl,
        now,
        onPhase,
      });
      const byId = new Map(remaining.map(e => [e.id, e]));
      toWrite = toWrite.flatMap(e => {
        const live = byId.get(e.id);
        return live ? [live] : [];
      });
    }
    if (toWrite.length > 0) {
      await writeOwedChange({transceive, owed: toWrite, now, onPhase});
    }
  }

  // A payment this card burned in an earlier tap whose signature was lost:
  // the card's LAST signature is the only way back, and this payment is
  // about to replace it. Best effort — never fails the charge.
  await recoverNeedsCard({transceive, cardKey, now}).catch(() => []);

  // Everything the swap will produce, made BEFORE the card signs (SIG_ALL
  // binds the outputs): the inputs' secrets, the merchant's outputs. No APDU.
  const changeSat = plan.changeSat;
  const prepared = await step(PHASE_PREPARING, async () => {
    // Ask the mint once, up front, whatever the bill, and refresh what is
    // cached from its answer: SIG_ALL binds the outputs' keyset (its
    // `active` flag) and the fee-adjusted amount into the signature for
    // good, on an exact bill as much as on one with change, so a stale cache
    // must never decide them while the mint can be asked (ENG-674). Out of
    // reach, an exact bill whose pieces all verified offline is still taken
    // on the cache; anything else is refused below, before anything burns.
    //
    // "Online" means the keysets came back FRESH, not just that the mint
    // answered a ping: a mint that lists its keysets but will not hand over
    // the rest (a failed or slow keys fetch) leaves the cache as stale as
    // having no mint at all, and is treated exactly so (ENG-674). The
    // refresh runs inside the tap with the card held, so it is bounded by
    // the same budget as the ping.
    const fresh =
      (await mintReachable(mintUrl, MINT_BUDGET_MS)) &&
      (await refreshKeysets(mintUrl, MINT_BUDGET_MS));
    if (requiresOnline && !fresh) {
      noteRefusal('online_only', amountSat, unspent);
      throw new Error(ONLINE_ONLY);
    }
    if (changeSat > 0 && !fresh) {
      // The card is about to sign for change the mint has not been asked
      // about since whatever this terminal last cached — never (ENG-674
      // blocking 2a). Refused here, before SPEND_ALL_BEGIN: nothing burns.
      noteRefusal('change_needs_mint', amountSat, unspent);
      throw new Error(CHANGE_NEEDS_MINT);
    }
    const keysets = await plannedKeysets(mintUrl, pieces, fresh);
    const changeKeyset = keysets[0];
    if (changeSat > 0 && !changeKeyset.active) {
      throw new Error(
        `this card's eCash is from keyset ${changeKeyset.id}, which the mint no longer issues change in`,
      );
    }
    const outKeyset = changeKeyset.active
      ? changeKeyset
      : (await cachedKeysets(mintUrl)).find(
          k => k.active && k.unit === unit && Object.keys(k.keys).length > 0,
        );
    if (!outKeyset) {
      throw new Error(
        `the mint has no active ${unit} keyset this terminal knows`,
      );
    }
    const fee = Math.ceil(
      keysets.reduce((t, k) => t + (k.inputFeePpk ?? 0), 0) / 1000,
    );
    const merchantSat = amountSat - fee;
    if (merchantSat <= 0) {
      throw new Error(
        `the mint's fee (${fee} sat) is more than the bill (${amountSat} sat)`,
      );
    }
    const inputs: SettlementInput[] = pieces.map((piece, i) => ({
      slot: piece.slot,
      nonce: piece.nonce,
      secret: buildCardSigAllSecret(
        piece.nonce,
        cardPubkey,
        piece.date,
        refundKey,
      ),
      C: piece.C,
      amount: piece.amount,
      keysetId: keysets[i].id,
    }));
    return {
      inputs,
      changeKeyset,
      merchant: prepareChargeOutputs({keysetId: outKeyset.id, merchantSat}),
    };
  });

  // The card is about to be asked to sign — and so to burn — for this bill:
  // the screen must hold every exit from here until this function settles
  // (ENG-645). The burn phases are the stage's: one per piece, all burned
  // in the one commit that releases the signature.
  let phase = PHASE_PREPARING;
  let spent: Awaited<ReturnType<typeof spendAll>>;
  try {
    spent = await spendAll({
      transceive,
      inputs: prepared.inputs,
      merchant: prepared.merchant,
      changeSat,
      changePieces: planChangePieces(plan),
      changeKeysetId: prepared.changeKeyset.id,
      cardPubkey,
      mintUrl,
      unit,
      now,
      header: header === undefined ? cachedTipHeader(now) : header,
      onSign: () => {
        onBurnStart();
        pieces.forEach((piece, i) => {
          phase = burnPhase(piece.amount, i + 1, pieces.length);
          onPhase(phase);
        });
      },
    });
  } catch (error) {
    throw new PhaseError(phase, error);
  }
  const {entry, signed, signatureInvalid} = spent;

  let changeLoaded = 0;
  /** Sats of change the card has answered for this session. */
  let changeLoadedSat = 0;
  // ONE ATOMIC SWAP is the whole online settlement: the burned pieces go in
  // under the card's one witness; out come the merchant's take and the
  // card's own change, exactly as the card signed them. Exact bills
  // (changeSat = 0) settle here too — deferring them to the drain left the
  // merchant's money queued on a silent drain failure. A swap that fails
  // ambiguously on an exact bill whose pieces all verified offline holds
  // the payment in the queue for the next online auto-run. No verified
  // signature at all is never a success.
  let swapped: SwapSignedResult | null = null;
  if (!signed) {
    // No signature that verifies against this payment's message: the card
    // burned (or says it did) but gave nothing the mint will take. Neither
    // case is paid — nothing has reached the mint — and nothing may say so
    // (NUT-XX: the till swaps, "and only then says paid"). The card has
    // burned either way, so neither offers a re-charge.
    if (signatureInvalid || entry.status === 'failed') {
      // The card ANSWERED, and its answer does not verify (`failed`: a
      // broken card, or one that is not the card holding the key). Nothing
      // will ever settle it — no witness, never drained, never asked of
      // SPEND_ALL_AGAIN again — so it is NOT paid and is not recorded as a
      // sale: refused, Done only, kept on the terminal for a human.
      throw new PhaseError(
        PHASE_CARD_SIGNATURE_INVALID,
        new Error(
          entry.lastError ??
            "the card's signature does not verify against the payment",
        ),
        {refused: true},
      );
    }
    // The card's answer was lost (`needs-card`): SPEND_ALL_AGAIN when this
    // card next pays on this terminal may still recover it. `paid` stays
    // set (ENG-642's no-re-charge rule) under a phase that reads "Not
    // confirmed yet", never "Paid" (architect's ruling), with its own body:
    // nothing retries it until the card is tapped again.
    throw new PhaseError(
      PHASE_SETTLING_NEEDS_CARD,
      new Error(
        'the card burned the payment and its signature was lost; it is recovered when this card next pays on this terminal',
      ),
      {paid: true},
    );
  } else {
    let settleFailure: PhaseError | null = null;
    try {
      swapped = await step(PHASE_SETTLING, () => swapSigned(mintUrl, signed));
    } catch (error) {
      // `step` always wraps a swap failure as a `PhaseError(PHASE_SETTLING,
      // rawError)` (see `makeStep`); unwrap it so the raw cashu-ts/network
      // error reaches the classifier.
      settleFailure = error as PhaseError;
    }
    if (settleFailure) {
      // Classify the swap error (ENG-674 blocking 1 & 2): a definitive mint
      // rejection or any HTTP 4xx is never deferred, however this bill's
      // pieces were planned — the card burned for a payment the mint has
      // now refused, and only a human can reconcile that.
      const mapped = mapSwapError(settleFailure.cause, entry);
      if (mapped instanceof PermanentSettlementError) {
        await markFailed(entry.id, mapped.message, now).catch(() => {});
        // Not paid, and never charged again: the card has burned for this
        // bill, so a retry would burn it a second time — very likely for the
        // same refusal. The screen ends on the mint's refusal with Done.
        throw new PhaseError(PHASE_SETTLING_REFUSED, mapped, {refused: true});
      }
      // Ambiguous: a transport failure (provably unsent), a 5xx, a timeout
      // — the mint may or may not hold the swap. The card has already
      // signed and burned either way, so a retry is never safe from here
      // on (ENG-642); `paid` stays true through every branch below.
      if (requiresOnline) {
        // This bill's pieces could not all be checked offline: the swap
        // was the only online confirmation it was ever going to get, and
        // it did not land. Neither "Paid" nor "try again" is honest —
        // settling, and non-retryable.
        throw new PhaseError(PHASE_SETTLING_UNCONFIRMED, mapped, {
          paid: true,
        });
      }
      if (changeSat > 0) {
        // Every planned piece verified offline: the proofs are good, the
        // card has burned and signed for the bill and its own change
        // together. The payment is paid and stays queued for the drain;
        // the change is still owed and goes on the card at its next tap.
        throw new PhaseError(PHASE_SETTLING_CHANGE_OWED, mapped, {
          paid: true,
        });
      }
      // Exact bill, offline-verified: no card write is pending, so the
      // failed swap costs the customer nothing — the payment stays
      // 'pending' in the queue and the drain settles (and pays out) on its
      // next run.
      swapped = null;
    }
  }

  // THE POINT OF NO RETURN. The card has signed and burned and the swap has
  // settled the payment (or, for an exact bill, deferred it to the drain):
  // the bill is PAID. Whatever the rest throws — a change LOAD the card
  // refuses, a tag lost mid-write, the settlement store refusing a write —
  // carries `paid`, so the screen ends the charge as paid instead of
  // offering a retry that would charge the card a second time for the same
  // bill (ENG-642). Only this function knows where the swap stands; the UI
  // must not infer it from the wording of a phase.
  try {
    if (swapped) {
      // The change exists only in this process until the card takes it:
      // record the mint's half durably FIRST — before the settlement
      // bookkeeping and before any LOAD — so a 6A84 on the second piece, a
      // lost tag or a killed app leaves a record the card's next tap
      // finishes from its own openings. A record that will not land is
      // logged and the loads still run: the card is the only home left.
      let changeRecorded = true;
      try {
        await recordOwedCardChange(
          cardPubkey,
          swapped.cardChange,
          {mintUrl, unit},
          now,
        );
      } catch (error) {
        changeRecorded = false;
        console.warn(
          '[charge] owed change could not be recorded; writing to the card unrecorded',
          error instanceof Error ? error.message : String(error),
        );
      }
      // The post-swap bookkeeping, then the change LOADs. Every step always
      // runs, so none depends on another succeeding:
      //  - The merchant's take joins the till FIRST (the sweep melts it
      //    to the account address). Like the change, it exists only in
      //    this process until it is written: a settlement queue that
      //    refuses the write below must not drop it.
      //  - The swap consumed the burned pieces: mark the payment settled.
      //  - The change goes onto the card EVEN IF the bookkeeping failed.
      //    The owed-change record, the till and the queue all write through
      //    the same Keychain, so their failures are correlated: a Keychain
      //    that refuses the till has most likely refused the owed-change
      //    record too, and then the card still in the field is the only
      //    home the change has left.
      // The bookkeeping failure is held, not thrown, until the loads are
      // done. A load that fails throws its own error instead (it says
      // where the change is, which the body copy needs more). If every
      // load landed, the held failure is thrown under a phase that says the
      // change is on the card, so the screen never reports it missing.
      const till = swapped.till;
      let bookkeepingError: PhaseError | null = null;
      try {
        await recordingPayment(() =>
          allAttempted([
            () => appendSettledProofsTill(till),
            () => markEntriesSettled([entry.id], now),
          ]),
        );
      } catch (error) {
        bookkeepingError =
          error instanceof PhaseError
            ? error
            : new PhaseError(PHASE_RECORDING_PAYMENT, error);
      }

      const failChangeWrite = (error: unknown): PhaseError => {
        // Recorded: the piece is owed on disk and the next tap writes it.
        // Unrecorded: it is nowhere but this process, and the error must
        // say so — the UI's "your change is saved" keys on the phase. A
        // held bookkeeping failure is superseded by this one; log it so a
        // refused till write (the merchant's take, held only in memory) is
        // not lost without a trace.
        if (bookkeepingError) {
          console.warn(
            '[charge] post-swap bookkeeping failed; superseded by the change write failure',
            bookkeepingError.message,
          );
        }
        return new PhaseError(
          changeWriteFailurePhase({
            recorded: changeRecorded,
            landedSat: changeLoadedSat,
          }),
          error,
        );
      };

      if (swapped.cardChange.length > 0) {
        let openings: ChangeOpening[];
        try {
          // A bill the no-PIN allowance paid has no verified PIN to load
          // with: a fresh SELECT takes the change grant the payment just
          // armed (the tap after a payment may put its change on).
          if (!mayLoad) {
            await selectApplet(transceive);
          }
          openings = await getChange(transceive);
        } catch (error) {
          throw failChangeWrite(error);
        }
        const byB_ = new Map<
          string,
          {opening: ChangeOpening; secret: string}
        >();
        for (const opening of openings) {
          const rebuilt = openingB_(opening, cardPubkey, refundKey);
          if (rebuilt) {
            byB_.set(rebuilt.B_, {opening, secret: rebuilt.secret});
          }
        }
        for (const change of swapped.cardChange) {
          const id = owedCardChangeId(cardPubkey, change.B_);
          onPhase(PHASE_WRITING_CHANGE);
          let slot: number | undefined;
          try {
            const match = byB_.get(change.B_.toLowerCase());
            if (!match) {
              throw new Error(
                'the card holds no opening for this change; its next tap finishes it',
              );
            }
            const {opening, secret} = match;
            const C = finishCardChange(
              change.C_,
              opening.r,
              change.amount,
              prepared.changeKeyset.keys,
            );
            if (changeRecorded) {
              await markOwedChangeOpened(
                id,
                {
                  nonce: opening.nonce,
                  secret,
                  C,
                  date: opening.date,
                  r: opening.r,
                },
                now,
              ).catch(() => {});
            }
            try {
              slot = await loadProof(
                transceive,
                {
                  keysetId: change.keysetId,
                  amount: change.amount,
                  nonce: opening.nonce,
                  C,
                  date: opening.date,
                },
                change.dleq
                  ? {e: change.dleq.e, s: change.dleq.s, r: opening.r}
                  : undefined,
              );
            } catch (error) {
              // 6A94: the card already holds the piece — it landed.
              if (!isAlreadyOnCard(error)) {
                throw error;
              }
              slot = undefined;
            }
          } catch (error) {
            throw failChangeWrite(error);
          }
          changeLoaded += 1;
          changeLoadedSat += change.amount;
          if (changeRecorded) {
            try {
              await markOwedChangeWritten(id, slot, now);
            } catch {
              // The piece is on the card. A stale 'owed' record is harmless:
              // the card lets its opening go, and the next reconcile marks it.
            }
          }
        }
      }

      if (bookkeepingError) {
        // Every load landed (a failed one threw above). With change on the
        // card, say so: "change not on card" would be false.
        throw changeLoaded > 0
          ? new PhaseError(
              PHASE_RECORDING_PAYMENT_CHANGE_ON_CARD,
              bookkeepingError.cause,
            )
          : bookkeepingError;
      }
    }

    // Display only: the charge is complete, so a customer who lifts the
    // card before this read must not turn a paid charge into a failure.
    onPhase('reading card');
    const balanceAfter = await getBalance(transceive).catch(() => null);
    return {
      amountSat,
      burned: [entry],
      changeSat,
      changeLoaded,
      balanceAfter,
    };
  } catch (error) {
    if (error instanceof PhaseError) {
      error.paid = true;
      throw error;
    }
    throw new PhaseError(PHASE_AFTER_SWAP, error, {paid: true});
  }
}

/** Post-swap bookkeeping: a failure names its step, never the stage's. */
async function recordingPayment<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new PhaseError(PHASE_RECORDING_PAYMENT, error);
  }
}
