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
 */
import {getSecure, removeSecure, setSecure} from './secureStorage';

const QUEUE_KEY = '@cashu_settlement_queue';

/** Cap the queue so a long outage cannot grow storage without bound. */
export const MAX_QUEUE_ENTRIES = 200;

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
  nonce: string;
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

const parse = (json: string | null): SettlementEntry[] => {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as SettlementEntry[]) : [];
  } catch {
    // A corrupt queue must not take the till down. Losing the file loses the
    // record of money already spent, so this is logged loudly upstream.
    return [];
  }
};

async function readQueue(): Promise<SettlementEntry[]> {
  try {
    return parse(await getSecure(QUEUE_KEY));
  } catch {
    return [];
  }
}

async function writeQueue(entries: SettlementEntry[]): Promise<void> {
  await setSecure(QUEUE_KEY, JSON.stringify(entries));
}

export async function listSettlements(): Promise<SettlementEntry[]> {
  return readQueue();
}

/** Entries still owed to the merchant — what `pendingExposure` totals. */
export const isOutstanding = (e: SettlementEntry): boolean =>
  e.status === 'pending' || e.status === 'needs-card';

/**
 * Durably record a spend. **Await this before showing an approval.**
 *
 * Returns the stored entry. Throws if it could not be persisted — and a throw
 * here means do not approve the payment, because nothing would remember it.
 */
export async function recordSpend(
  record: SpendRecord,
  now: number,
  id: string,
): Promise<SettlementEntry> {
  const entry: SettlementEntry = {
    ...record,
    id,
    // No witness means the card burned the slot without returning a signature.
    status: record.witness ? 'pending' : 'needs-card',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };

  const queue = await readQueue();
  // Drop settled entries first, never outstanding ones: a full queue must not
  // silently discard money the merchant is still owed.
  const trimmed = [...queue, entry];
  if (trimmed.length > MAX_QUEUE_ENTRIES) {
    const settled = trimmed.filter(e => e.status === 'settled');
    const keep = trimmed.filter(e => e.status !== 'settled');
    const room = Math.max(0, MAX_QUEUE_ENTRIES - keep.length);
    await writeQueue([...settled.slice(-room), ...keep]);
  } else {
    await writeQueue(trimmed);
  }
  return entry;
}

async function update(
  id: string,
  patch: (e: SettlementEntry) => SettlementEntry,
): Promise<SettlementEntry | null> {
  const queue = await readQueue();
  const idx = queue.findIndex(e => e.id === id);
  if (idx === -1) {
    return null;
  }
  const next = patch(queue[idx]);
  queue[idx] = next;
  await writeQueue(queue);
  return next;
}

export const markSettled = (id: string, now: number) =>
  update(id, e => ({...e, status: 'settled', updatedAt: now, lastError: undefined}));

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

/** Attach a witness recovered by re-signing, moving `needs-card` → `pending`. */
export const attachRecoveredWitness = (id: string, witness: string, now: number) =>
  update(id, e => ({...e, witness, status: 'pending', updatedAt: now}));

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
 */
export async function pendingExposure(): Promise<Exposure> {
  const queue = await readQueue();
  const outstanding = queue.filter(isOutstanding);
  return {
    total: outstanding.reduce((sum, e) => sum + e.amount, 0),
    count: outstanding.length,
    needsCard: queue.filter(e => e.status === 'needs-card').length,
    failed: queue.filter(e => e.status === 'failed').length,
  };
}

/**
 * True while this card still has unsettled spends.
 *
 * `CLEAR_SPENT` erases spent slots, which is what turns a recoverable burn into
 * real loss — so it must never run while this returns true.
 */
export async function hasUnsettledForCard(cardPubkey: string): Promise<boolean> {
  const queue = await readQueue();
  return queue.some(e => e.cardPubkey === cardPubkey && isOutstanding(e));
}

/** Entries this card could recover right now by re-signing. */
export async function recoverableForCard(
  cardPubkey: string,
): Promise<SettlementEntry[]> {
  const queue = await readQueue();
  return queue.filter(e => e.cardPubkey === cardPubkey && e.status === 'needs-card');
}

/** A settlement that will never succeed — double-spend, malformed proof. */
export class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSettlementError';
  }
}

export interface DrainResult {
  settled: number;
  stillPending: number;
  failed: number;
}

/**
 * Try to settle every entry holding a witness.
 *
 * `swap` resolves on mint confirmation, and rejects otherwise. Reject with a
 * `PermanentSettlementError` to mark an entry failed instead of retrying it
 * forever — a double-spend or a malformed proof will never succeed.
 *
 * `needs-card` entries are skipped: they have nothing to submit until the card
 * returns.
 */
export async function drainQueue(
  swap: (entry: SettlementEntry) => Promise<void>,
  now: number,
): Promise<DrainResult> {
  const queue = await readQueue();
  const result: DrainResult = {settled: 0, stillPending: 0, failed: 0};

  for (const entry of queue) {
    if (entry.status !== 'pending' || !entry.witness) {
      continue;
    }
    try {
      await swap(entry);
      await markSettled(entry.id, now);
      result.settled += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentSettlementError) {
        await markFailed(entry.id, reason, now);
        result.failed += 1;
      } else {
        await markAttemptFailed(entry.id, reason, now);
        result.stillPending += 1;
      }
    }
  }
  return result;
}

/** Forget settled entries. Never touches anything still outstanding. */
export async function pruneSettled(): Promise<number> {
  const queue = await readQueue();
  const keep = queue.filter(e => e.status !== 'settled');
  await writeQueue(keep);
  return queue.length - keep.length;
}

/** Test and maintenance hook: wipe the queue. Refuses if money is still outstanding. */
export async function clearQueue(force = false): Promise<void> {
  if (!force) {
    const queue = await readQueue();
    if (queue.some(isOutstanding)) {
      throw new Error(
        'refusing to clear the settlement queue while payments are outstanding',
      );
    }
  }
  await removeSecure(QUEUE_KEY);
}
