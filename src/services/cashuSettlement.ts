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
 * recorded as `needs-card` and recovers by re-signing from the same card
 * (`resignWitness`), which works because a spent slot is still readable and
 * `SIGN_ARBITRARY` consumes nothing.
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
 *
 * Two things are written on every detection: this key, which always holds the
 * *most recent* corrupt blob, and `quarantineKeyFor(raw)`, which is per-*blob*
 * and never overwritten by a different one. The marker at
 * `UNKNOWN_EXPOSURE_KEY` names the second one, because it is the blob an
 * operator must reconcile against before acknowledging — a second, different
 * corruption would otherwise silently replace the bytes the marker points at.
 */
export const CORRUPT_QUEUE_KEY = '@cashu_settlement_queue_corrupt';

/**
 * The quarantine slot for one corrupt blob, keyed by its content hash.
 *
 * Keyed by content and not by clock, because `quarantine` runs from *every*
 * read path — `listSettlements`, `pendingExposure`, `hasUnsettledForCard`,
 * `recoverableForCard`, `withQueue`, `drainQueue` — and a corrupt blob is only
 * cleared by the next write. A clock-keyed slot therefore mints a fresh copy of
 * the whole corrupt queue on every poll of an exposure banner, unboundedly,
 * with nothing to prune them. Re-reading the same bytes must land on the same
 * key; two genuinely different corruptions must not collide. A content hash is
 * the only key with both properties — and unlike `Date.now()` it cannot collide
 * inside a single millisecond either.
 *
 * See `CORRUPT_QUEUE_KEY`.
 */
export const quarantineKeyFor = (raw: string): string =>
  `${CORRUPT_QUEUE_KEY}:${bytesToHex(sha256(utf8ToBytes(raw))).slice(0, 16)}`;
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

/**
 * Cap the queue so a long outage cannot grow storage without bound.
 *
 * A soft cap by design: it is enforced by evicting entries nothing is owed on —
 * settled ones, then failures an operator has retired with `acknowledgeFailed`.
 * When there are none of those left the queue is allowed past the cap rather
 * than discard the record of money the merchant is still owed, or the evidence
 * of money they lost.
 */
export const MAX_QUEUE_ENTRIES = 200;

/**
 * Version of the stored envelope, `{v, entries}`.
 *
 * The blob is the durable record of money that left a card, so it has to be
 * readable by every release that comes after the one that wrote it. Without a
 * version, the first release to add a required field would classify every entry
 * the previous release wrote as corrupt — quarantined, dropped from the queue,
 * and turned into `unknownSince` exposure the merchant cannot reconcile because
 * the app can no longer read the blob it just failed to parse.
 *
 * A bare array is `v0`: the shape shipped before `mintUrl`/`unit` existed.
 * Bump this and add a migration arm in `migrate` whenever a required field is
 * added; never add one without an arm.
 *
 * Reads are forward-compatible as well as backward-compatible: an envelope
 * written by a *newer* build is read with the fields this one understands and
 * its unrecognised fields are preserved verbatim, because a rollback must not
 * turn readable money into unreconcilable loss. See `migrate`. The corollary is
 * a constraint on future bumps: a new version may add fields, but it must never
 * remove one this build requires or change one's type, or a downgraded build
 * will read its entries as corrupt.
 */
export const QUEUE_SCHEMA_VERSION = 1;

/**
 * Stand-in `mintUrl` for a `v0` entry, which predates the field.
 *
 * Empty rather than a guessed default: the queue genuinely does not know which
 * mint holds these, and inventing one would send a proof to a mint that never
 * issued it. A settlement adapter is expected to fall back to the configured
 * mint for these and to nothing else.
 */
export const LEGACY_MINT_URL = '';

/** Stand-in `unit` for a `v0` entry. Buckets separately in `Exposure.totals`. */
export const LEGACY_UNIT = 'unknown';

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
   * Claimed for submission, outcome unknown.
   *
   * Written to disk immediately *before* the swap, so it survives the app being
   * killed mid-call — routine on mobile — and it is what an entry stays after
   * any ambiguous swap failure: a timeout or a reset after the mint processed
   * the request is indistinguishable from one that never arrived. It does
   * **not** mean the mint saw the proof: the claim write lands first, so a
   * process killed here leaves an entry `submitting` that never reached the
   * network at all. Only a `ProofAlreadySpentError` — the mint itself saying it
   * holds this proof — or a `checkState` of `spent` turns that into a
   * settlement. See `drainQueue`.
   */
  | 'submitting'
  /** The slot burned but the witness was lost. Needs the card once more. */
  | 'needs-card'
  /** The mint confirmed. Money is ours. */
  | 'settled'
  /** Permanently rejected by the mint. Needs a human. */
  | 'failed';

export interface SettlementEntry {
  /**
   * `<cardPubkey>:<slot>:<nonce>` — derived from the burn itself, never
   * supplied by a caller. Unique per burn by construction, so recording the
   * same burn twice is recognisable as the same entry rather than as a
   * conflict. See `settlementId`.
   */
  id: string;
  /** Card pubkey — identifies which card must return for a `needs-card` entry. */
  cardPubkey: string;
  slot: number;
  keysetId: string;
  /**
   * The mint that issued this proof, and the only one that can settle it.
   *
   * Persisted per entry rather than read from config at drain time: the
   * configured mint URL can change while entries are queued — an app update, a
   * mint that moved — and submitting a queued proof to a mint that never issued
   * it gets it rejected as unknown. `LEGACY_MINT_URL` (empty) marks a `v0`
   * entry whose mint was not recorded.
   */
  mintUrl: string;
  /**
   * The keyset's unit, e.g. `sat` or `usd`. Nothing constrains the queue to one
   * keyset, so amounts are only comparable within a unit — `Exposure.totals` is
   * keyed by this for that reason. `LEGACY_UNIT` marks a `v0` entry.
   */
  unit: string;
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
  /**
   * ms epoch an operator reconciled a `failed` entry, via `acknowledgeFailed`.
   *
   * Only acknowledged failures are evictable. Until then a failure is evidence
   * of money the merchant lost and the queue keeps it, cap or no cap.
   */
  acknowledgedAt?: number;
}

/** What `recordSpend` needs. Everything else is derived. */
export type SpendRecord = Omit<
  SettlementEntry,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'attempts'
  | 'lastError'
  | 'acknowledgedAt'
>;

/**
 * The queue id of a burn: `<cardPubkey>:<slot>:<nonce>`.
 *
 * Derived, not supplied. A caller-supplied id makes `recordSpend` able to
 * *decline* a payment for a slot that is already burned — the one outcome it
 * must never produce — and makes it non-idempotent under any generic retry
 * wrapper. Every component here comes from the card, and the nonce is fresh per
 * proof, so two different burns cannot collide and the same burn always lands
 * on the same id.
 */
export const settlementId = (
  record: Pick<SpendRecord, 'cardPubkey' | 'slot' | 'nonce'>,
): string => `${record.cardPubkey}:${record.slot}:${record.nonce}`;

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

/**
 * The swap request provably never left the device.
 *
 * The narrow exception to the rule in `drainQueue` that a claimed entry stays
 * `submitting` once the claim write has landed. Every ordinary transport
 * failure is ambiguous — a timeout, a connection reset, a 502 from a proxy all
 * look identical whether the mint processed the request or never saw it — so
 * the queue cannot assume the proof is still unspent, and treating the entry as
 * a fresh submission next time is what books received money as lost.
 *
 * A swap adapter may raise this **only** when the request demonstrably never
 * reached the network: an offline pre-flight check that short-circuits before
 * any socket is opened, a DNS resolution failure, a connection refused. Never
 * for a timeout, a reset, an aborted read, or any non-2xx response — by then
 * the mint may already hold the proof. Raising it loosely reintroduces exactly
 * the bug it exists to avoid.
 */
export class TransportSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportSettlementError';
  }
}

/**
 * A settlement that will never succeed — a malformed proof, an unknown keyset,
 * a proof submitted to the wrong mint. Retrying is pointless; the entry is
 * marked `failed` and a human has to look at it.
 *
 * This is **not** the class to raise when the mint says it already holds the
 * proof. That is `ProofAlreadySpentError`, and the difference is the difference
 * between money received and money lost.
 */
export class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSettlementError';
  }
}

/**
 * The mint says this exact proof is already spent.
 *
 * A swap adapter must raise this **only** for a NUT-07 `SPENT` state or the
 * NUT-XX `11001` "Token already spent" error code — i.e. only when the mint has
 * identified this proof and confirmed it holds it. Nothing else qualifies: not
 * a malformed proof, not a bad `C` from a flaky NFC read, not a rotated keyset,
 * not a generic 400.
 *
 * The distinction is load-bearing. For an entry found `submitting` on disk this
 * is the only signal that separates "the mint already took it" (money received,
 * settle) from "this proof was never valid" (money gone, fail). Raising it
 * loosely books money that left the card and reached no mint as received, and
 * `pendingExposure()` drops to zero over a loss the merchant is never shown.
 */
export class ProofAlreadySpentError extends PermanentSettlementError {
  constructor(message: string) {
    super(message);
    this.name = 'ProofAlreadySpentError';
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
 * Used by `resignWitness` on the recovery path, and fed to `spendProof` on the
 * first attempt. Returned as a plain byte array to match the card API.
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
  if (!isV0Entry(value)) {
    return false;
  }
  const e = value as unknown as Record<string, unknown>;
  return (
    // Empty is legal — `LEGACY_MINT_URL` — so this checks the type, not the
    // length. `unit` has a non-empty legacy stand-in and so is checked as text.
    typeof e.mintUrl === 'string' && isText(e.unit)
  );
}

/**
 * The `v0` shape: everything a settlement entry has always had, minus the
 * fields added in `v1`. Migration validates against this and then fills the
 * additions in, so entries written by an older release stay readable instead of
 * being classified as corrupt.
 */
function isV0Entry(
  value: unknown,
): value is Omit<SettlementEntry, 'mintUrl' | 'unit'> {
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
    (e.lastError === undefined || typeof e.lastError === 'string') &&
    (e.acknowledgedAt === undefined || isNum(e.acknowledgedAt))
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
  const detectedAt = Date.now();
  const quarantineKey = quarantineKeyFor(raw);
  try {
    // The content-keyed copy first: this is the blob the marker will name, and
    // no *different* blob can ever land on top of it. Re-reading the same
    // corrupt bytes rewrites the same key, so the read paths that call this on
    // every poll cannot grow storage without bound. The bare key is a
    // convenience pointer at the most recent bytes and is deliberately allowed
    // to be overwritten.
    await setSecure(quarantineKey, raw);
    await setSecure(CORRUPT_QUEUE_KEY, raw);
  } catch {
    // nothing further to do — the read path continues degraded
  }
  try {
    const existing = await getSecureStrict(UNKNOWN_EXPOSURE_KEY);
    if (!existing) {
      // First detection wins: a later corruption must not reset the clock on
      // exposure the merchant has been carrying since the original one. The
      // key it names is per-blob for the same reason — an operator
      // reconciling against it must see the bytes that were lost *then*, not
      // whatever a later corruption happened to leave behind.
      await setSecure(
        UNKNOWN_EXPOSURE_KEY,
        JSON.stringify({since: detectedAt, quarantineKey}),
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
  const {version, elements} = unwrap(parsed);
  if (elements === null) {
    return {
      entries: [],
      corrupt: true,
      corruptionRecorded: await quarantine(raw),
    };
  }
  const entries = migrate(version, elements);
  if (entries.length !== elements.length) {
    // Keep what validated — those are real settlements the merchant is owed —
    // but the blob as a whole is corrupt and must be treated as such.
    return {entries, corrupt: true, corruptionRecorded: await quarantine(raw)};
  }
  return {entries, corrupt: false, corruptionRecorded: false};
}

/**
 * Split the stored blob into a schema version and its elements.
 *
 * A bare array is `v0`, the shape written before the envelope existed. A
 * version *newer* than this build's is still unwrapped: see `migrate` for why a
 * downgrade must not classify readable money as corrupt. Only a blob with no
 * usable envelope at all — a non-numeric or negative `v`, or `entries` that is
 * not an array — is `elements: null`, i.e. corrupt.
 */
function unwrap(parsed: unknown): {
  version: number;
  elements: unknown[] | null;
} {
  if (Array.isArray(parsed)) {
    return {version: 0, elements: parsed};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {version: -1, elements: null};
  }
  const {v, entries} = parsed as {v?: unknown; entries?: unknown};
  if (!isNum(v) || v < 0 || !Array.isArray(entries)) {
    return {version: -1, elements: null};
  }
  return {version: v, elements: entries};
}

/**
 * Bring every element this build can read up to the current shape.
 *
 * One arm per version. Elements that do not validate against their own version
 * are dropped here and the caller turns that into `corrupt`, exactly as before
 * — the point of the versioning is that a *whole release* of well-formed
 * entries never lands in that bucket just because a field was added.
 *
 * The forward arm is the same filter, and deliberately so. A staged-rollout
 * rollback — a TestFlight/Play downgrade, a reinstall of an older build — hands
 * this a `v2` blob whose entries are a *superset* of `v1`: perfectly readable
 * money that an older build would otherwise quarantine, drop from
 * `pendingExposure` and `recoverableForCard`, and replace on the next tap. That
 * loses settlements no card can ever be re-tapped to recover, and the
 * `unknownSince` flag it raises gives the merchant nothing to reconcile
 * against. `filter` hands back the *original* objects, so fields this build
 * does not understand ride straight through `writeQueue`'s `JSON.stringify`
 * untouched — nothing is dropped and the money stays visible. Only entries an
 * older build genuinely cannot read fall out, and those still become `corrupt`.
 */
function migrate(version: number, elements: unknown[]): SettlementEntry[] {
  if (version === 0) {
    return elements.filter(isV0Entry).map(e => ({
      ...e,
      mintUrl: LEGACY_MINT_URL,
      unit: LEGACY_UNIT,
    }));
  }
  // v1, and every version after it this build has not been taught about.
  return elements.filter(isSettlementEntry);
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
  await setSecure(
    QUEUE_KEY,
    JSON.stringify({v: QUEUE_SCHEMA_VERSION, entries}),
  );
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

/** A failure an operator has reconciled — the only evictable failure. */
const isRetiredFailure = (e: SettlementEntry): boolean =>
  e.status === 'failed' && e.acknowledgedAt !== undefined;

/**
 * Make room by dropping the oldest entries nothing is owed on — settled ones
 * first, then failures an operator has already reconciled. Never an outstanding
 * entry, because a full queue must not silently discard money the merchant is
 * still owed, and never an *un*acknowledged failure, because that is the only
 * evidence the merchant has of money they lost.
 *
 * Chronology is preserved: the survivors are filtered out of the original
 * array rather than rebuilt by concatenating partitions, so `listSettlements`
 * and the drain loop stay in the order the burns happened.
 */
function evict(queue: SettlementEntry[]): SettlementEntry[] {
  const overBy = queue.length - MAX_QUEUE_ENTRIES;
  if (overBy <= 0) {
    return queue;
  }
  const drop = new Set<SettlementEntry>();
  for (const e of queue) {
    if (drop.size >= overBy) {
      break;
    }
    if (e.status === 'settled') {
      drop.add(e);
    }
  }
  for (const e of queue) {
    if (drop.size >= overBy) {
      break;
    }
    if (isRetiredFailure(e)) {
      drop.add(e);
    }
  }
  return queue.filter(e => !drop.has(e));
}

/**
 * Durably record a spend. **Await this before showing an approval.**
 *
 * Returns the stored entry — the existing one if this exact burn has already
 * been recorded, because the id is derived from the burn (`settlementId`) and a
 * second call for the same slot is a retry, not a conflict. Recording is
 * idempotent for that reason: the one thing this must never do is decline a
 * payment for a slot the card has already burned.
 *
 * Throws if it could not be persisted — and a throw here means do not approve
 * the payment, because nothing would remember it. That includes a storage read
 * failure: an unreadable queue is not an empty one, and writing over it would
 * erase every outstanding settlement.
 */
export async function recordSpend(
  record: SpendRecord,
  now: number,
): Promise<SettlementEntry> {
  if (!record.secret) {
    // Without the secret there is nothing to submit and nothing to re-sign.
    // Refusing here means the payment is declined instead of silently
    // unsettleable.
    throw new Error('settlement record is missing the proof secret');
  }
  if (!record.mintUrl) {
    // Without the mint there is nowhere to submit it: the configured mint can
    // change while an entry is queued, so "whatever is configured at drain
    // time" is not an answer.
    throw new Error('settlement record is missing the mint url');
  }
  if (!record.unit) {
    // An amount with no unit cannot be totalled honestly beside another.
    throw new Error('settlement record is missing the keyset unit');
  }
  const id = settlementId(record);
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
    const existing = entries.find(e => e.id === id);
    if (existing) {
      // Already durably recorded — that is the postcondition this function
      // promises, so hand back what is on disk rather than writing a twin
      // (`update` patches only the first, so the second would stay pending
      // forever and be submitted twice) or throwing, which the caller is
      // documented to read as "do not approve".
      return existing;
    }
    const next = [...entries, entry];
    await writeQueue(evict(next));
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
 * never took the proof, so even a later `ProofAlreadySpentError` is somebody
 * else's spend and a real failure) from one whose outcome is still unknown
 * (`submitting`: the proof may already be at the mint, so a later
 * `ProofAlreadySpentError` — and only that — is a confirmation).
 *
 * The default is `pending` for the callers outside the drain loop that know
 * nothing was submitted. Inside `drainQueue`, once the claim write has landed,
 * `submitting` is the only honest answer unless a `TransportSettlementError`
 * says the request never left the device.
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

/** One unit's slice of the outstanding total. */
export interface UnitExposure {
  amount: number;
  count: number;
}

export interface Exposure {
  /**
   * What the merchant is owed, keyed by keyset unit (`sat`, `usd`, …).
   *
   * Per unit and not a single number, because nothing constrains the queue to
   * one keyset: 40 `sat` beside 40 `usd` summed to `80`, a figure that is not
   * money in any currency and would have been shown to the merchant as if it
   * were. Absent units are absent keys — an empty object is a clean till.
   */
  totals: Record<string, UnitExposure>;
  /** Outstanding entries across every unit. Counts are unit-agnostic. */
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
  const totals: Record<string, UnitExposure> = {};
  for (const e of outstanding) {
    const bucket = totals[e.unit] ?? {amount: 0, count: 0};
    bucket.amount += e.amount;
    bucket.count += 1;
    totals[e.unit] = bucket;
  }
  return {
    totals,
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
  /**
   * The mint took a proof and the local `settled` write would not land, for
   * each entry it happened to.
   *
   * Collected rather than thrown: one entry whose write fails must not stop the
   * entries behind it from settling, and must not throw away the count of what
   * already did. The entries are left `submitting` on disk and remembered
   * in-process, so no later drain re-submits them.
   */
  persistenceErrors: SettlementPersistenceError[];
  /**
   * A drain was already in flight and this call did nothing.
   *
   * Distinct from an all-zero result on an empty queue: a merchant-facing
   * "Settle now" fired during the background drain would otherwise report a
   * completed drain that settled nothing and changed no exposure.
   */
  skipped: boolean;
}

/** Optional collaborators for a drain. */
export interface DrainOptions {
  /**
   * NUT-07 `/v1/checkstate` on the proof's `Y`, if the caller can offer one.
   *
   * Consulted for every entry found `submitting` on disk, where the outcome of
   * an earlier attempt is genuinely unknown — a killed process, a post-swap
   * write that would not land, or any ambiguous rejection from `swap`. It is
   * the honest way to resolve that: ask the mint whether it holds the proof
   * instead of inferring it from the shape of a later rejection. Worth supplying
   * for that reason: without it an entry that took a timeout stays `submitting`
   * until the mint answers `11001` to a resubmission. `spent` settles the entry without
   * submitting anything; `unspent` means the earlier run never reached the mint,
   * so an ordinary submission follows and a permanent rejection of it is a real
   * failure. Anything else — including a throw — leaves the outcome unknown and
   * the entry is submitted with its `submitting` inference intact.
   */
  checkState?: (
    entry: SettlementEntry,
  ) => Promise<'spent' | 'unspent' | 'unknown'>;
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
 * `persistSettled`, with the failure collected instead of thrown.
 *
 * A write that will not land is this one entry's problem. Letting it reject the
 * whole drain stops every entry behind it from ever being attempted and throws
 * away the count of what already settled, so the caller cannot report either.
 */
async function settleConfirmed(
  id: string,
  now: number,
  result: DrainResult,
): Promise<void> {
  try {
    await persistSettled(id, now, result);
  } catch (error) {
    if (error instanceof SettlementPersistenceError) {
      result.persistenceErrors.push(error);
      return;
    }
    throw error;
  }
}

/**
 * Try to settle every entry holding a witness.
 *
 * `swap` resolves on mint confirmation, and rejects otherwise. It receives the
 * whole entry and must submit to `entry.mintUrl` — the configured mint can have
 * changed since the burn. Reject with a `PermanentSettlementError` to mark an
 * entry failed instead of retrying it forever, and with a
 * `ProofAlreadySpentError` — and only for a NUT-07 `SPENT` / `11001` response —
 * when the mint says it already holds the proof. Any *other* rejection leaves
 * the entry `submitting`, because the claim write lands before the call and the
 * outcome is therefore unknown by construction; reject with a
 * `TransportSettlementError` to say the request provably never left the device
 * and return the entry to `pending`.
 *
 * `needs-card` entries are skipped: they have nothing to submit until the card
 * returns. `submitting` entries left behind by a killed process are picked up
 * and resolved, by `options.checkState` where the caller can offer one and by
 * the mint's response to the resubmission otherwise. A drain already in flight
 * makes this a no-op flagged `skipped`.
 *
 * Never rejects for a `SettlementPersistenceError`: the mint accepting a proof
 * whose local write will not land is not a settlement failure and must not stop
 * the rest of the queue. Those are collected in `result.persistenceErrors`, the
 * entry is remembered in-process so no later drain re-submits it, and on disk
 * it is left `submitting` so the guard survives the app being killed as well.
 */
export async function drainQueue(
  swap: (entry: SettlementEntry) => Promise<void>,
  now: number,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const result: DrainResult = {
    settled: 0,
    stillPending: 0,
    failed: 0,
    lost: 0,
    persistenceErrors: [],
    skipped: false,
  };
  if (draining) {
    result.skipped = true;
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
        await settleConfirmed(entry.id, now, result);
        continue;
      }
      // Read off the snapshot, before this drain overwrites it: 'submitting' on
      // disk means an earlier attempt claimed this proof and never learned the
      // outcome — a crash mid-call, a post-swap write that would not land, or
      // an ambiguous rejection from `swap`. It does *not* mean the mint saw it:
      // the claim write lands before the swap. The in-memory `mintConfirmed`
      // set cannot survive either.
      let outcomeUnknown = entry.status === 'submitting';

      if (outcomeUnknown && options.checkState) {
        // Ask the mint what actually happened rather than inferring it later.
        let state: 'spent' | 'unspent' | 'unknown';
        try {
          state = await options.checkState(entry);
        } catch {
          state = 'unknown';
        }
        if (state === 'spent') {
          mintConfirmed.add(entry.id);
          await settleConfirmed(entry.id, now, result);
          continue;
        }
        if (state === 'unspent') {
          // The mint never took it, so a permanent rejection of the submission
          // below is a genuine failure and not a confirmation.
          outcomeUnknown = false;
        }
      }

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
          if (outcomeUnknown && error instanceof ProofAlreadySpentError) {
            // The mint has identified this proof and says it holds it. That is
            // money received; markFailed would write off money the merchant
            // actually got. Every *other* permanent rejection takes the failure
            // branch below even here — a claim written before a process died
            // may never have reached any mint, and a proof that is simply
            // invalid must not be booked as settled.
            mintConfirmed.add(entry.id);
            await settleConfirmed(entry.id, now, result);
            continue;
          }
          const marked = await markFailed(entry.id, reason, now);
          if (marked) {
            result.failed += 1;
          } else {
            result.lost += 1;
          }
        } else {
          // The claim write above has already landed, so by construction the
          // outcome of *this* attempt is unknown too: a timeout or a reset on
          // the swap POST looks the same whether the mint processed it or never
          // saw it. Reverting to 'pending' asserts the mint never saw the proof,
          // and the next drain would then read the `11001 Token already spent`
          // it gets back as a real failure — writing off money the mint holds
          // and the merchant was paid. So the entry stays 'submitting' and
          // `options.checkState` or a later `ProofAlreadySpentError` resolves
          // it. The one exception is an adapter that can *prove* the request
          // never left the device, and only if the outcome was not already
          // unknown from an earlier attempt.
          const provablyUnsent =
            error instanceof TransportSettlementError && !outcomeUnknown;
          const marked = await markAttemptFailed(
            entry.id,
            reason,
            now,
            provablyUnsent ? 'pending' : 'submitting',
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
      await settleConfirmed(entry.id, now, result);
    }
    return result;
  } finally {
    draining = false;
  }
}

/**
 * Operator acknowledgement of a permanently failed entry: it has been
 * reconciled off-queue, so it may be pruned and — only from here on — evicted
 * to make room.
 *
 * Returns `null` unless the entry exists and is `failed`. Nothing else can be
 * acknowledged: an outstanding entry is still owed, and a settled one has
 * nothing to reconcile.
 */
export async function acknowledgeFailed(
  id: string,
  now: number,
): Promise<SettlementEntry | null> {
  return withQueue(async ({entries}) => {
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1 || entries[idx].status !== 'failed') {
      return null;
    }
    const next: SettlementEntry = {...entries[idx], acknowledgedAt: now};
    entries[idx] = next;
    await writeQueue(entries);
    return next;
  });
}

/**
 * Forget failures an operator has acknowledged. Unacknowledged ones stay: they
 * are the merchant's only record of money that did not arrive.
 */
export async function pruneFailed(): Promise<number> {
  return withQueue(async ({entries}) => {
    const keep = entries.filter(e => !isRetiredFailure(e));
    await writeQueue(keep);
    return entries.length - keep.length;
  });
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
