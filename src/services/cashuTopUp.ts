/**
 * Card top-up (ENG-853): the POS phone does the till's job for a Cashu card.
 *
 *   1. `roundTopUp` rounds the amount to at most three power-of-two pieces.
 *   2. `startTopUp` gets a bolt11 mint quote at the card's own mint
 *      (`CardRecord.mint`, never the merchant's) and records it, `waiting`,
 *      before any QR is shown.
 *   3. `pollTopUp` asks the mint for the quote's state; the mint is the truth
 *      (a payment made after Cancel is still honoured, and only an UNPAID
 *      quote past its expiry is `expired`).
 *   4. `loadTopUp`, on the card's tap: the outputs are made and KEPT before
 *      the mint is asked, the mint signs them (or NUT-09 restore finds what it
 *      signed), and each piece goes on with `LOAD_PROOF`, write-ahead.
 *
 * The record lives in its own store, `@cashu_topups`, with the owed-change
 * store's rules (an unreadable store throws, never reads as empty; a corrupt
 * one is quarantined by content before it is overwritten; only finished
 * entries are ever evicted). It never touches the owed-change store, the
 * settlement queue or `pendingExposure`: a top-up is the holder's money at
 * the card's mint, not the merchant's.
 *
 *   5. `refundTopUp` (ENG-855), instead of the load: behind the same card
 *      and PIN gate, the paid quote is minted onto PLAIN outputs and melted
 *      to the holder's invoice or Lightning address at the same mint. Only
 *      before minting: once the mint signed the card-locked outputs, only the
 *      card can spend the pieces.
 *
 * A paid top-up lives on the phone that made it. Nothing here refunds one
 * whose card can no longer pass the gate (lost, locked or PIN-blocked after
 * payment): see docs/13-cashu-card.md, Known gaps.
 */
import {blindMessage} from '@cashu/cashu-ts';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils';

import {
  CardError,
  CardAuthError,
  CardProtocolError,
  getCard,
  isAlreadyOnCard,
  isAppletNotFound,
  isCardNeedsUpdate,
  loadProof,
  readCard,
  verifyCardPin,
  type CardSummary,
  type Transceiver,
} from './cashuCard';
import {
  buildCardSigAllSecret,
  checkRefundMelt,
  checkTopUpQuote,
  createRefundQuote,
  createTopUpQuote,
  inputFee,
  MeltBudgetError,
  meltRefund,
  mintTopUp,
  restoreTopUp,
  TopUpMintError,
  topUpKeyset,
  type RefundMeltCheck,
  type RefundMeltResult,
  type RefundProof,
  type RefundQuote,
  type TopUpOutput,
  type TopUpQuoteState,
  type TopUpSignature,
} from './cashuMint';
import {outstandingChangeForCard} from './cashuSettlement';
import {getSecureStrict, setSecure} from './secureStorage';

// ── amounts ─────────────────────────────────────────────────────────────────

/** The most one top-up puts on a card, in sats. */
export const MAX_TOPUP_SAT = 100000;

/** The most pieces one top-up takes on the card. */
export const MAX_TOPUP_PIECES = 3;

const bitCount = (n: number): number => {
  let c = 0;
  for (let v = n; v > 0; v = Math.floor(v / 2)) {
    c += v % 2;
  }
  return c;
};

/** Every amount in [1, MAX_TOPUP_SAT] that is at most three powers of two, ascending. */
const ROUNDABLE: number[] = (() => {
  const out: number[] = [];
  for (let a = 0; a < 17; a++) {
    for (let b = a; b < 17; b++) {
      for (let c = b; c < 17; c++) {
        const set = new Set([2 ** a, 2 ** b, 2 ** c]);
        const sum = [...set].reduce((t, v) => t + v, 0);
        if (sum <= MAX_TOPUP_SAT && bitCount(sum) === set.size) {
          out.push(sum);
        }
      }
    }
  }
  return [...new Set(out)].sort((x, y) => x - y);
})();

export interface RoundedTopUp {
  amountSat: number;
  /** The amount's set bits, largest first: one card piece each. */
  pieces: number[];
}

/**
 * The nearest amount to `sat` that is at most three power-of-two pieces, in
 * [1, 100000]; a tie goes to the lower one (100000 → 99328). A non-positive,
 * non-integer or over-100000 amount is refused (`bad_amount`).
 */
export function roundTopUp(sat: number): RoundedTopUp {
  if (!Number.isInteger(sat) || sat <= 0 || sat > MAX_TOPUP_SAT) {
    throw new TopUpError(
      'bad_amount',
      sat > MAX_TOPUP_SAT
        ? `A top-up is at most ${MAX_TOPUP_SAT.toLocaleString('en-US')} sats.`
        : '',
    );
  }
  let best = ROUNDABLE[0];
  for (const candidate of ROUNDABLE) {
    if (Math.abs(candidate - sat) < Math.abs(best - sat)) {
      best = candidate;
    }
  }
  const pieces: number[] = [];
  for (let bit = 16; bit >= 0; bit--) {
    if (Math.floor(best / 2 ** bit) % 2 === 1) {
      pieces.push(2 ** bit);
    }
  }
  return {amountSat: best, pieces};
}

// ── errors and copy ─────────────────────────────────────────────────────────

export type TopUpErrorKind =
  | 'bad_amount'
  | 'card_full'
  | 'slots_held'
  | 'card_locked'
  | 'pin_blocked'
  | 'not_sats'
  | 'no_mint'
  | 'pin_needed'
  | 'wrong_pin'
  | 'not_our_card'
  | 'card_moved'
  | 'not_loaded'
  | 'not_paid'
  | 'expired'
  | 'mint_unreachable'
  | 'mint_timeout'
  | 'refund_unavailable'
  | 'refund_pending'
  | 'refund_failed'
  | 'refunded'
  | 'failed';

/** A top-up refused or stopped, with what the screen tells the merchant. */
export class TopUpError extends Error {
  constructor(
    readonly kind: TopUpErrorKind,
    readonly detail = '',
    readonly triesLeft?: number,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'TopUpError';
  }
}

export interface TopUpCopy {
  title: string;
  body: string;
}

/**
 * Title and body for a top-up that stopped. `paid`: the holder has paid and
 * the top-up waits for the card. Titles follow the Fedimint POS
 * (fedimintcard TopUp.swift) wherever the same condition exists.
 */
export function topUpErrorCopy(
  error: TopUpError | TopUpErrorKind,
  {paid = false}: {paid?: boolean} = {},
): TopUpCopy {
  const e = typeof error === 'string' ? new TopUpError(error) : error;
  const waiting = paid ? ' The top-up is paid and waiting.' : '';
  switch (e.kind) {
    case 'expired':
      return {
        title: 'The invoice expired',
        body: 'Nothing was paid. Make a new invoice to try again.',
      };
    case 'not_loaded':
      return {
        title: 'Not loaded yet',
        body: 'The top-up is paid and waiting. Tap the card to load it.',
      };
    case 'card_full':
      return paid
        ? {
            title: 'This card is full',
            body: `Spend from it, then tap again.${waiting}`,
          }
        : {
            title: 'This card is full',
            body: 'Spend from it first, then top up.',
          };
    case 'slots_held':
      return {
        title: "An unpaid top-up holds this card's room",
        body: "Open it from the card's balance screen, or make a new one after it expires.",
      };
    case 'card_moved':
      return {
        title: 'The card moved away',
        body: `Hold the card still until it's loaded.${waiting}`,
      };
    case 'not_our_card':
      return {
        title: 'Not a card for this till',
        body: `Try the holder's card.${waiting}`,
      };
    case 'mint_unreachable':
      return {
        title: "Can't reach the card's mint",
        body: `Check the network, then try again.${waiting}`,
      };
    case 'mint_timeout':
      return {
        title: 'The mint took too long',
        body: `Try again: the same top-up is never loaded twice.${waiting}`,
      };
    case 'bad_amount':
      return {
        title: "That amount can't go on a card",
        body: e.detail || 'Try a different amount.',
      };
    case 'not_paid':
      return {
        title: 'Not paid yet',
        body: 'The invoice has not been paid. Wait for the payment, then tap the card.',
      };
    case 'wrong_pin':
      return {
        title: 'Wrong PIN',
        body: `${
          e.triesLeft === undefined
            ? ''
            : `${e.triesLeft} ${e.triesLeft === 1 ? 'try' : 'tries'} left. `
        }Try again.${waiting}`,
      };
    case 'pin_needed':
      return {
        title: 'Enter the PIN',
        body: `This card loads only with its PIN.${waiting}`,
      };
    case 'pin_blocked':
      return {
        title: "This card's PIN is blocked",
        body: `The holder's app can unblock it.${waiting}`,
      };
    case 'card_locked':
      return {
        title: 'This card is locked',
        body: `The holder's app can unlock it.${waiting}`,
      };
    case 'not_sats':
      return {
        title: "This card isn't in sats",
        body: 'Only a sats card can be topped up here.',
      };
    case 'no_mint':
      return {
        title: "Can't read the card's mint",
        body: 'Tap the card on the keypad again.',
      };
    case 'refund_unavailable':
      return {
        title: "This top-up can't be refunded",
        body: 'The pieces are locked to this card. Load them.',
      };
    case 'refund_pending':
      return {
        title: 'The refund is on its way',
        body: 'The mint is still paying it. Open the top-up again in a minute.',
      };
    case 'refund_failed':
      return {
        title: 'The refund failed',
        body: e.detail || 'Nothing was sent. Try again.',
      };
    case 'refunded':
      return {
        title: 'Already refunded',
        body: 'This top-up was refunded. Nothing is left to load.',
      };
    case 'failed':
    default:
      return {
        title: 'The top-up failed',
        body: `${e.detail}${waiting}`.trim(),
      };
  }
}

// ── the room check ──────────────────────────────────────────────────────────

/**
 * Why this card cannot take a top-up of `pieces` pieces now, or null when it
 * can. Refused before any quote: a locked card (LOAD answers 6986), a blocked
 * PIN, a card not in sats (GET_CARD unit 0), and fewer free slots than pieces
 * once this card's owed change has its slots (`owedPieces`).
 */
export function canTopUp(
  summary: CardSummary,
  owedPieces: number,
  {unit = 0, pieces = 1}: {unit?: number; pieces?: number} = {},
): TopUpErrorKind | null {
  const {info} = summary;
  if (info.locked) {
    return 'card_locked';
  }
  if (info.pinState === 'blocked') {
    return 'pin_blocked';
  }
  if (unit !== 0) {
    return 'not_sats';
  }
  if (info.empty - Math.max(0, owedPieces) < pieces) {
    return 'card_full';
  }
  return null;
}

// ── the store ───────────────────────────────────────────────────────────────

export const TOPUP_KEY = '@cashu_topups';
export const CORRUPT_TOPUP_KEY = '@cashu_topups_corrupt';
export const TOPUP_SCHEMA_VERSION = 1;
/** Soft cap: only `loaded` and `expired` entries are ever evicted. */
export const MAX_TOPUP_ENTRIES = 200;

/** Content-keyed quarantine slot for an unparsable top-up store. */
export const topUpQuarantineKeyFor = (raw: string): string =>
  `${CORRUPT_TOPUP_KEY}:${bytesToHex(sha256(utf8ToBytes(raw))).slice(0, 16)}`;

/** The top-up store could not be read, or is corrupt and could not be quarantined. */
export class TopUpStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopUpStoreError';
  }
}

export type TopUpState =
  | 'waiting'
  | 'paid'
  | 'loading'
  | 'loaded'
  | 'expired'
  | 'refunding'
  | 'refunded';

export interface TopUpOutputRecord {
  amount: number;
  /** 32 random bytes, hex: the card piece's nonce. */
  nonce: string;
  /** The blinding factor, 64 hex. */
  r: string;
  /** The blinded message, compressed hex. */
  B_: string;
}

export interface TopUpMintedPiece {
  amount: number;
  nonce: string;
  /** The unblinded signature. */
  C: string;
  dleqE: string;
  dleqS: string;
  r: string;
  /** LOAD_PROOF answered a slot, or 6A94 (already on the card). */
  loaded: boolean;
  /**
   * A LOAD_PROOF for this piece was sent (written before the send). A sent
   * piece not yet `loaded` may already be on the card, its reply lost.
   */
  sent?: boolean;
}

/** Where a refund pays: what the holder gave, normalised. */
export interface TopUpRefundDestination {
  kind: 'bolt11' | 'address';
  value: string;
}

/** A refund's plain output: the secret is random, locked to no one. */
export interface TopUpRefundOutput {
  amount: number;
  /** 32 random bytes, hex: the proof's secret. */
  secret: string;
  /** The blinding factor, 64 hex. */
  r: string;
  /** The blinded message, compressed hex. */
  B_: string;
}

/**
 * A refund in flight or done (ENG-855). Every step is written before the
 * network call it guards: the outputs before the mint signs them, the melt
 * quote and `meltSent` before the melt.
 */
export interface TopUpRefund {
  destination: TopUpRefundDestination;
  meltQuoteId: string;
  /** The bolt11 the mint pays (the address's invoice, for an address). */
  request: string;
  /** What the destination receives. */
  amountSat: number;
  /** Shown to the holder: the melt's fee reserve plus the keyset input fee. */
  feeSat: number;
  /** The keyset input fee alone, part of `feeSat`. */
  inputFeeSat: number;
  /** Unix seconds the melt quote expires at; null when the mint gave none. */
  meltExpiry: number | null;
  keysetId: string;
  outputs: TopUpRefundOutput[];
  /** The mint's signatures on `outputs`, unblinded: the proofs melted. */
  proofs?: RefundProof[];
  /** The melt was sent (written before the send): check before re-spending. */
  meltSent?: boolean;
  preimage?: string | null;
  /** NUT-08 change from the reserve: the holder's, kept here, never the till's. */
  change?: RefundProof[];
  changeSat?: number;
}

export interface TopUpEntry {
  /** The mint quote id. */
  topupId: string;
  cardPubkey: string;
  mintUrl: string;
  bolt11: string;
  amountSat: number;
  pieces: number[];
  /** Unix seconds the quote expires at; null when the mint gave none. */
  expiry: number | null;
  state: TopUpState;
  keysetId?: string;
  /** Made and kept BEFORE the mint is asked to sign. */
  outputs?: TopUpOutputRecord[];
  /** The mint's signatures, unblinded, kept as soon as they arrive. */
  minted?: TopUpMintedPiece[];
  /** Set from `refunding` on; present exactly in `refunding` and `refunded`. */
  refund?: TopUpRefund;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

const STATES: ReadonlySet<string> = new Set<TopUpState>([
  'waiting',
  'paid',
  'loading',
  'loaded',
  'expired',
  'refunding',
  'refunded',
]);

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const isProof = (p: Record<string, unknown>): boolean =>
  isText(p?.id) && isNum(p?.amount) && isText(p?.secret) && isText(p?.C);

function isRefund(value: unknown): value is TopUpRefund {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  const dest = r.destination as Record<string, unknown> | undefined;
  return (
    typeof dest === 'object' &&
    dest !== null &&
    (dest.kind === 'bolt11' || dest.kind === 'address') &&
    isText(dest.value) &&
    isText(r.meltQuoteId) &&
    isText(r.request) &&
    isNum(r.amountSat) &&
    isNum(r.feeSat) &&
    isNum(r.inputFeeSat) &&
    (r.meltExpiry === null || isNum(r.meltExpiry)) &&
    isText(r.keysetId) &&
    Array.isArray(r.outputs) &&
    r.outputs.length > 0 &&
    r.outputs.every(
      (o: Record<string, unknown>) =>
        isNum(o?.amount) && isText(o?.secret) && isText(o?.r) && isText(o?.B_),
    ) &&
    (r.proofs === undefined ||
      (Array.isArray(r.proofs) && r.proofs.every(isProof))) &&
    (r.meltSent === undefined || typeof r.meltSent === 'boolean') &&
    (r.preimage === undefined ||
      r.preimage === null ||
      typeof r.preimage === 'string') &&
    (r.change === undefined ||
      (Array.isArray(r.change) && r.change.every(isProof))) &&
    (r.changeSat === undefined || isNum(r.changeSat))
  );
}

function isTopUpEntry(value: unknown): value is TopUpEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  const outputsOk =
    e.outputs === undefined ||
    (Array.isArray(e.outputs) &&
      e.outputs.every(
        (o: Record<string, unknown>) =>
          isNum(o?.amount) && isText(o?.nonce) && isText(o?.r) && isText(o?.B_),
      ));
  const mintedOk =
    e.minted === undefined ||
    (Array.isArray(e.minted) &&
      e.minted.every(
        (m: Record<string, unknown>) =>
          isNum(m?.amount) &&
          isText(m?.nonce) &&
          isText(m?.C) &&
          isText(m?.dleqE) &&
          isText(m?.dleqS) &&
          isText(m?.r) &&
          typeof m?.loaded === 'boolean' &&
          (m?.sent === undefined || typeof m?.sent === 'boolean'),
      ));
  const refunding = e.state === 'refunding' || e.state === 'refunded';
  const refundOk = refunding ? isRefund(e.refund) : e.refund === undefined;
  return (
    isText(e.topupId) &&
    isText(e.cardPubkey) &&
    isText(e.mintUrl) &&
    isText(e.bolt11) &&
    isNum(e.amountSat) &&
    Array.isArray(e.pieces) &&
    e.pieces.every(isNum) &&
    (e.expiry === null || isNum(e.expiry)) &&
    typeof e.state === 'string' &&
    STATES.has(e.state) &&
    (e.keysetId === undefined || isText(e.keysetId)) &&
    outputsOk &&
    mintedOk &&
    refundOk &&
    isNum(e.attempts) &&
    (e.lastError === undefined || typeof e.lastError === 'string') &&
    isNum(e.createdAt) &&
    isNum(e.updatedAt)
  );
}

interface TopUpRead {
  entries: TopUpEntry[];
  corrupt: boolean;
  corruptionRecorded: boolean;
}

const quarantineWritten = new Set<string>();

/** Keep unparsable bytes under a content key; true once that copy landed. */
async function quarantine(raw: string): Promise<boolean> {
  const key = topUpQuarantineKeyFor(raw);
  if (quarantineWritten.has(key)) {
    return true;
  }
  try {
    await setSecure(key, raw);
    quarantineWritten.add(key);
  } catch {
    return false;
  }
  try {
    await setSecure(CORRUPT_TOPUP_KEY, raw);
  } catch {
    // The pointer is a convenience; the content-keyed copy is the record.
  }
  return true;
}

async function loadTopUps(): Promise<TopUpRead> {
  let raw: string | null;
  try {
    raw = await getSecureStrict(TOPUP_KEY);
  } catch (error) {
    throw new TopUpStoreError(
      `top-up store unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!raw) {
    return {entries: [], corrupt: false, corruptionRecorded: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      entries: [],
      corrupt: true,
      corruptionRecorded: await quarantine(raw),
    };
  }
  const env = parsed as {v?: unknown; entries?: unknown};
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !isNum(env.v) ||
    env.v < 1 ||
    !Array.isArray(env.entries)
  ) {
    return {
      entries: [],
      corrupt: true,
      corruptionRecorded: await quarantine(raw),
    };
  }
  // A newer version's entries ride through untouched (`filter` keeps the
  // original objects), as in the owed-change store.
  const entries = env.entries.filter(isTopUpEntry);
  if (entries.length !== env.entries.length) {
    return {entries, corrupt: true, corruptionRecorded: await quarantine(raw)};
  }
  return {entries, corrupt: false, corruptionRecorded: false};
}

let tail: Promise<unknown> = Promise.resolve();

/** Serialised read-modify-write; refuses to overwrite corrupt bytes it could not quarantine. */
function withTopUps<T>(fn: (read: TopUpRead) => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    const read = await loadTopUps();
    if (read.corrupt && !read.corruptionRecorded) {
      throw new TopUpStoreError(
        'top-up store is corrupt and could not be quarantined; refusing to overwrite it',
      );
    }
    return fn(read);
  });
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function evict(entries: TopUpEntry[]): TopUpEntry[] {
  let overBy = entries.length - MAX_TOPUP_ENTRIES;
  if (overBy <= 0) {
    return entries;
  }
  const drop = new Set<TopUpEntry>();
  const finished = entries
    .filter(e => e.state === 'loaded' || e.state === 'expired')
    .sort((a, b) => a.updatedAt - b.updatedAt);
  for (const e of finished) {
    if (overBy <= 0) {
      break;
    }
    drop.add(e);
    overBy--;
  }
  return entries.filter(e => !drop.has(e));
}

async function writeTopUps(entries: TopUpEntry[]): Promise<void> {
  await setSecure(
    TOPUP_KEY,
    JSON.stringify({v: TOPUP_SCHEMA_VERSION, entries: evict(entries)}),
  );
}

/** Every top-up on this phone. Throws `TopUpStoreError` when the store will not read. */
export async function listTopUps(): Promise<TopUpEntry[]> {
  const {entries, corrupt, corruptionRecorded} = await loadTopUps();
  if (corrupt && !corruptionRecorded) {
    throw new TopUpStoreError(
      'top-up store is corrupt and could not be quarantined; top-ups unknown',
    );
  }
  return entries;
}

/** One top-up by its quote id, or null. */
export async function getTopUp(topupId: string): Promise<TopUpEntry | null> {
  return (await listTopUps()).find(e => e.topupId === topupId) ?? null;
}

async function addTopUp(entry: TopUpEntry): Promise<void> {
  await withTopUps(async ({entries}) => {
    if (entries.some(e => e.topupId === entry.topupId)) {
      throw new TopUpStoreError(`top-up ${entry.topupId} is already recorded`);
    }
    await writeTopUps([...entries, entry]);
  });
}

async function patchTopUp(
  topupId: string,
  patch: (e: TopUpEntry) => TopUpEntry,
): Promise<TopUpEntry> {
  return withTopUps(async ({entries}) => {
    const idx = entries.findIndex(e => e.topupId === topupId);
    if (idx === -1) {
      throw new TopUpStoreError(`top-up ${topupId} is not recorded`);
    }
    const next = {...patch(entries[idx]), updatedAt: Date.now()};
    const copy = entries.slice();
    copy[idx] = next;
    await writeTopUps(copy);
    return next;
  });
}

/** Test seam: forget the serialising tail and the quarantine memo. */
export function __resetTopUpStore(): void {
  tail = Promise.resolve();
  quarantineWritten.clear();
}

// ── the flow ────────────────────────────────────────────────────────────────

const mintFailure = (error: unknown): TopUpError => {
  if (error instanceof TopUpError) {
    return error;
  }
  if (error instanceof TopUpMintError) {
    return new TopUpError(
      error.kind === 'timeout' ? 'mint_timeout' : 'mint_unreachable',
      error.message,
    );
  }
  return new TopUpError(
    'failed',
    error instanceof Error ? error.message : String(error),
  );
};

/** The mint URL as two can be compared: lower case, no trailing slash. */
export const normalizeMintUrl = (url: string): string =>
  url.trim().toLowerCase().replace(/\/+$/, '');

/**
 * How many owed-change pieces wait for this card (ENG-630): slots a top-up
 * may not take. An unreadable store counts none here; the card's own LOAD
 * answer (6A84) is the backstop.
 */
export async function owedPiecesFor(cardPubkey: string): Promise<number> {
  try {
    return (await outstandingChangeForCard(cardPubkey)).length;
  } catch {
    return 0;
  }
}

/** A piece of a top-up that may already be on the card (see `sent`). */
const mayBeOnCard = (m: TopUpMintedPiece): boolean => m.loaded || !!m.sent;

/**
 * How long an unpaid quote the mint gave no expiry for (NUT-04 allows none)
 * holds its slots after it was made. The entry itself stays `waiting`, so a
 * payment made later is still honoured; it only stops blocking new top-ups.
 */
export const NULL_EXPIRY_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Does this top-up still hold slots on its card at `now`? A `refunding` or
 * `refunded` one never does: its value leaves by Lightning, not the card.
 */
const holdsSlots = (e: TopUpEntry, now: number): boolean => {
  if (e.state === 'paid' || e.state === 'loading') {
    return true;
  }
  if (e.state !== 'waiting') {
    return false;
  }
  return e.expiry !== null || now < e.createdAt + NULL_EXPIRY_HOLD_MS;
};

/** The slots `entries` still need: unloaded minted pieces, else every piece. */
const piecesHeld = (entries: TopUpEntry[]): number =>
  entries.reduce(
    (n, e) =>
      n +
      (e.minted
        ? e.minted.filter(m => !mayBeOnCard(m)).length
        : e.pieces.length),
    0,
  );

/**
 * The pieces this card's waiting, paid and loading top-ups still need slots
 * for: the minted pieces not yet (possibly) on the card, or every piece when
 * none is minted yet. An unpaid quote holds its slots until the mint reports
 * it paid or expired (ENG-856), so two quotes that cannot both land are never
 * both offered; one with no expiry holds them for `NULL_EXPIRY_HOLD_MS` after
 * it was made. Never throws.
 */
export async function reservedPiecesFor(
  cardPubkey: string,
  now: number = Date.now(),
): Promise<number> {
  return piecesHeld(
    (await waitingTopUpsForCard(cardPubkey)).filter(e => holdsSlots(e, now)),
  );
}

/** As `reservedPiecesFor`, leaving out unpaid (`waiting`) quotes. */
async function reservedByPaidFor(cardPubkey: string): Promise<number> {
  return piecesHeld(
    (await waitingTopUpsForCard(cardPubkey)).filter(
      e => e.state === 'paid' || e.state === 'loading',
    ),
  );
}

export interface StartTopUpArgs {
  summary: CardSummary;
  /** `CardRecord.mint`: the mint the card's pieces belong to. */
  cardMint: string;
  /** `CardRecord.unit`; 0 is sat. */
  unit?: number;
  /**
   * This card's owed-change pieces, whose slots the top-up may not take;
   * read from the owed-change store when not given.
   */
  owedPieces?: number;
  /** What the merchant typed; rounded here. */
  sat: number;
}

/**
 * Round, check the room, quote the rounded amount at the card's mint and
 * record it `waiting`. Throws a `TopUpError`; when the record cannot be
 * written the quote is dropped and no QR may be shown.
 */
export async function startTopUp({
  summary,
  cardMint,
  unit = 0,
  owedPieces,
  sat,
}: StartTopUpArgs): Promise<TopUpEntry> {
  const {amountSat, pieces} = roundTopUp(sat);
  if (!cardMint) {
    throw new TopUpError('no_mint');
  }
  const owed = owedPieces ?? (await owedPiecesFor(summary.pubkey));
  // Ask the mint about this card's unpaid quotes first, so one it reports
  // expired frees its slots now rather than after the next balance read. Best
  // effort: a refresh that fails leaves the stored states to count.
  try {
    await refreshWaitingTopUps(summary.pubkey, {
      timeoutMs: PRECHECK_TIMEOUT_MS,
    });
  } catch {
    // The stored states stand.
  }
  // Slots already promised to this card's other top-ups, paid or still
  // waiting, so nobody pays for a load that cannot land beside them
  // (TOPUP.md § Room on the card).
  const reserved = await reservedPiecesFor(summary.pubkey);
  const refused = canTopUp(summary, owed + reserved, {
    unit,
    pieces: pieces.length,
  });
  if (refused === 'card_full') {
    // Room the card has but an unpaid quote holds: say so, rather than send
    // the merchant to spend from a card that may hold nothing.
    const paidOnly = await reservedByPaidFor(summary.pubkey);
    if (
      paidOnly < reserved &&
      !canTopUp(summary, owed + paidOnly, {unit, pieces: pieces.length})
    ) {
      throw new TopUpError('slots_held');
    }
  }
  if (refused) {
    throw new TopUpError(refused);
  }
  let quote;
  try {
    quote = await createTopUpQuote(cardMint, amountSat);
  } catch (error) {
    throw mintFailure(error);
  }
  const now = Date.now();
  const entry: TopUpEntry = {
    topupId: quote.quoteId,
    cardPubkey: summary.pubkey.toLowerCase(),
    mintUrl: cardMint,
    bolt11: quote.request,
    amountSat,
    pieces,
    expiry: quote.expiry,
    state: 'waiting',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await addTopUp(entry);
  } catch (error) {
    throw new TopUpError(
      'failed',
      `The top-up could not be saved on this phone (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }
  return entry;
}

/**
 * Ask the mint about a `waiting` top-up. PAID or ISSUED makes it `paid`; an
 * UNPAID quote past its expiry makes it `expired`. A poll that throws (the
 * mint unreachable, slow) changes nothing, and nothing local ever expires an
 * entry: Cancel leaves it `waiting`, so a payment made later is honoured.
 * Answers the entry as it now is (null when it is not on this phone).
 */
export async function pollTopUp(
  topupId: string,
  now: number = Date.now(),
  {timeoutMs}: {timeoutMs?: number} = {},
): Promise<TopUpEntry | null> {
  const entry = await getTopUp(topupId);
  if (!entry || entry.state !== 'waiting') {
    return entry;
  }
  let state: TopUpQuoteState;
  try {
    state = await (timeoutMs === undefined
      ? checkTopUpQuote(entry.mintUrl, entry.topupId)
      : checkTopUpQuote(entry.mintUrl, entry.topupId, timeoutMs));
  } catch {
    return entry;
  }
  let next: TopUpState | null = null;
  if (state === 'PAID' || state === 'ISSUED') {
    next = 'paid';
  } else if (entry.expiry !== null && now >= entry.expiry * 1000) {
    next = 'expired';
  }
  if (!next) {
    return entry;
  }
  const target = next;
  try {
    return await patchTopUp(topupId, e =>
      e.state === 'waiting' ? {...e, state: target} : e,
    );
  } catch {
    // The mint's answer stands either way; the next poll writes it.
    return {...entry, state: target};
  }
}

/**
 * The top-ups waiting for this card: paid ones still to load, refunds not yet
 * finished, and quotes not yet confirmed expired. Never throws (a store that
 * will not read is none).
 */
export async function waitingTopUpsForCard(
  cardPubkey: string,
): Promise<TopUpEntry[]> {
  try {
    const key = cardPubkey.toLowerCase();
    return (await listTopUps()).filter(
      e =>
        e.cardPubkey === key &&
        (e.state === 'paid' ||
          e.state === 'loading' ||
          e.state === 'waiting' ||
          e.state === 'refunding'),
    );
  } catch {
    return [];
  }
}

/** What the balance screen shows of a waiting top-up. */
export interface WaitingTopUp {
  topupId: string;
  amountSat: number;
  state: TopUpState;
}

export const toWaitingTopUp = (e: TopUpEntry): WaitingTopUp => ({
  topupId: e.topupId,
  amountSat: e.amountSat,
  state: e.state,
});

/**
 * The quote-check deadline of `startTopUp`'s best-effort refresh: a slow mint
 * should not hold the Create tap for the full `TOPUP_MINT_TIMEOUT_MS`.
 */
export const PRECHECK_TIMEOUT_MS = 5000;

/**
 * One quote check for each `waiting` top-up of this card (a payment that
 * landed after Cancel), all at once, then what is still waiting. Never throws.
 */
export async function refreshWaitingTopUps(
  cardPubkey: string,
  {timeoutMs}: {timeoutMs?: number} = {},
): Promise<TopUpEntry[]> {
  const waiting = await waitingTopUpsForCard(cardPubkey);
  await Promise.all(
    waiting
      .filter(w => w.state === 'waiting')
      // A poll that will not run leaves the entry as it was.
      .map(e =>
        pollTopUp(e.topupId, Date.now(), {timeoutMs}).catch(() => null),
      ),
  );
  return waitingTopUpsForCard(cardPubkey);
}

export interface LoadTopUpArgs {
  topupId: string;
  transceive: Transceiver;
  /** The card's PIN; required when it has one. */
  pin?: string;
  onPhase?: (phase: 'reading' | 'minting' | 'loading') => void;
}

export interface LoadTopUpResult {
  amountSat: number;
  /** The quote id's first 8 characters: what the merchant can quote back. */
  loadId: string;
}

const result = (entry: TopUpEntry): LoadTopUpResult => ({
  amountSat: entry.amountSat,
  loadId: entry.topupId.slice(0, 8),
});

const isTransport = (error: unknown): boolean =>
  !(
    error instanceof CardError ||
    error instanceof CardProtocolError ||
    error instanceof CardAuthError ||
    error instanceof TopUpError ||
    isCardNeedsUpdate(error)
  );

/** A failure reading the card, before anything was written. */
function readFailure(error: unknown): TopUpError {
  if (error instanceof TopUpError) {
    return error;
  }
  if (
    error instanceof CardAuthError ||
    isCardNeedsUpdate(error) ||
    isAppletNotFound(error)
  ) {
    return new TopUpError('not_our_card', String(error));
  }
  if (isTransport(error)) {
    return new TopUpError('not_loaded', String(error));
  }
  return new TopUpError(
    'failed',
    error instanceof Error ? error.message : String(error),
  );
}

/** Ask the mint for the signatures on the kept outputs, without ever making new ones. */
async function obtainSignatures(
  entry: TopUpEntry,
  outputs: TopUpOutput[],
): Promise<TopUpSignature[]> {
  let quoteState: TopUpQuoteState | null = null;
  try {
    quoteState = await checkTopUpQuote(entry.mintUrl, entry.topupId);
  } catch {
    quoteState = null;
  }
  if (quoteState === 'UNPAID') {
    throw new TopUpError('not_paid');
  }
  let mintError: unknown = null;
  if (quoteState !== 'ISSUED') {
    // The same outputs every time: a mint that already signed them refuses
    // the repeat, and a mint that never got the first request signs now.
    try {
      return await mintTopUp(entry.mintUrl, entry.topupId, outputs);
    } catch (error) {
      mintError = error;
    }
  }
  // Issued, or the outcome is unknown: NUT-09 finds what the mint signed.
  let restored: TopUpSignature[] | null;
  try {
    restored = await restoreTopUp(entry.mintUrl, outputs);
  } catch (error) {
    throw mintFailure(mintError ?? error);
  }
  if (restored) {
    return restored;
  }
  throw mintFailure(
    mintError ??
      new Error(
        'the mint issued this top-up to outputs this phone did not keep',
      ),
  );
}

/**
 * The gate a load and a refund both pass, before anything is written: the
 * card this top-up is for (its key and its mint), not locked, its PIN not
 * blocked, and its PIN verified when it has one — even when the change grant
 * would let a LOAD through. Answers the card's summary.
 */
async function verifyCardForTopUp(
  entry: TopUpEntry,
  transceive: Transceiver,
  pin: string | undefined,
  onPhase: (phase: 'reading') => void,
): Promise<CardSummary> {
  onPhase('reading');
  let summary: CardSummary;
  let cardMint: string;
  try {
    summary = await readCard(transceive);
    cardMint = (await getCard(transceive)).mint;
  } catch (error) {
    throw readFailure(error);
  }
  if (
    summary.pubkey.toLowerCase() !== entry.cardPubkey.toLowerCase() ||
    normalizeMintUrl(cardMint) !== normalizeMintUrl(entry.mintUrl)
  ) {
    throw new TopUpError('not_our_card');
  }
  if (summary.info.locked) {
    throw new TopUpError('card_locked');
  }
  if (summary.info.pinState === 'blocked') {
    throw new TopUpError('pin_blocked');
  }
  if (summary.info.pinState === 'set') {
    if (!pin) {
      throw new TopUpError('pin_needed');
    }
    try {
      await verifyCardPin(transceive, pin);
    } catch (error) {
      // 63CX: a wrong PIN, X tries left.
      if (error instanceof CardError && Math.floor(error.sw / 16) === 0x63c) {
        throw new TopUpError('wrong_pin', '', error.sw % 16);
      }
      if (error instanceof CardError && error.sw === 0x6983) {
        throw new TopUpError('pin_blocked');
      }
      throw readFailure(error);
    }
  }
  return summary;
}

/** A refund under way or done owns the entry: a load stops before the card. */
function refuseIfRefund(e: TopUpEntry): void {
  if (e.state === 'refunding') {
    throw new TopUpError('refund_pending');
  }
  if (e.state === 'refunded') {
    throw new TopUpError('refunded');
  }
}

/** The card-locked pieces, from the kept outputs and the mint's signatures. */
const mintedFrom = (
  kept: TopUpOutputRecord[],
  signatures: TopUpSignature[],
): TopUpMintedPiece[] =>
  kept.map((o, i) => ({
    amount: o.amount,
    nonce: o.nonce,
    C: signatures[i].C,
    dleqE: signatures[i].dleq.e,
    dleqS: signatures[i].dleq.s,
    r: o.r,
    loaded: false,
  }));

async function noteError(topupId: string, error: unknown): Promise<void> {
  try {
    await patchTopUp(topupId, e => ({
      ...e,
      lastError: error instanceof Error ? error.message : String(error),
    }));
  } catch {
    // Bookkeeping only; the card's answer is what the caller acts on.
  }
}

/**
 * Put a paid top-up on the card, inside one card session. Resumable at every
 * step: the outputs are kept before the mint is asked, the signatures as
 * soon as they come, each LOAD's attempt before it is sent, each piece's
 * landing after. A `loaded` entry answers without touching the card.
 *
 * Throws a `TopUpError`; the entry stays `paid` (nothing minted yet) or
 * `loading` (the remainder), and the next tap goes on from there.
 */
export async function loadTopUp({
  topupId,
  transceive,
  pin,
  onPhase = () => {},
}: LoadTopUpArgs): Promise<LoadTopUpResult> {
  let entry: TopUpEntry | null;
  try {
    entry = await getTopUp(topupId);
  } catch (error) {
    throw new TopUpError('failed', String(error));
  }
  if (!entry) {
    throw new TopUpError('failed', 'This top-up is not on this phone.');
  }
  if (entry.state === 'loaded') {
    return result(entry);
  }
  if (entry.state === 'expired') {
    throw new TopUpError('expired');
  }
  refuseIfRefund(entry);
  if (entry.state === 'waiting') {
    let state: TopUpQuoteState;
    try {
      state = await checkTopUpQuote(entry.mintUrl, entry.topupId);
    } catch (error) {
      throw mintFailure(error);
    }
    if (state === 'UNPAID') {
      throw new TopUpError('not_paid');
    }
    try {
      entry = await patchTopUp(topupId, e =>
        e.state === 'waiting' ? {...e, state: 'paid'} : e,
      );
    } catch {
      entry = {...entry, state: 'paid'};
    }
  }

  // 1-2. The card this top-up is for, at this mint, and its PIN.
  const summary = await verifyCardForTopUp(entry, transceive, pin, onPhase);

  // 3. Room for what is still to load, beside this card's owed change. A
  // piece already sent may be on the card with its reply lost: it is not
  // charged a slot here (its resend answers 6A94, or takes the slot it needs
  // and 6A84 in the loop catches a real shortfall).
  const remaining = entry.minted
    ? entry.minted.filter(m => !mayBeOnCard(m)).length
    : entry.pieces.length;
  const owedPieces = await owedPiecesFor(summary.pubkey);
  if (summary.info.empty - owedPieces < remaining) {
    throw new TopUpError('card_full');
  }

  // 4. The outputs, kept before the mint signs them; then the signatures.
  if (!entry.outputs || !entry.keysetId) {
    onPhase('minting');
    let keysetId: string;
    try {
      keysetId = (await topUpKeyset(entry.mintUrl, entry.pieces)).id;
    } catch (error) {
      throw mintFailure(error);
    }
    const outputs: TopUpOutputRecord[] = entry.pieces.map(amount => {
      const nonce = bytesToHex(randomBytes(32));
      const secret = buildCardSigAllSecret(nonce, entry!.cardPubkey);
      const {B_, r} = blindMessage(utf8ToBytes(secret));
      return {
        amount,
        nonce,
        r: r.toString(16).padStart(64, '0'),
        B_: bytesToHex(B_.toBytes(true)),
      };
    });
    try {
      entry = await patchTopUp(topupId, e => {
        // A refund written since this load read the entry owns it now.
        refuseIfRefund(e);
        return {...e, keysetId, outputs, state: 'loading'};
      });
    } catch (error) {
      if (error instanceof TopUpError) {
        throw error;
      }
      // Nothing was sent to the mint: the next tap makes new outputs.
      throw new TopUpError(
        'failed',
        `The top-up could not be saved on this phone (${String(error)}).`,
      );
    }
  }
  if (!entry.minted) {
    onPhase('minting');
    const keysetId = entry.keysetId!;
    const kept = entry.outputs!;
    const signatures = await obtainSignatures(
      entry,
      kept.map(o => ({amount: o.amount, keysetId, B_: o.B_, r: o.r})),
    );
    const minted = mintedFrom(kept, signatures);
    try {
      // The mint signed the card's outputs: they are the truth, whatever a
      // refund wrote meanwhile (its own outputs can no longer be signed).
      entry = await patchTopUp(topupId, e => ({
        ...e,
        minted,
        state: 'loading',
        refund: undefined,
      }));
    } catch {
      // The kept outputs are enough: a later restore finds these signatures.
      entry = {...entry, minted};
    }
  }

  // 5. Each piece still to load, write-ahead.
  onPhase('loading');
  let sent = 0;
  for (let i = 0; i < entry.minted!.length; i++) {
    const piece = entry.minted![i];
    if (piece.loaded) {
      continue;
    }
    try {
      const at = i;
      entry = await patchTopUp(topupId, e => {
        refuseIfRefund(e);
        return {
          ...e,
          attempts: e.attempts + 1,
          minted: e.minted?.map((m, j) => (j === at ? {...m, sent: true} : m)),
        };
      });
    } catch (error) {
      if (error instanceof TopUpError) {
        throw error;
      }
      // The attempt is not recorded, so nothing is sent.
      throw new TopUpError('not_loaded', String(error));
    }
    try {
      await loadProof(
        transceive,
        {
          keysetId: entry.keysetId!,
          amount: piece.amount,
          nonce: piece.nonce,
          C: piece.C,
          date: 0,
        },
        {e: piece.dleqE, s: piece.dleqS, r: piece.r},
      );
    } catch (error) {
      if (!isAlreadyOnCard(error)) {
        if (error instanceof CardError) {
          // A definite refusal: the piece is not on the card, so it needs a
          // slot again. A lost link keeps `sent` (the card may have it).
          const at = i;
          try {
            await patchTopUp(topupId, e => ({
              ...e,
              minted: e.minted?.map((m, j) =>
                j === at ? {...m, sent: false} : m,
              ),
            }));
          } catch {
            // Bookkeeping only; the card's answer is what the caller acts on.
          }
        }
        await noteError(topupId, error);
        if (error instanceof CardError && error.sw === 0x6a84) {
          throw new TopUpError('card_full');
        }
        if (error instanceof CardError && error.sw === 0x6986) {
          throw new TopUpError('card_locked');
        }
        if (isTransport(error)) {
          throw new TopUpError(sent > 0 ? 'card_moved' : 'not_loaded');
        }
        throw new TopUpError(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    sent++;
    const index = i;
    try {
      entry = await patchTopUp(topupId, e => ({
        ...e,
        minted: e.minted?.map((m, j) =>
          j === index ? {...m, loaded: true} : m,
        ),
      }));
    } catch {
      // The piece is on the card; a resend answers 6A94 and counts as landed.
      entry = {
        ...entry,
        minted: entry.minted!.map((m, j) =>
          j === index ? {...m, loaded: true} : m,
        ),
      };
    }
  }
  try {
    entry = await patchTopUp(topupId, e => ({
      ...e,
      state: 'loaded',
      lastError: undefined,
    }));
  } catch {
    // Every piece is on the card; the record catches up on the next tap.
  }
  return result(entry);
}

// ── refund (ENG-855) ────────────────────────────────────────────────────────

/**
 * What the holder gave, normalised: trimmed, `lightning:` dropped, lower
 * case. A bolt11 starts `lnbc`/`lntb`-like (`/^lnb[ct]/`, as CashuCardSpend);
 * anything else must look like a Lightning address.
 */
export function normalizeRefundDestination(
  raw: string,
): TopUpRefundDestination {
  const value = raw
    .trim()
    .replace(/^lightning:/i, '')
    .trim()
    .toLowerCase();
  if (/^lnb[ct]/i.test(value)) {
    return {kind: 'bolt11', value};
  }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return {kind: 'address', value};
  }
  throw new TopUpError(
    'refund_failed',
    value
      ? "That isn't a Lightning invoice or address."
      : 'Enter a Lightning invoice or address.',
  );
}

const meltDestination = (d: TopUpRefundDestination) =>
  d.kind === 'bolt11' ? {bolt11: d.value} : {lightningAddress: d.value};

/** A refund's mint step that did not go: the mint's own words, or its silence. */
function refundFailure(
  error: unknown,
  kind: TopUpRefundDestination['kind'] = 'bolt11',
): TopUpError {
  if (error instanceof TopUpError) {
    return error;
  }
  if (error instanceof TopUpMintError) {
    return mintFailure(error);
  }
  if (error instanceof MeltBudgetError) {
    const fits = error.budgetSat - error.feeReserveSat;
    const reserve = error.feeReserveSat.toLocaleString('en-US');
    const least = (error.feeReserveSat + 1).toLocaleString('en-US');
    return new TopUpError(
      'refund_failed',
      fits > 0 && kind === 'bolt11'
        ? `The invoice is too large. Ask for one of at most ${fits.toLocaleString(
            'en-US',
          )} sats.`
        : `This top-up is too small to refund over Lightning. The mint holds back ${reserve} sats for the Lightning fee, so a refund needs at least ${least} sats.`,
    );
  }
  return new TopUpError(
    'refund_failed',
    error instanceof Error ? error.message : String(error),
  );
}

async function readEntry(topupId: string): Promise<TopUpEntry> {
  let entry: TopUpEntry | null;
  try {
    entry = await getTopUp(topupId);
  } catch (error) {
    throw new TopUpError('failed', String(error));
  }
  if (!entry) {
    throw new TopUpError('failed', 'This top-up is not on this phone.');
  }
  return entry;
}

interface RefundPrice {
  quote: RefundQuote;
  keysetId: string;
  inputFeeSat: number;
}

/**
 * Can this entry be refunded now, and for how much (steps 2-3 of the plan)?
 *
 * - `paid` or `loading` with nothing minted, and the mint quote PAID: yes.
 *   ISSUED (the card's pieces exist) or anything minted: `refund_unavailable`.
 * - `refunding` whose melt has not gone (a new destination after the first
 *   one's invoice expired): yes, with the outputs it already has.
 * - `waiting`: `not_paid`; `refunded`: `refunded`; else `refund_unavailable`.
 *
 * Quotes a melt for the amount less the keyset input fee. Persists nothing.
 */
async function priceRefund(
  entry: TopUpEntry,
  destination: TopUpRefundDestination,
): Promise<RefundPrice> {
  if (entry.state === 'refunded') {
    throw new TopUpError('refunded');
  }
  if (entry.state === 'waiting') {
    throw new TopUpError('not_paid');
  }
  if (entry.state === 'expired') {
    throw new TopUpError('expired');
  }
  let keysetId: string;
  let inputFeeSat: number;
  if (entry.state === 'refunding' && entry.refund) {
    const {refund} = entry;
    if (refund.meltSent) {
      let check: RefundMeltCheck;
      try {
        check = await checkRefundMelt(entry.mintUrl, refund.meltQuoteId);
      } catch (error) {
        throw mintFailure(error);
      }
      if (check.state !== 'UNPAID') {
        // Paid or paying: the destination is settled, resume finishes it.
        throw new TopUpError('refund_pending');
      }
    }
    keysetId = refund.keysetId;
    inputFeeSat = refund.inputFeeSat;
  } else if (
    (entry.state === 'paid' || entry.state === 'loading') &&
    !entry.minted
  ) {
    let state: TopUpQuoteState;
    try {
      state = await checkTopUpQuote(entry.mintUrl, entry.topupId);
    } catch (error) {
      throw mintFailure(error);
    }
    if (state === 'UNPAID') {
      throw new TopUpError('not_paid');
    }
    if (state === 'ISSUED') {
      throw new TopUpError('refund_unavailable');
    }
    let keyset: Awaited<ReturnType<typeof topUpKeyset>>;
    try {
      keyset = await topUpKeyset(entry.mintUrl, entry.pieces);
    } catch (error) {
      throw mintFailure(error);
    }
    keysetId = keyset.id;
    inputFeeSat = inputFee(keyset, entry.pieces.length);
  } else {
    throw new TopUpError('refund_unavailable');
  }
  const budgetSat = entry.amountSat - inputFeeSat;
  if (budgetSat <= 0) {
    throw new TopUpError(
      'refund_failed',
      'The mint fee is larger than the top-up.',
    );
  }
  let quote: RefundQuote;
  try {
    quote = await createRefundQuote(
      entry.mintUrl,
      meltDestination(destination),
      budgetSat,
    );
  } catch (error) {
    throw refundFailure(error, destination.kind);
  }
  // The mint gives back as change everything the invoice does not ask
  // for, and change stays on this phone: refuse an invoice that would leave
  // more than one fee reserve behind (the value is the holder's).
  const slackSat = budgetSat - quote.amountSat - quote.feeReserveSat;
  if (slackSat > quote.feeReserveSat) {
    throw new TopUpError(
      'refund_failed',
      `The invoice is too small. Ask for one of ${(
        budgetSat - quote.feeReserveSat
      ).toLocaleString('en-US')} sats.`,
    );
  }
  return {quote, keysetId, inputFeeSat};
}

export interface TopUpRefundPreview {
  /** What the destination receives. */
  netSat: number;
  /** At most what the mint keeps: the fee reserve plus the input fee. */
  feeSat: number;
  destination: TopUpRefundDestination;
}

/**
 * What a refund of this top-up to `destination` would pay, before the card:
 * no card, nothing persisted. Throws a `TopUpError`.
 */
export async function previewTopUpRefund({
  topupId,
  destination,
}: {
  topupId: string;
  destination: string;
}): Promise<TopUpRefundPreview> {
  const dest = normalizeRefundDestination(destination);
  const entry = await readEntry(topupId);
  const {quote, inputFeeSat} = await priceRefund(entry, dest);
  return {
    netSat: quote.amountSat,
    feeSat: quote.feeReserveSat + inputFeeSat,
    destination: dest,
  };
}

export type RefundPhase = 'reading' | 'minting' | 'paying';

export interface RefundTopUpArgs {
  topupId: string;
  destination: string;
  /** The net the holder confirmed; a refund that would pay less stops. */
  shownNetSat: number;
  transceive: Transceiver;
  pin?: string;
  onPhase?: (phase: RefundPhase) => void;
}

export interface TopUpRefundResult {
  amountSat: number;
  /** The reserve the mint gave back: stays on this phone, in the entry. */
  changeSat: number;
  preimage: string | null;
  destination: TopUpRefundDestination;
}

const refundResult = (entry: TopUpEntry): TopUpRefundResult => ({
  amountSat: entry.refund!.amountSat,
  changeSat: entry.refund!.changeSat ?? 0,
  preimage: entry.refund!.preimage ?? null,
  destination: entry.refund!.destination,
});

/**
 * The card's part of a refund, inside one card session: the same card and
 * PIN gate as the load (no room check, no LOAD), a fresh price, then the
 * intent written ahead — `refunding`, with plain outputs — only while
 * nothing is minted. Nothing goes to the mint's mint or melt here, so the
 * screen can let the card go before the melt (`resumeTopUpRefund`), which
 * may take longer than an NFC session lives. Throws a `TopUpError`.
 */
export async function beginTopUpRefund({
  topupId,
  destination,
  shownNetSat,
  transceive,
  pin,
  onPhase = () => {},
}: RefundTopUpArgs): Promise<void> {
  const dest = normalizeRefundDestination(destination);
  const entry = await readEntry(topupId);
  if (entry.state === 'refunded') {
    throw new TopUpError('refunded');
  }
  if (
    !(
      entry.state === 'refunding' ||
      ((entry.state === 'paid' || entry.state === 'loading') && !entry.minted)
    )
  ) {
    throw new TopUpError(
      entry.state === 'waiting' ? 'not_paid' : 'refund_unavailable',
    );
  }

  // 1. The card and its PIN, as for a load.
  await verifyCardForTopUp(entry, transceive, pin, onPhase);

  // 2. The price again: the holder confirmed a net, never pay less.
  const {quote, keysetId, inputFeeSat} = await priceRefund(entry, dest);
  if (quote.amountSat < shownNetSat) {
    throw new TopUpError(
      'refund_failed',
      `The mint now pays ${quote.amountSat.toLocaleString(
        'en-US',
      )} sats, less than shown. Check the amount and confirm again.`,
    );
  }

  // 3. Write-ahead, compare-and-set: only an entry still unminted (or a
  // refund whose melt has not gone) takes the refund. A refund's own plain
  // outputs, once made, are kept: the mint may already have signed them.
  const outputs: TopUpRefundOutput[] = entry.pieces.map(amount => {
    const secret = bytesToHex(randomBytes(32));
    const {B_, r} = blindMessage(utf8ToBytes(secret));
    return {
      amount,
      secret,
      r: r.toString(16).padStart(64, '0'),
      B_: bytesToHex(B_.toBytes(true)),
    };
  });
  const terms = {
    destination: dest,
    meltQuoteId: quote.meltQuoteId,
    request: quote.request,
    amountSat: quote.amountSat,
    feeSat: quote.feeReserveSat + inputFeeSat,
    inputFeeSat,
    meltExpiry: quote.expiry,
  };
  try {
    await patchTopUp(topupId, e => {
      if (e.state === 'refunding' && e.refund && !e.refund.preimage) {
        return {
          ...e,
          refund: {...e.refund, ...terms, meltSent: false},
          lastError: undefined,
        };
      }
      if ((e.state === 'paid' || e.state === 'loading') && !e.minted) {
        return {
          ...e,
          state: 'refunding',
          refund: {...terms, keysetId, outputs},
          lastError: undefined,
        };
      }
      throw new TopUpError('refund_unavailable');
    });
  } catch (error) {
    if (error instanceof TopUpError) {
      throw error;
    }
    // Nothing was sent to the mint.
    throw new TopUpError(
      'failed',
      `The refund could not be saved on this phone (${String(error)}).`,
    );
  }
}

/**
 * Refund a paid top-up to the holder's invoice or Lightning address:
 * `beginTopUpRefund` (the card, its PIN and the intent), then the mint and
 * the melt (`completeRefund`, which needs no card). Throws a `TopUpError`.
 */
export async function refundTopUp(
  args: RefundTopUpArgs,
): Promise<TopUpRefundResult> {
  await beginTopUpRefund(args);
  return completeRefund(args.topupId, args.onPhase ?? (() => {}));
}

/**
 * Finish a `refunding` top-up without the card: the gate was passed and the
 * destination fixed when the refund was written. Throws a `TopUpError`; the
 * entry stays `refunding` and resuming again goes on from where it stopped.
 */
export async function resumeTopUpRefund(
  topupId: string,
  onPhase: (phase: RefundPhase) => void = () => {},
): Promise<TopUpRefundResult> {
  return completeRefund(topupId, onPhase);
}

/** Patch a `refunding` entry's refund; any other state refuses inside the write. */
async function patchRefund(
  topupId: string,
  fn: (r: TopUpRefund) => TopUpRefund,
): Promise<TopUpEntry> {
  return patchTopUp(topupId, e => {
    if (e.state !== 'refunding' || !e.refund) {
      throw new TopUpError(
        e.state === 'refunded' ? 'refunded' : 'refund_unavailable',
      );
    }
    return {...e, refund: fn(e.refund)};
  });
}

/**
 * The mint would not sign the refund's outputs. When it signed the card's
 * instead (a load won the race), record those pieces as the load's and say
 * the refund cannot happen; else the first failure stands.
 */
async function settleLostRace(
  entry: TopUpEntry,
  failure: unknown,
): Promise<never> {
  let state: TopUpQuoteState | null = null;
  try {
    state = await checkTopUpQuote(entry.mintUrl, entry.topupId);
  } catch {
    state = null;
  }
  if (state === 'ISSUED' && entry.outputs && entry.keysetId) {
    const kept = entry.outputs;
    const keysetId = entry.keysetId;
    let signatures: TopUpSignature[] | null = null;
    try {
      signatures = await restoreTopUp(
        entry.mintUrl,
        kept.map(o => ({amount: o.amount, keysetId, B_: o.B_, r: o.r})),
      );
    } catch {
      signatures = null;
    }
    if (signatures) {
      const minted = mintedFrom(kept, signatures);
      try {
        await patchTopUp(entry.topupId, e => ({
          ...e,
          state: 'loading',
          minted,
          refund: undefined,
        }));
      } catch {
        // The kept outputs are enough: the next load restores them.
      }
      throw new TopUpError('refund_unavailable');
    }
  }
  throw mintFailure(failure);
}

/**
 * The refund's network steps, each written ahead and each resumable:
 *
 *   1. the mint's signatures on the plain outputs (the same outputs every
 *      time; NUT-09 restore finds a lost answer), kept as `proofs`;
 *   2. a melt already sent is checked first: PAID finishes, PENDING waits,
 *      UNPAID melts again with the same proofs;
 *   3. an expired melt quote is quoted again (an address re-resolves) and
 *      the new id kept before the melt;
 *   4. `meltSent` is written, then the melt; PAID makes the entry `refunded`
 *      with the preimage and any change.
 */
async function completeRefund(
  topupId: string,
  onPhase: (phase: RefundPhase) => void,
): Promise<TopUpRefundResult> {
  let entry = await readEntry(topupId);
  if (entry.state === 'refunded' && entry.refund) {
    return refundResult(entry);
  }
  if (entry.state !== 'refunding' || !entry.refund) {
    throw new TopUpError('refund_unavailable');
  }

  // 1. The proofs.
  if (!entry.refund.proofs) {
    onPhase('minting');
    const r = entry.refund;
    let signatures: TopUpSignature[];
    try {
      signatures = await obtainSignatures(
        entry,
        r.outputs.map(o => ({
          amount: o.amount,
          keysetId: r.keysetId,
          B_: o.B_,
          r: o.r,
        })),
      );
    } catch (error) {
      await noteError(topupId, error);
      return settleLostRace(entry, error);
    }
    const proofs: RefundProof[] = r.outputs.map((o, i) => ({
      id: r.keysetId,
      amount: o.amount,
      secret: o.secret,
      C: signatures[i].C,
    }));
    try {
      entry = await patchRefund(topupId, x => ({...x, proofs}));
    } catch (error) {
      if (error instanceof TopUpError) {
        throw error;
      }
      // Not kept: nothing is melted until it is (restore finds them again).
      throw new TopUpError(
        'failed',
        `The refund could not be saved on this phone (${String(error)}).`,
      );
    }
  }

  onPhase('paying');
  const finish = async (
    preimage: string | null,
    change: RefundProof[],
  ): Promise<TopUpRefundResult> => {
    const changeSat = change.reduce((t, p) => t + p.amount, 0);
    try {
      entry = await patchTopUp(topupId, e => ({
        ...e,
        state: 'refunded',
        refund: {...e.refund!, preimage, change, changeSat},
        lastError: undefined,
      }));
    } catch {
      // The mint paid; the next resume checks the melt and writes it.
      entry = {
        ...entry,
        state: 'refunded',
        refund: {...entry.refund!, preimage, change, changeSat},
      };
    }
    return refundResult(entry);
  };

  // 2. A melt already sent: the mint says what became of it.
  let expiry = entry.refund!.meltExpiry;
  if (entry.refund!.meltSent) {
    let check: RefundMeltCheck;
    try {
      check = await checkRefundMelt(entry.mintUrl, entry.refund!.meltQuoteId);
    } catch (error) {
      throw mintFailure(error);
    }
    if (check.state === 'PAID') {
      return finish(check.preimage, []);
    }
    if (check.state === 'PENDING') {
      throw new TopUpError('refund_pending');
    }
    expiry = check.expiry ?? expiry;
  }

  // 3. An expired melt quote: quote the same destination again.
  if (expiry !== null && Date.now() >= expiry * 1000) {
    const r = entry.refund!;
    let quote: RefundQuote;
    try {
      quote = await createRefundQuote(
        entry.mintUrl,
        meltDestination(r.destination),
        entry.amountSat - r.inputFeeSat,
      );
    } catch (error) {
      await noteError(topupId, error);
      if (
        r.destination.kind === 'bolt11' &&
        !(error instanceof TopUpMintError)
      ) {
        throw new TopUpError(
          'refund_failed',
          'The invoice expired. Ask the holder for a new one.',
        );
      }
      throw refundFailure(error, r.destination.kind);
    }
    // Never pay less than the net the holder confirmed with the card.
    if (quote.amountSat < r.amountSat) {
      const less = new TopUpError(
        'refund_failed',
        `The mint now pays ${quote.amountSat.toLocaleString(
          'en-US',
        )} sats, less than confirmed. Refund to another destination.`,
      );
      await noteError(topupId, less);
      throw less;
    }
    try {
      entry = await patchRefund(topupId, x => ({
        ...x,
        meltQuoteId: quote.meltQuoteId,
        request: quote.request,
        amountSat: quote.amountSat,
        feeSat: quote.feeReserveSat + x.inputFeeSat,
        meltExpiry: quote.expiry,
        meltSent: false,
      }));
    } catch (error) {
      if (error instanceof TopUpError) {
        throw error;
      }
      throw new TopUpError(
        'failed',
        `The refund could not be saved on this phone (${String(error)}).`,
      );
    }
  }

  // 4. The melt, its attempt written first.
  try {
    entry = await patchRefund(topupId, x => ({...x, meltSent: true}));
  } catch (error) {
    if (error instanceof TopUpError) {
      throw error;
    }
    // Not recorded, so not sent.
    throw new TopUpError(
      'failed',
      `The refund could not be saved on this phone (${String(error)}).`,
    );
  }
  const r = entry.refund!;
  let melted: RefundMeltResult;
  try {
    melted = await meltRefund(entry.mintUrl, r.meltQuoteId, r.proofs!);
  } catch (error) {
    // Outcome unknown: the entry stays `refunding` with the melt sent, and
    // the next resume asks the mint before spending anything again.
    await noteError(topupId, error);
    throw refundFailure(error);
  }
  if (melted.state === 'PAID') {
    return finish(melted.preimage, melted.change);
  }
  if (melted.state === 'PENDING') {
    throw new TopUpError('refund_pending');
  }
  const unpaid = new TopUpError(
    'refund_failed',
    'The mint could not pay it. Nothing was sent. Try again.',
  );
  await noteError(topupId, unpaid);
  throw unpaid;
}
