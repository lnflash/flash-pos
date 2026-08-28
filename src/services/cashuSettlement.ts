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
 * 1. **Fail closed.** A store that cannot be read is not an empty store. Every
 *    entry point either propagates the failure or answers the conservative way
 *    (`hasUnsettledForCard` says "yes, still unsettled"). Nothing writes over a
 *    queue it could not read.
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

/** Cap the queue so a long outage cannot grow storage without bound. */
export const MAX_QUEUE_ENTRIES = 200;

/** How many times a post-swap write is retried before it becomes an error. */
const PERSIST_ATTEMPTS = 3;

export type SettlementStatus =
  /** Witness held; the mint has not confirmed. Retries on its own. */
  | 'pending'
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
  entries: SettlementEntry[];
  /** The stored bytes were unparseable. They have been quarantined. */
  corrupt: boolean;
}

async function quarantine(raw: string): Promise<void> {
  // Best effort by design: failing to preserve the bad bytes must not also
  // take the till down, but the attempt happens before any overwrite.
  try {
    await setSecure(CORRUPT_QUEUE_KEY, raw);
  } catch {
    // nothing further to do — the read path continues degraded
  }
}

/**
 * Read the queue, separating "nothing stored" from "could not read".
 *
 * Throws `QueueUnavailableError` on a storage failure. Corrupt bytes resolve to
 * an empty queue flagged `corrupt`, after quarantining the original.
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
    return {entries: [], corrupt: false};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantine(raw);
    return {entries: [], corrupt: true};
  }
  if (!Array.isArray(parsed)) {
    await quarantine(raw);
    return {entries: [], corrupt: true};
  }
  return {entries: parsed as SettlementEntry[], corrupt: false};
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
 */
let tail: Promise<unknown> = Promise.resolve();

function withQueue<T>(fn: (read: QueueRead) => Promise<T>): Promise<T> {
  const run = tail.then(async () => fn(await loadQueue()));
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Throws `QueueUnavailableError` if the store cannot be read. */
export async function listSettlements(): Promise<SettlementEntry[]> {
  return (await loadQueue()).entries;
}

/** Entries still owed to the merchant — what `pendingExposure` totals. */
export const isOutstanding = (e: SettlementEntry): boolean =>
  e.status === 'pending' || e.status === 'needs-card';

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

/** A retryable miss — stays outstanding, attempt count goes up. */
export const markAttemptFailed = (id: string, reason: string, now: number) =>
  update(id, e => ({
    ...e,
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
 */
export const attachRecoveredWitness = (
  id: string,
  witness: string,
  now: number,
) =>
  update(id, e =>
    e.status === 'needs-card'
      ? {...e, witness, status: 'pending', updatedAt: now}
      : e,
  );

export interface Exposure {
  /** Total the merchant is owed but has not settled, in the keyset's base unit. */
  total: number;
  count: number;
  /** Entries whose card must come back before they can settle. */
  needsCard: number;
  /** Permanently failed — a human has to look at these. */
  failed: number;
}

/**
 * What the merchant is currently carrying. Shown in the UI, not hidden: the
 * whole basis for accepting offline is that the risk is visible and theirs.
 *
 * Throws `QueueUnavailableError` rather than reporting a clean till it cannot
 * actually vouch for — a false zero here is the one answer the merchant must
 * never be given.
 */
export async function pendingExposure(): Promise<Exposure> {
  const {entries} = await loadQueue();
  const outstanding = entries.filter(isOutstanding);
  return {
    total: outstanding.reduce((sum, e) => sum + e.amount, 0),
    count: outstanding.length,
    needsCard: entries.filter(e => e.status === 'needs-card').length,
    failed: entries.filter(e => e.status === 'failed').length,
  };
}

/**
 * True while this card still has unsettled spends.
 *
 * `CLEAR_SPENT` erases spent slots, which is what turns a recoverable burn into
 * real loss — so it must never run while this returns true.
 *
 * Fails closed: an unreadable or corrupt queue answers `true`. The gate staying
 * shut costs the merchant a retry; opening it on a failed read costs the money.
 */
export async function hasUnsettledForCard(
  cardPubkey: string,
): Promise<boolean> {
  try {
    const {entries, corrupt} = await loadQueue();
    if (corrupt) {
      return true;
    }
    return entries.some(e => e.cardPubkey === cardPubkey && isOutstanding(e));
  } catch {
    return true;
  }
}

/** Entries this card could recover right now by re-signing. */
export async function recoverableForCard(
  cardPubkey: string,
): Promise<SettlementEntry[]> {
  const {entries} = await loadQueue();
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

/** Test seam: drop the in-memory record of unpersisted mint confirmations. */
export function __resetDrainState(): void {
  draining = false;
  mintConfirmed.clear();
}

async function persistSettled(
  id: string,
  now: number,
  result: DrainResult,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt++) {
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
 * returns. A drain already in flight makes this a no-op.
 *
 * Rejects with `SettlementPersistenceError` if the mint accepted a proof and
 * the local write would not land. That is not a settlement failure and is
 * never treated as one: the entry is remembered in-process so no later drain
 * re-submits it.
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
      if (entry.status !== 'pending' || !entry.witness) {
        continue;
      }
      if (mintConfirmed.has(entry.id)) {
        // The mint already has this proof; only the write is outstanding.
        await persistSettled(entry.id, now, result);
        continue;
      }
      try {
        await swap(entry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof PermanentSettlementError) {
          const marked = await markFailed(entry.id, reason, now);
          if (marked) {
            result.failed += 1;
          } else {
            result.lost += 1;
          }
        } else {
          const marked = await markAttemptFailed(entry.id, reason, now);
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
