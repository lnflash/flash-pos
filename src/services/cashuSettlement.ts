/**
 * Offline settlement queue for Cashu card payments.
 *
 * The card marks a proof spent *before* it returns the signature, deliberately:
 * reversing that order would let an attacker yank the card mid-response and
 * keep both the money and a valid witness. The cost is a window where the money
 * has left the card but the mint has not yet been told.
 *
 * This queue is what stands in that window. The rule it exists to enforce:
 *
 *   **Nothing is approved to a customer until the witness is durably recorded.**
 *
 * If the app is killed between the tap and the mint call, the entry is on disk
 * and settles on the next drain. If the mint call fails, it retries. If the
 * witness itself was lost — the card left the field mid-response — the entry is
 * recorded as `needs-card` and recovers by re-signing from the same card, which
 * works because a spent slot is still readable and `SIGN_ARBITRARY` consumes
 * nothing.
 *
 * The merchant carries the residual risk knowingly, so it is shown to them
 * rather than hidden: see `pendingExposure()`.
 *
 * Two invariants hold everything else up:
 *
 * 1. **Fail closed.** A store that cannot be read is not an empty store, and a
 *    store that cannot be *parsed* is not an empty store either. Every entry
 *    point either propagates the failure or answers the conservative way
 *    (`hasUnsettledForCard` says "yes, still unsettled"). Nothing writes over a
 *    queue it could not read, and nothing writes over a queue it could not
 *    parse until that corruption has been durably recorded — see
 *    `UNKNOWN_EXPOSURE_KEY`. Corruption is detectable exactly once; the first
 *    write would otherwise destroy the only evidence that the merchant is
 *    carrying money the queue no longer knows about.
 * 2. **One writer at a time.** Every mutation goes through `withQueue`, a single
 *    serialising promise chain, so a background drain and a fresh tap can never
 *    interleave read-modify-write and lose one of the two.
 */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils';

import {getSecureStrict, removeSecure, setSecure} from './secureStorage';

const QUEUE_KEY = '@cashu_settlement_queue';
/**
 * Where unparseable queue bytes are copied before anything overwrites them. A
 * corrupt queue is still the only record that money left a card, so it is
 * quarantined rather than dropped.
 */
export const CORRUPT_QUEUE_KEY = '@cashu_settlement_queue_corrupt';
/**
 * Durable "the queue was corrupt once" marker.
 *
 * `CORRUPT_QUEUE_KEY` preserves the bytes for forensics, but nothing running in
 * the app can read a blob it already failed to parse — so the quarantine alone
 * never reaches the merchant. This key does: it is written *before* the first
 * overwrite of a corrupt queue and surfaces as `Exposure.unknownSince` until an
 * operator calls `acknowledgeUnknownExposure()`. Without it, one `recordSpend`
 * turns a corrupt queue into a truthful-looking queue that omits every
 * outstanding settlement.
 */
export const UNKNOWN_EXPOSURE_KEY = '@cashu_settlement_queue_unknown';

/** Cap the queue so a long outage cannot grow storage without bound. */
export const MAX_QUEUE_ENTRIES = 200;

/** How many times a post-swap write is retried before it becomes an error. */
const PERSIST_ATTEMPTS = 3;

/**
 * Delay before each retry, in ms — `100 * 4 ** attempt`.
 *
 * The failures this loop retries (device locked, Keychain busy, an entitlement
 * hiccup) do not clear inside a single microtask, so three back-to-back
 * attempts in the same tick would buy nothing at all.
 */
const persistBackoffMs = (attempt: number): number => 100 * 4 ** attempt;

/** Replaceable so tests drive the backoff instead of waiting through it. */
const realDelay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));
let persistDelay: (ms: number) => Promise<void> = realDelay;

/** Test seam: swap the inter-attempt sleep. `null` restores the real one. */
export function __setPersistDelay(
  fn: ((ms: number) => Promise<void>) | null,
): void {
  persistDelay = fn ?? realDelay;
}

export type SettlementStatus =
  /** Witness held; the mint has not confirmed. Retries on its own. */
  | 'pending'
  /**
   * Handed to the mint, outcome unknown.
   *
   * Written to disk immediately *before* the swap, so it survives the app being
   * killed mid-call — routine on mobile. On the next launch a double-spend
   * rejection of an entry already in this state is the mint saying it already
   * has the proof: that is money received, and marking it `failed` would write
   * off money the merchant actually got.
   */
  | 'submitting'
  /** The slot burned but the witness was lost. Needs the card once more. */
  | 'needs-card'
  /** The mint confirmed. Money is ours. */
  | 'settled'
  /** Permanently rejected by the mint. Needs a human. */
  | 'failed';

export interface SettlementEntry {
  id: string;
  /** Card pubkey — identifies which card must return for a `needs-card` entry. */
  cardPubkey: string;
  slot: number;
  keysetId: string;
  amount: number;
  /**
   * The 32-byte P2PK nonce as the card reports it (`getProof`). Useful for
   * matching an entry back to a slot; **not** sufficient to settle.
   */
  nonce: string;
  /**
   * The full NUT-10 secret string, verbatim — roughly 150 bytes of JSON, e.g.
   * `["P2PK",{"nonce":"…","data":"02…","tags":[…]}]`.
   *
   * The card cannot give this back: `GET_PROOF` returns the nonce only (see the
   * comment on `CardProofSlot.nonce`). It has to be captured by whatever loaded
   * the proof onto the card and handed to `recordSpend`. Without it there is no
   * proof to submit (`toCashuProof`) and no message to re-sign
   * (`recoveryMessage`) — the entry is unsettleable, which is why `recordSpend`
   * refuses to store one.
   */
  secret: string;
  /** The mint's unblinded signature, 33 bytes compressed, hex. */
  C: string;
  /** 64-byte BIP-340 witness, hex. Absent means the burn produced nothing. */
  witness?: string;
  status: SettlementStatus;
  /** ms since epoch, supplied by the caller so this module stays testable. */
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError?: string;
}

/** What `recordSpend` needs. Everything else is derived. */
export type SpendRecord = Omit<
  SettlementEntry,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'attempts' | 'lastError'
>;

/**
 * A proof in the shape the mint expects inside a swap request (NUT-00 plus the
 * NUT-11 witness). `id` here is the *keyset* id, not the queue entry id.
 */
export interface CashuProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  /** NUT-11 witness envelope: `{"signatures":["<64-byte hex>"]}`. */
  witness: string;
}

/** The settlement queue could not be read. Never confuse this with "empty". */
export class QueueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueUnavailableError';
  }
}

/**
 * The mint took the proof but the local record of that could not be written.
 *
 * Deliberately distinct from a settlement failure: the money moved. Retrying
 * the *swap* would double-spend; only the write is owed.
 */
export class SettlementPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementPersistenceError';
  }
}

/** A settlement that will never succeed — double-spend, malformed proof. */
export class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSettlementError';
  }
}

/**
 * Rebuild the proof to submit to the mint from a queue entry alone.
 *
 * This is the whole point of persisting `secret`: after a relaunch the card is
 * long gone and this object is all that remains.
 */
export function toCashuProof(entry: SettlementEntry): CashuProof {
  if (!entry.witness) {
    throw new Error(
      `settlement ${entry.id} has no witness; re-sign the card first`,
    );
  }
  return {
    id: entry.keysetId,
    amount: entry.amount,
    secret: entry.secret,
    C: entry.C,
    witness: JSON.stringify({signatures: [entry.witness]}),
  };
}

/**
 * The 32 bytes the card must sign to unlock this proof: `sha256(utf8(secret))`.
 *
 * Feed straight to `signArbitrary` on the recovery path, or to `spendProof` on
 * the first attempt. Returned as a plain byte array to match the card API.
 */
export function recoveryMessage(
  entry: Pick<SettlementEntry, 'secret'>,
): number[] {
  return Array.from(sha256(utf8ToBytes(entry.secret)));
}

/** Hex form of `recoveryMessage`, for logs and assertions. */
export const recoveryMessageHex = (
  entry: Pick<SettlementEntry, 'secret'>,
): string => bytesToHex(sha256(utf8ToBytes(entry.secret)));

interface QueueRead {
  /** Every element that validated. Never a blind cast. */
  entries: SettlementEntry[];
  /**
   * The stored bytes were unparseable, or held at least one element that is
   * not a settlement entry. They have been quarantined.
   */
  corrupt: boolean;
  /**
   * The corruption was durably recorded at `UNKNOWN_EXPOSURE_KEY`. When this is
   * false, nothing may overwrite the queue: doing so would erase the only
   * evidence that outstanding settlements went missing.
   */
  corruptionRecorded: boolean;
}

const SETTLEMENT_STATUSES: ReadonlySet<string> = new Set<SettlementStatus>([
  'pending',
  'submitting',
  'needs-card',
  'settled',
  'failed',
]);

const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Structural check for one stored element.
 *
 * `JSON.parse` gives back `unknown`; casting the array to `SettlementEntry[]`
 * validates the container and nothing inside it, so a single malformed element
 * — `[null]` is enough — throws a raw `TypeError` deep inside a reader that
 * every caller is documented to handle by catching `QueueUnavailableError`.
 * That is the exact till-down the corrupt handling exists to prevent, and it
 * blocks settlement for every well-formed entry sitting beside the bad one.
 */
function isSettlementEntry(value: unknown): value is SettlementEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    isText(e.id) &&
    isText(e.cardPubkey) &&
    isText(e.keysetId) &&
    isText(e.nonce) &&
    isText(e.secret) &&
    isText(e.C) &&
    isNum(e.slot) &&
    isNum(e.amount) &&
    isNum(e.createdAt) &&
    isNum(e.updatedAt) &&
    isNum(e.attempts) &&
    typeof e.status === 'string' &&
    SETTLEMENT_STATUSES.has(e.status) &&
    (e.witness === undefined || isText(e.witness)) &&
    (e.lastError === undefined || typeof e.lastError === 'string')
  );
}

/**
 * Preserve the bad bytes, then record that they existed.
 *
 * Returns whether the *record* landed. The forensic copy is best effort —
 * failing to keep it must not also take the till down — but the marker is not:
 * `withQueue` refuses to overwrite a corrupt queue whose corruption it could
 * not persist, because that write is what makes the loss invisible.
 */
async function quarantine(raw: string): Promise<boolean> {
  try {
    await setSecure(CORRUPT_QUEUE_KEY, raw);
  } catch {
    // nothing further to do — the read path continues degraded
  }
  try {
    const existing = await getSecureStrict(UNKNOWN_EXPOSURE_KEY);
    if (!existing) {
      // First detection wins: a later corruption must not reset the clock on
      // exposure the merchant has been carrying since the original one.
      await setSecure(
        UNKNOWN_EXPOSURE_KEY,
        JSON.stringify({since: Date.now(), quarantineKey: CORRUPT_QUEUE_KEY}),
      );
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the queue, separating "nothing stored" from "could not read".
 *
 * Throws `QueueUnavailableError` on a storage failure. Unparseable bytes, a
 * non-array, or any element that is not a settlement entry resolve to the
 * entries that *did* validate, flagged `corrupt`, after quarantining the
 * original.
 */
async function loadQueue(): Promise<QueueRead> {
  let raw: string | null;
  try {
    raw = await getSecureStrict(QUEUE_KEY);
  } catch (error) {
    throw new QueueUnavailableError(
      `settlement queue unreadable: ${
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
  if (!Array.isArray(parsed)) {
    return {
      entries: [],
      corrupt: true,
      corruptionRecorded: await quarantine(raw),
    };
  }
  const entries = parsed.filter(isSettlementEntry);
  if (entries.length !== parsed.length) {
    // Keep what validated — those are real settlements the merchant is owed —
    // but the blob as a whole is corrupt and must be treated as such.
    return {entries, corrupt: true, corruptionRecorded: await quarantine(raw)};
  }
  return {entries, corrupt: false, corruptionRecorded: false};
}

/**
 * ms epoch of the first unrecovered corruption, or `undefined` if the queue has
 * never been seen corrupt.
 *
 * `0` means the corruption is recorded but its timestamp was lost — test with
 * `!== undefined`, never for truthiness.
 */
async function readUnknownSince(): Promise<number | undefined> {
  let raw: string | null;
  try {
    raw = await getSecureStrict(UNKNOWN_EXPOSURE_KEY);
  } catch (error) {
    throw new QueueUnavailableError(
      `settlement corruption marker unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!raw) {
    return undefined;
  }
  try {
    const since = (JSON.parse(raw) as {since?: unknown}).since;
    return isNum(since) ? since : 0;
  } catch {
    return 0;
  }
}

/**
 * Operator acknowledgement: the books have been reconciled against the
 * quarantined bytes, stop flagging unknown exposure.
 *
 * Deliberately not called from any automatic path. The flag exists precisely
 * because the app cannot work out on its own what the corrupt queue was owed.
 */
export async function acknowledgeUnknownExposure(): Promise<void> {
  await removeSecure(UNKNOWN_EXPOSURE_KEY);
}

async function writeQueue(entries: SettlementEntry[]): Promise<void> {
  await setSecure(QUEUE_KEY, JSON.stringify(entries));
}

/**
 * Serialises every read-modify-write against the queue.
 *
 * `await` yields to the RN bridge, so an unguarded read-then-write races any
 * other mutation in flight — a tap landing mid-drain would be clobbered by the
 * drain's stale snapshot, burning a slot on the card that nothing on disk
 * remembers. The chain is never allowed to reject, so one failed mutation
 * cannot poison the ones queued behind it.
 *
 * It is also the single choke point where a corrupt queue is stopped from being
 * silently overwritten: corruption is detectable exactly once, so if the marker
 * could not be written the mutation is refused rather than allowed to erase the
 * evidence.
 */
let tail: Promise<unknown> = Promise.resolve();

function withQueue<T>(fn: (read: QueueRead) => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    const read = await loadQueue();
    if (read.corrupt && !read.corruptionRecorded) {
      throw new QueueUnavailableError(
        'settlement queue is corrupt and the corruption could not be recorded; refusing to overwrite it',
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

/**
 * Raw enumeration of what is on disk. Throws `QueueUnavailableError` if the
 * store cannot be read.
 *
 * Deliberately tolerant of a corrupt blob: it returns the entries that parsed
 * so a recovery UI can still show them. It is therefore **not** a money-facing
 * total — use `pendingExposure`, which refuses to answer at all when the queue
 * is corrupt.
 */
export async function listSettlements(): Promise<SettlementEntry[]> {
  return (await loadQueue()).entries;
}

/** Entries still owed to the merchant — what `pendingExposure` totals. */
export const isOutstanding = (e: SettlementEntry): boolean =>
  e.status === 'pending' ||
  e.status === 'submitting' ||
  e.status === 'needs-card';

/**
 * Make room by dropping settled entries — never outstanding ones, because a
 * full queue must not silently discard money the merchant is still owed.
 *
 * `room` can legitimately be 0 when outstanding entries alone are at or over
 * the cap. `slice(-0)` is `slice(0)`, i.e. the *whole* array, so the zero case
 * is branched explicitly rather than expressed as a negative index.
 */
function evict(queue: SettlementEntry[]): SettlementEntry[] {
  const keep = queue.filter(e => e.status !== 'settled');
  const settled = queue.filter(e => e.status === 'settled');
  const room = Math.max(0, MAX_QUEUE_ENTRIES - keep.length);
  return [...(room > 0 ? settled.slice(-room) : []), ...keep];
}

/**
 * Durably record a spend. **Await this before showing an approval.**
 *
 * Returns the stored entry. Throws if it could not be persisted — and a throw
 * here means do not approve the payment, because nothing would remember it.
 * That includes a storage read failure: an unreadable queue is not an empty
 * one, and writing over it would erase every outstanding settlement.
 */
export async function recordSpend(
  record: SpendRecord,
  now: number,
  id: string,
): Promise<SettlementEntry> {
  if (!record.secret) {
    // Without the secret there is nothing to submit and nothing to re-sign.
    // Refusing here means the payment is declined instead of silently
    // unsettleable.
    throw new Error('settlement record is missing the proof secret');
  }
  const entry: SettlementEntry = {
    ...record,
    id,
    // No witness means the card burned the slot without returning a signature.
    status: record.witness ? 'pending' : 'needs-card',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };

  return withQueue(async ({entries}) => {
    if (entries.some(e => e.id === id)) {
      // Two taps in the same millisecond under a Date.now() id would otherwise
      // write duplicates; `update` patches only the first, so the second would
      // stay pending forever and be submitted twice.
      throw new Error(`settlement id already recorded: ${id}`);
    }
    const next = [...entries, entry];
    await writeQueue(next.length > MAX_QUEUE_ENTRIES ? evict(next) : next);
    return entry;
  });
}

async function update(
  id: string,
  patch: (e: SettlementEntry) => SettlementEntry,
): Promise<SettlementEntry | null> {
  return withQueue(async ({entries}) => {
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) {
      return null;
    }
    const next = patch(entries[idx]);
    entries[idx] = next;
    await writeQueue(entries);
    return next;
  });
}

export const markSettled = (id: string, now: number) =>
  update(id, e => ({
    ...e,
    status: 'settled',
    updatedAt: now,
    lastError: undefined,
  }));

export const markFailed = (id: string, reason: string, now: number) =>
  update(id, e => ({
    ...e,
    status: 'failed',
    updatedAt: now,
    attempts: e.attempts + 1,
    lastError: reason,
  }));

/**
 * A retryable miss — stays outstanding, attempt count goes up.
 *
 * `status` is how the drain distinguishes a *known* miss (`pending`: the mint
 * never took the proof, so a later permanent rejection really is a failure)
 * from one whose outcome is still unknown (`submitting`: the proof may already
 * be at the mint, so a later permanent rejection is a confirmation).
 */
export const markAttemptFailed = (
  id: string,
  reason: string,
  now: number,
  status: 'pending' | 'submitting' = 'pending',
) =>
  update(id, e => ({
    ...e,
    status,
    updatedAt: now,
    attempts: e.attempts + 1,
    lastError: reason,
  }));

/**
 * Attach a witness recovered by re-signing, moving `needs-card` → `pending`.
 *
 * Only that transition. A recovery UI that re-taps a card can reach a `settled`
 * or `failed` entry, and resurrecting one of those into the drain loop would
 * re-submit a proof the mint has already consumed.
 *
 * Returns `null` when nothing was recovered — entry missing, or in a status
 * this refuses to touch. Returning the untouched entry instead would be truthy
 * and indistinguishable from success, and a recovery screen would tell the
 * merchant an entry was repaired when nothing was written.
 */
export async function attachRecoveredWitness(
  id: string,
  witness: string,
  now: number,
): Promise<SettlementEntry | null> {
  return withQueue(async ({entries}) => {
    const idx = entries.findIndex(e => e.id === id);
    // `update()` cannot express a refusal, so the branch has to live above it.
    if (idx === -1 || entries[idx].status !== 'needs-card') {
      return null;
    }
    const next: SettlementEntry = {
      ...entries[idx],
      witness,
      status: 'pending',
      updatedAt: now,
    };
    entries[idx] = next;
    await writeQueue(entries);
    return next;
  });
}

export interface Exposure {
  /** Total the merchant is owed but has not settled, in the keyset's base unit. */
  total: number;
  count: number;
  /** Entries whose card must come back before they can settle. */
  needsCard: number;
  /** Permanently failed — a human has to look at these. */
  failed: number;
  /**
   * Set when the queue was corrupt at some point and no operator has
   * acknowledged it: ms epoch of the first corrupt read, or `0` if even that
   * timestamp was lost. The totals beside it are real but **incomplete** —
   * whatever the unparseable blob was owed is not in them.
   *
   * Test with `unknownSince !== undefined`, never for truthiness.
   */
  unknownSince?: number;
}

/**
 * What the merchant is currently carrying. Shown in the UI, not hidden: the
 * whole basis for accepting offline is that the risk is visible and theirs.
 *
 * Throws `QueueUnavailableError` rather than reporting a clean till it cannot
 * actually vouch for — a false zero here is the one answer the merchant must
 * never be given. That covers both arms of an unusable store: a read that
 * failed *and* bytes that would not parse.
 */
export async function pendingExposure(): Promise<Exposure> {
  const {entries, corrupt} = await loadQueue();
  if (corrupt) {
    throw new QueueUnavailableError(
      'settlement queue is corrupt; exposure unknown',
    );
  }
  const unknownSince = await readUnknownSince();
  const outstanding = entries.filter(isOutstanding);
  return {
    total: outstanding.reduce((sum, e) => sum + e.amount, 0),
    count: outstanding.length,
    needsCard: entries.filter(e => e.status === 'needs-card').length,
    failed: entries.filter(e => e.status === 'failed').length,
    ...(unknownSince === undefined ? {} : {unknownSince}),
  };
}

/**
 * True while this card still has unsettled spends.
 *
 * `CLEAR_SPENT` erases spent slots, which is what turns a recoverable burn into
 * real loss — so it must never run while this returns true.
 *
 * Fails closed: an unreadable or corrupt queue answers `true`, and so does a
 * queue that was corrupt earlier and has not been reconciled — that blob may
 * have held this card's spends. The gate staying shut costs the merchant a
 * retry; opening it on a failed read costs the money.
 */
export async function hasUnsettledForCard(
  cardPubkey: string,
): Promise<boolean> {
  try {
    const {entries, corrupt} = await loadQueue();
    if (corrupt) {
      return true;
    }
    if ((await readUnknownSince()) !== undefined) {
      return true;
    }
    return entries.some(e => e.cardPubkey === cardPubkey && isOutstanding(e));
  } catch {
    return true;
  }
}

/**
 * Entries this card could recover right now by re-signing.
 *
 * Throws `QueueUnavailableError` on a corrupt queue rather than returning `[]`:
 * an empty list tells the merchant there is nothing to re-tap, which is the one
 * answer that turns a recoverable burn into a permanent loss.
 */
export async function recoverableForCard(
  cardPubkey: string,
): Promise<SettlementEntry[]> {
  const {entries, corrupt} = await loadQueue();
  if (corrupt) {
    throw new QueueUnavailableError(
      'settlement queue is corrupt; recoverable entries unknown',
    );
  }
  return entries.filter(
    e => e.cardPubkey === cardPubkey && e.status === 'needs-card',
  );
}

export interface DrainResult {
  settled: number;
  stillPending: number;
  failed: number;
  /**
   * Mint outcomes that could not be attributed: the entry was gone from the
   * queue by the time the status was written. Counted separately so a drain
   * never reports a settlement that was not persisted.
   */
  lost: number;
}

/**
 * Guards against overlapping drains — app-foreground and a connectivity change
 * can both fire. Two drains reading the same 'pending' entry would submit the
 * same proof twice; the loser takes a double-spend rejection and `markFailed`
 * would overwrite the winner's 'settled'.
 */
let draining = false;

/**
 * Entry ids the mint has confirmed within this process but whose 'settled'
 * write did not land. Re-swapping one of these would double-spend, so a later
 * drain only retries the write.
 */
const mintConfirmed = new Set<string>();

/**
 * Test seam: drop the in-memory record of unpersisted mint confirmations, and
 * restore the real retry delay. Also stands in for a process relaunch.
 */
export function __resetDrainState(): void {
  draining = false;
  mintConfirmed.clear();
  persistDelay = realDelay;
}

async function persistSettled(
  id: string,
  now: number,
  result: DrainResult,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Without this the three attempts all fail together in microseconds and
      // the retry buys nothing — the failures being retried here need wall
      // time to clear.
      await persistDelay(persistBackoffMs(attempt - 1));
    }
    try {
      const marked = await markSettled(id, now);
      if (marked) {
        result.settled += 1;
      } else {
        result.lost += 1;
      }
      mintConfirmed.delete(id);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new SettlementPersistenceError(
    `settlement ${id} was accepted by the mint but could not be recorded: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Try to settle every entry holding a witness.
 *
 * `swap` resolves on mint confirmation, and rejects otherwise. Reject with a
 * `PermanentSettlementError` to mark an entry failed instead of retrying it
 * forever — a double-spend or a malformed proof will never succeed.
 *
 * `needs-card` entries are skipped: they have nothing to submit until the card
 * returns. `submitting` entries left behind by a killed process are picked up
 * and resolved. A drain already in flight makes this a no-op.
 *
 * Rejects with `SettlementPersistenceError` if the mint accepted a proof and
 * the local write would not land. That is not a settlement failure and is
 * never treated as one: the entry is remembered in-process so no later drain
 * re-submits it, and on disk it is left `submitting` so the guard survives the
 * app being killed as well.
 */
export async function drainQueue(
  swap: (entry: SettlementEntry) => Promise<void>,
  now: number,
): Promise<DrainResult> {
  const result: DrainResult = {
    settled: 0,
    stillPending: 0,
    failed: 0,
    lost: 0,
  };
  if (draining) {
    return result;
  }
  draining = true;
  try {
    const {entries} = await loadQueue();

    for (const entry of entries) {
      if (
        (entry.status !== 'pending' && entry.status !== 'submitting') ||
        !entry.witness
      ) {
        continue;
      }
      if (mintConfirmed.has(entry.id)) {
        // The mint already has this proof; only the write is outstanding.
        await persistSettled(entry.id, now, result);
        continue;
      }
      // Read off the snapshot, before this drain overwrites it: 'submitting' on
      // disk means an earlier run handed this proof to the mint and never
      // learned the outcome — a crash mid-call, or a post-swap write that would
      // not land. The in-memory `mintConfirmed` set cannot survive either.
      const outcomeUnknown = entry.status === 'submitting';

      // Claim the entry durably *before* the network call, so the same
      // inference is available to the next launch if this process dies here.
      let raced = false;
      const claimed = await update(entry.id, e => {
        if (e.status !== 'pending' && e.status !== 'submitting') {
          raced = true;
          return e;
        }
        return {...e, status: 'submitting', updatedAt: now};
      });
      if (!claimed || raced) {
        // Settled, failed, or pruned out from under us since the snapshot.
        continue;
      }

      try {
        await swap(entry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof PermanentSettlementError) {
          if (outcomeUnknown) {
            // A proof only reaches 'submitting' on disk after it was handed to
            // the mint, so "permanently rejected" now means the mint already
            // has it. That is money received; markFailed would write off money
            // the merchant actually got.
            mintConfirmed.add(entry.id);
            await persistSettled(entry.id, now, result);
            continue;
          }
          const marked = await markFailed(entry.id, reason, now);
          if (marked) {
            result.failed += 1;
          } else {
            result.lost += 1;
          }
        } else {
          // A rejection from `swap` on a first submission is a known outcome —
          // back to 'pending'. If the outcome was already unknown, it stays
          // unknown: reverting would let a later permanent rejection be read as
          // a real failure.
          const marked = await markAttemptFailed(
            entry.id,
            reason,
            now,
            outcomeUnknown ? 'submitting' : 'pending',
          );
          if (marked) {
            result.stillPending += 1;
          } else {
            result.lost += 1;
          }
        }
        continue;
      }
      // Past this line the money is at the mint. Anything that goes wrong now
      // is a persistence problem, and must never fall through to the catch
      // above — marking it 'failed' would write off money we actually received.
      mintConfirmed.add(entry.id);
      await persistSettled(entry.id, now, result);
    }
    return result;
  } finally {
    draining = false;
  }
}

/** Forget settled entries. Never touches anything still outstanding. */
export async function pruneSettled(): Promise<number> {
  return withQueue(async ({entries}) => {
    const keep = entries.filter(e => e.status !== 'settled');
    await writeQueue(keep);
    return entries.length - keep.length;
  });
}

/**
 * Maintenance hook: wipe the queue. Refuses while money is outstanding.
 *
 * There is no override. A boolean that deletes unsettled payments is a footgun
 * with no production use case — settle or `markFailed` the entries first.
 */
export async function clearQueue(): Promise<void> {
  return withQueue(async ({entries}) => {
    if (entries.some(isOutstanding)) {
      throw new Error(
        'refusing to clear the settlement queue while payments are outstanding',
      );
    }
    await removeSecure(QUEUE_KEY);
  });
}
