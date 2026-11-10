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
 * A paid top-up lives on the phone that made it. Nothing here refunds one
 * that can never load (a card lost, locked or PIN-blocked after payment):
 * see docs/13-cashu-card.md, Known gaps.
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
  checkTopUpQuote,
  createTopUpQuote,
  mintTopUp,
  restoreTopUp,
  TopUpMintError,
  topUpKeyset,
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

export type TopUpState = 'waiting' | 'paid' | 'loading' | 'loaded' | 'expired';

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
]);

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

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
 * The pieces this card's paid and loading top-ups still need slots for: the
 * minted pieces not yet (possibly) on the card, or every piece when none is
 * minted yet. Never throws.
 */
export async function reservedPiecesFor(cardPubkey: string): Promise<number> {
  return (await waitingTopUpsForCard(cardPubkey))
    .filter(e => e.state === 'paid' || e.state === 'loading')
    .reduce(
      (n, e) =>
        n +
        (e.minted
          ? e.minted.filter(m => !mayBeOnCard(m)).length
          : e.pieces.length),
      0,
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
  // Slots already promised to this card's other paid top-ups, so nobody pays
  // for a load that cannot land beside them (TOPUP.md § Room on the card).
  const reserved = await reservedPiecesFor(summary.pubkey);
  const refused = canTopUp(summary, owed + reserved, {
    unit,
    pieces: pieces.length,
  });
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
): Promise<TopUpEntry | null> {
  const entry = await getTopUp(topupId);
  if (!entry || entry.state !== 'waiting') {
    return entry;
  }
  let state: TopUpQuoteState;
  try {
    state = await checkTopUpQuote(entry.mintUrl, entry.topupId);
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
 * The top-ups waiting for this card: paid ones still to load, and quotes not
 * yet confirmed expired. Never throws (a store that will not read is none).
 */
export async function waitingTopUpsForCard(
  cardPubkey: string,
): Promise<TopUpEntry[]> {
  try {
    const key = cardPubkey.toLowerCase();
    return (await listTopUps()).filter(
      e =>
        e.cardPubkey === key &&
        (e.state === 'paid' || e.state === 'loading' || e.state === 'waiting'),
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
 * One quote check for each `waiting` top-up of this card (a payment that
 * landed after Cancel), then what is still waiting. Never throws.
 */
export async function refreshWaitingTopUps(
  cardPubkey: string,
): Promise<TopUpEntry[]> {
  const waiting = await waitingTopUpsForCard(cardPubkey);
  for (const e of waiting.filter(w => w.state === 'waiting')) {
    try {
      await pollTopUp(e.topupId);
    } catch {
      // A poll that will not run leaves the entry as it was.
    }
  }
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

  // 1. The card: the one this top-up is for, at this mint.
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

  // 2. The PIN, before any LOAD — even when the change grant would let one through.
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
      entry = await patchTopUp(topupId, e => ({
        ...e,
        keysetId,
        outputs,
        state: 'loading',
      }));
    } catch (error) {
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
    const minted: TopUpMintedPiece[] = kept.map((o, i) => ({
      amount: o.amount,
      nonce: o.nonce,
      C: signatures[i].C,
      dleqE: signatures[i].dleq.e,
      dleqS: signatures[i].dleq.s,
      r: o.r,
      loaded: false,
    }));
    try {
      entry = await patchTopUp(topupId, e => ({...e, minted}));
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
      entry = await patchTopUp(topupId, e => ({
        ...e,
        attempts: e.attempts + 1,
        minted: e.minted?.map((m, j) => (j === at ? {...m, sent: true} : m)),
      }));
    } catch (error) {
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
