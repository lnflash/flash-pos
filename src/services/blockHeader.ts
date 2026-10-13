/**
 * The Bitcoin block header a till shows a card before a payment (protocol
 * 2.0's SET_HEADER): the card's clock is the time in the newest header it
 * has taken, and its daily limit and no-PIN allowance run on that clock.
 *
 * Source (architect's decision 7): an Esplora API — mempool.space first,
 * blockstream.info as the fallback — `GET <api>/blocks/tip/hash`, then
 * `GET <api>/block/<hash>/header`. A dev build can point it elsewhere
 * (`setHeaderApisOverride`, set by the card-bridge deep link's `headers=`)
 * so the e2e run stubs it; a release build always uses the defaults. When
 * every source fails the card is sent no header and keeps its clock.
 *
 * Never fetched inside an NFC session: `refreshTipHeader` runs before the
 * tap (screen mount, the payment router) and the charge reads the cached tip
 * with `cachedTipHeader`, which is fresh for 10 minutes.
 *
 * Nothing here is trusted by the card: it checks the header's proof of work
 * against its own floor. A header that does not hash to the hash the API
 * named is dropped here all the same, so a broken source is not cached.
 */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';

/** The default sources, in order (decision 7). */
export const DEFAULT_HEADER_APIS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
];

/** How long a fetched tip is used before it is fetched again. */
export const TIP_TTL_MS = 10 * 60 * 1000;

/** Per request: a source that does not answer in this long is skipped. */
export const HEADER_FETCH_TIMEOUT_MS = 4000;

let override: string[] | null = null;

/**
 * Dev builds: take the tip from `apis` instead of the defaults (the e2e run's
 * stub), or back to the defaults with null. Ignored outside `__DEV__`. Drops
 * the cached tip, which came from the other source.
 */
export function setHeaderApisOverride(apis: string[] | null): void {
  if (!__DEV__) {
    return;
  }
  const list = (apis ?? [])
    .map(a => a.trim().replace(/\/+$/, ''))
    .filter(a => /^https?:\/\/[^\s/]+/i.test(a));
  override = list.length > 0 ? list : null;
  cache = null;
}

/** The sources a fetch tries, in order: the dev override, else the defaults. */
export function headerApis(): string[] {
  return override ?? DEFAULT_HEADER_APIS;
}

/** The block hash of a header, as Bitcoin shows it (double SHA-256, reversed). */
export function blockHash(header: number[] | Uint8Array): string {
  return bytesToHex(
    Uint8Array.from(sha256(sha256(Uint8Array.from(header)))).reverse(),
  );
}

type FetchFn = (
  url: string,
  init?: {signal?: AbortSignal},
) => Promise<{ok: boolean; status: number; text: () => Promise<string>}>;

async function getText(
  fetchFn: FetchFn,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchFn(
      url,
      controller ? {signal: controller.signal} : {},
    );
    if (!res.ok) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    return (await res.text()).trim();
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * The tip header from the first source that answers with a header that
 * hashes to the hash it named. `null` when none does.
 */
export async function fetchTipHeader({
  apis = headerApis(),
  fetchFn = fetch as unknown as FetchFn,
  timeoutMs = HEADER_FETCH_TIMEOUT_MS,
}: {
  apis?: string[];
  fetchFn?: FetchFn;
  timeoutMs?: number;
} = {}): Promise<number[] | null> {
  for (const api of apis) {
    try {
      const hash = (
        await getText(fetchFn, `${api}/blocks/tip/hash`, timeoutMs)
      ).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        continue;
      }
      const hex = (
        await getText(fetchFn, `${api}/block/${hash}/header`, timeoutMs)
      ).toLowerCase();
      if (!/^[0-9a-f]{160}$/.test(hex)) {
        continue;
      }
      const header = Array.from(hexToBytes(hex));
      if (blockHash(header) !== hash) {
        continue;
      }
      return header;
    } catch {
      // The next source.
    }
  }
  return null;
}

let cache: {header: number[]; fetchedAt: number} | null = null;
let inFlight: Promise<number[] | null> | null = null;

/** The cached tip when it is younger than `TIP_TTL_MS`, else null. Never fetches. */
export function cachedTipHeader(now: number = Date.now()): number[] | null {
  if (!cache || now - cache.fetchedAt >= TIP_TTL_MS || now < cache.fetchedAt) {
    return null;
  }
  return cache.header;
}

/**
 * The tip, fetched only when the cached one is stale. Single-flight, and
 * never rejects: a till that cannot reach any source answers null, and the
 * charge sends no header.
 */
export async function refreshTipHeader(
  options: Parameters<typeof fetchTipHeader>[0] & {now?: () => number} = {},
): Promise<number[] | null> {
  const clock = options.now ?? Date.now;
  const fresh = cachedTipHeader(clock());
  if (fresh) {
    return fresh;
  }
  if (!inFlight) {
    inFlight = fetchTipHeader(options)
      .then(header => {
        if (header) {
          cache = {header, fetchedAt: clock()};
        }
        return header;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Test seam: forget the cached tip and any override. */
export function __resetTipHeader(): void {
  cache = null;
  inFlight = null;
  override = null;
}
