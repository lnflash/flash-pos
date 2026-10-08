/**
 * Wall-clock timing for every APDU the terminal sends to a Cashu card.
 *
 * The card's Schnorr signature is the cost of a tap — one SPEND_PROOF is an
 * order of magnitude slower than any read — and nothing here measured it
 * until now. `cashuCard.send` records one sample per APDU around the
 * transceive call, so the figure is the NFC round trip the phone sees, not
 * the applet's own work. `withCardSession` resets the collector when the
 * session arms and logs a per-command summary when it closes.
 *
 * Compare like with like: a contact reader, a PC/SC RF reader and CoreNFC
 * all give different numbers for the same card. Quote the median.
 */

export interface ApduSample {
  /** Command name as `cashuCard` labels it: SELECT, GET_INFO, SPEND_PROOF … */
  context: string;
  /** Round-trip milliseconds, transceive call to resolved response. */
  ms: number;
}

let samples: ApduSample[] = [];

/** Monotonic where available (Hermes, Node); Date.now otherwise. */
export function nowMs(): number {
  const perf = (globalThis as {performance?: {now?: () => number}}).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

export function recordApdu(context: string, ms: number): void {
  samples.push({context, ms});
}

export function resetApduTimings(): void {
  samples = [];
}

export function getApduTimings(): readonly ApduSample[] {
  return samples;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One line per session, e.g.
 * `SELECT 1× 61ms · GET_INFO 1× 58ms · SPEND_PROOF 3× med 790ms (771–812) · 9 APDUs, 3102ms on the wire`
 *
 * Median rather than mean: one retried or torn APDU must not drag the
 * figure for every other SPEND_PROOF with it.
 */
export function summarizeApduTimings(
  rows: readonly ApduSample[] = samples,
): string {
  if (rows.length === 0) {
    return 'no APDUs sent';
  }
  const byContext = new Map<string, number[]>();
  for (const {context, ms} of rows) {
    const bucket = byContext.get(context);
    if (bucket) {
      bucket.push(ms);
    } else {
      byContext.set(context, [ms]);
    }
  }
  const parts: string[] = [];
  for (const [context, xs] of byContext) {
    if (xs.length === 1) {
      parts.push(`${context} 1× ${Math.round(xs[0])}ms`);
    } else {
      parts.push(
        `${context} ${xs.length}× med ${Math.round(median(xs))}ms ` +
          `(${Math.round(Math.min(...xs))}–${Math.round(Math.max(...xs))})`,
      );
    }
  }
  const total = rows.reduce((sum, {ms}) => sum + ms, 0);
  parts.push(`${rows.length} APDUs, ${Math.round(total)}ms on the wire`);
  return parts.join(' · ');
}
