/**
 * A local count and log of the charges a card was refused offline (ENG-701):
 * `CHANGE_NEEDS_MINT` (the bill needs change and the mint is out of reach)
 * and `ONLINE_ONLY` (a planned piece cannot be checked offline). How often
 * these happen is what decides whether cards need reshaping, so the
 * operator can find it in Settings.
 *
 * Each entry is the bill and the card's piece sizes, and nothing else: no
 * slot, nonce, C, secret, keyset or key. So AsyncStorage, not the Keychain.
 * The log keeps the last `REFUSAL_LOG_CAP` entries, with no expiry; the
 * counts are kept beside it and never go down when the log is trimmed. One
 * entry per refused tap: a bill retried and refused again is logged again,
 * and its amount lets the retries be grouped later.
 *
 * Writes run one at a time (a module-level promise chain), so two refusals
 * recorded together both land. A stored value that does not parse is reset
 * rather than allowed to throw.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REFUSAL_LOG_KEY = '@refusal_log';

/** The most entries kept; the counts keep going past it. */
export const REFUSAL_LOG_CAP = 200;

export type RefusalKind = 'change_needs_mint' | 'online_only';

export const REFUSAL_KINDS: readonly RefusalKind[] = [
  'change_needs_mint',
  'online_only',
];

export interface RefusalEntry {
  kind: RefusalKind;
  /** The bill, in sats. */
  amountSat: number;
  /** The card's unspent piece sizes, as the read listed them. */
  cardPieces: number[];
  /** When, ms since the epoch. */
  at: number;
}

export type RefusalCounts = Record<RefusalKind, number>;

interface Stored {
  v: 1;
  counts: RefusalCounts;
  entries: RefusalEntry[];
}

const empty = (): Stored => ({
  v: 1,
  counts: {change_needs_mint: 0, online_only: 0},
  entries: [],
});

const isKind = (k: unknown): k is RefusalKind =>
  REFUSAL_KINDS.includes(k as RefusalKind);

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

const isEntry = (e: unknown): e is RefusalEntry => {
  const x = e as RefusalEntry;
  return (
    !!x &&
    typeof x === 'object' &&
    isKind(x.kind) &&
    isCount(x.amountSat) &&
    Array.isArray(x.cardPieces) &&
    x.cardPieces.every(isCount) &&
    typeof x.at === 'number'
  );
};

/** The stored log, or an empty one when it is missing or does not parse. */
async function load(): Promise<Stored> {
  const raw = await AsyncStorage.getItem(REFUSAL_LOG_KEY);
  if (!raw) {
    return empty();
  }
  try {
    const parsed = JSON.parse(raw) as Stored;
    if (
      !parsed ||
      parsed.v !== 1 ||
      !parsed.counts ||
      !REFUSAL_KINDS.every(k => isCount(parsed.counts[k])) ||
      !Array.isArray(parsed.entries)
    ) {
      return empty();
    }
    return {
      v: 1,
      counts: {
        change_needs_mint: parsed.counts.change_needs_mint,
        online_only: parsed.counts.online_only,
      },
      entries: parsed.entries.filter(isEntry),
    };
  } catch {
    return empty();
  }
}

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every write queued before it, whatever they did. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * Count and log one refused charge. Only the kind, the bill and the piece
 * sizes are kept.
 */
export function recordRefusal(
  kind: RefusalKind,
  amountSat: number,
  cardPieces: readonly number[],
  now: number = Date.now(),
): Promise<void> {
  const entry: RefusalEntry = {
    kind,
    amountSat,
    cardPieces: cardPieces.map(Number),
    at: now,
  };
  return serial(async () => {
    const stored = await load();
    stored.counts[kind] += 1;
    stored.entries = [...stored.entries, entry].slice(-REFUSAL_LOG_CAP);
    await AsyncStorage.setItem(REFUSAL_LOG_KEY, JSON.stringify(stored));
  });
}

/** How many refusals of each kind this terminal has logged, ever. */
export function getRefusalCounts(): Promise<RefusalCounts> {
  return serial(async () => (await load()).counts);
}

/** The logged refusals, newest first (at most `REFUSAL_LOG_CAP`). */
export function getRefusalLog(): Promise<RefusalEntry[]> {
  return serial(async () => [...(await load()).entries].reverse());
}
