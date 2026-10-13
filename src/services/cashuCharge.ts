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
  CardNeedsUpdateError,
  getBalance,
  getCard,
  getChange,
  getDleqs,
  getInfo,
  getPieces,
  getPubkey,
  isAlreadyOnCard,
  loadProof,
  selectApplet,
  verifyCardPin,
  toHex,
  type CardInfo,
  type CardProofSlot,
  type CardRecord,
  type ChangeOpening,
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
  type OwedChangeEntry,
  type SettlementEntry,
  type SettlementInput,
} from './cashuSettlement';
import {pow2PieceCount} from '../utils/denominations';

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

/** The copy for a card whose pieces cannot be checked offline, with the mint out of reach. */
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
 * Rank the ways to cover `amountSat` from the card's unspent slots, cheapest
 * change first. A proof is atomic, so "enter amount" means coin selection:
 * exact subsets when the denominations allow, otherwise the smallest
 * over-cover. Greedy largest-first is NOT among the strategies — burning a
 * 256-sat proof for a 14-sat bill would demand 242 sat of change from a till
 * that may hold pocket change (found in the field).
 *
 * Candidates are deduplicated by slot-set and sorted by change; the caller
 * walks them until one fits the card (`selectFittingPlan`).
 */
export interface PurchasePlan {
  slots: number[];
  burnedSat: number;
  changeSat: number;
}

export function planPurchase(
  unspent: (Pick<CardProofSlot, 'slot' | 'amount'> & {date?: number})[],
  amountSat: number,
): PurchasePlan[] {
  if (amountSat <= 0) {
    return [];
  }
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
        ),
      ),
    );
  }
  return planOneDate(unspent, amountSat);
}

/** Every date's candidates in one ranking, as `planOneDate` ranks one. */
function mergePlans(groups: PurchasePlan[][]): PurchasePlan[] {
  return groups
    .flat()
    .sort(
      (a, b) => a.changeSat - b.changeSat || a.slots.length - b.slots.length,
    )
    .slice(0, 8);
}

function planOneDate(
  unspent: Pick<CardProofSlot, 'slot' | 'amount'>[],
  amountSat: number,
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

  // Dedupe by slot-set, cheapest change first, fewest slots as tiebreak.
  const seen = new Set<string>();
  return candidates
    .sort(
      (a, b) => a.changeSat - b.changeSat || a.slots.length - b.slots.length,
    )
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
 * change. An exact plan (`changeSat` 0) always fits. `null` when none does.
 */
export function selectFittingPlan(
  plans: PurchasePlan[],
  freeSlots: number,
): PurchasePlan | null {
  return plans.find(p => pow2PieceCount(p.changeSat) <= freeSlots) ?? null;
}

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
  unspent: CardProofSlot[];
  cardPubkey: string;
  /**
   * Ask for the PIN before session 2: the card has one and its no-PIN
   * allowance does not cover the bill.
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
  if (info.pinState === 'locked') {
    throw new Error('card PIN is blocked — the card must be re-provisioned');
  }
  const record = await step('reading card', () => getCard(transceive));
  const cardPubkey = await step('reading card', () =>
    getPubkey(transceive).then(toHex),
  );
  const {unspent, spent} = await step('reading card', () =>
    getPieces(transceive),
  );
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
  const pinRequired = pinSet && !allowanceCovers(info, amountSat);
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
  const emptySlots = info.maxSlots - unspent.length - spent.length;
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
  let plan = selectFittingPlan(plans, room(owedChange.length));
  if (!plan) {
    plan = selectFittingPlan(plans, Math.min(emptySlots, freeOpenings));
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
  }

  // NUT-12, offline: each planned piece's DLEQ, checked with the mint keys
  // kept on this terminal. A piece that cannot be checked here (no proof
  // kept with it, one that does not verify, no keys) is accepted only when
  // the mint is there to swap it in the same tap.
  const chosen = plan.slots.map(slot => unspent.find(p => p.slot === slot)!);
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
    owedChange,
  };
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
  unspent: CardProofSlot[];
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

/** The keysets of the planned pieces, from what is kept or, failing that, the mint. */
async function plannedKeysets(
  mintUrl: string,
  pieces: CardProofSlot[],
): Promise<CachedKeyset[]> {
  const out: CachedKeyset[] = [];
  for (const piece of pieces) {
    let keyset: CachedKeyset;
    try {
      keyset = await keysetFor(mintUrl, piece.keysetId, {online: false});
    } catch {
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

  // Session 2 opens a FRESH IsoDep channel: the card's active applet resets
  // to the default, so the applet SELECT must run again before any gated
  // command — without it Android answers 0x6E00 (CLA not supported) for
  // every verify/burn. Idempotent for the one-session wrapper.
  await step('reading card', () => selectApplet(transceive));

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
  await recoverNeedsCard({transceive, cardPubkey, now}).catch(() => []);

  // Everything the swap will produce, made BEFORE the card signs (SIG_ALL
  // binds the outputs): the inputs' secrets, the merchant's outputs. No APDU.
  const pieces = plan.slots.map(slot => unspent.find(p => p.slot === slot)!);
  const changeSat = plan.changeSat;
  const prepared = await step(PHASE_PREPARING, async () => {
    // Whenever this charge needs the mint at all — its pieces could not all
    // be checked offline, or it is about to make the card's own change —
    // ask once, up front, and refresh what is cached from the answer
    // (ENG-674 should-fix: SIG_ALL binds the change keyset's `active` flag
    // and fee into the outputs for good, so a stale cache must never decide
    // them). A charge that needs neither never touches the network, exactly
    // as before.
    const needsMint = requiresOnline || changeSat > 0;
    const online = needsMint && (await mintReachable(mintUrl));
    if (requiresOnline && !online) {
      throw new Error(ONLINE_ONLY);
    }
    if (changeSat > 0 && !online) {
      // The card is about to sign for change the mint has not been asked
      // about since whatever this terminal last cached — never (ENG-674
      // blocking 2a). Refused here, before SPEND_ALL_BEGIN: nothing burns.
      throw new Error(CHANGE_NEEDS_MINT);
    }
    if (online) {
      await refreshKeysets(mintUrl);
    }
    const keysets = await plannedKeysets(mintUrl, pieces);
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
  const {entry, signed} = spent;

  let changeLoaded = 0;
  /** Sats of change the card has answered for this session. */
  let changeLoadedSat = 0;
  // ONE ATOMIC SWAP is the whole online settlement: the burned pieces go in
  // under the card's one witness; out come the merchant's take and the
  // card's own change, exactly as the card signed them. Exact bills
  // (changeSat = 0) settle here too — deferring them to the drain left the
  // merchant's money queued on a silent drain failure. OFFLINE (or a
  // signature the card could not give again): the swap does not happen and,
  // when nothing must be written back onto the card this session, the
  // payment holds in the queue for the next online auto-run.
  let swapped: SwapSignedResult | null = null;
  if (!signed) {
    // The card burned the payment but its signature was lost: recorded
    // `needs-card`, recovered by SPEND_ALL_AGAIN at this card's next tap
    // (before a new payment begins). No swap was attempted, so there is
    // nothing to classify — the card has already burned, so change due
    // from THIS payment stays owed until the signature is recovered and the
    // drain can swap it in; a retry would burn the card again for the same
    // bill.
    if (changeSat > 0) {
      throw new PhaseError(
        PHASE_SETTLING_CHANGE_OWED,
        new Error(
          "the card burned the payment and its signature was lost; it is recovered at the card's next tap",
        ),
        {paid: true},
      );
    }
    // Exact bill: nothing owed back onto the card either way — the
    // needs-card entry recovers on its own at a later tap.
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
        throw new PhaseError(PHASE_SETTLING, mapped);
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
      //    above the float reserve to the account address). Like the change,
      //    it exists only in this process until it is written: a settlement
      //    queue that refuses the write below must not drop it.
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
