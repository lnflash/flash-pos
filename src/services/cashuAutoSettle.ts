/**
 * The automatic leg of card settlement: whenever the app reaches the
 * foreground or a tap completes, drain the queue and sweep everything settled
 * to the logged-in account's lightning address.
 *
 * Offline is NOT an error state here, by design. The queue holds unsettled
 * entries (reverting provably-unsent attempts to `pending`), and a sweep
 * attempt against a dead network fails into the same store it started from —
 * nothing is lost, nothing is double-spent. What the merchant must never be
 * is *uninformed*: `cashuOutstanding` is what the pending-settlement banner
 * renders, loudly, until the network returns and a run clears it.
 *
 * Runs are single-flight: a foreground event, a completed tap, and a manual
 * retry can all land in the same tick, and concurrent drains would only
 * fight over the queue's single-writer lock.
 */
import {
  listSettledProofs,
  sweepSettledProofs,
} from './cashuMint';
import {settlePending} from './cashuSpend';
import {pendingExposure} from './cashuSettlement';
import {FLASH_CASHU_MINT_URL, FLASH_LN_ADDRESS, FLASH_LN_ADDRESS_URL} from '@env';

export interface AutoSettleResult {
  /** False when a run was already in flight and this call joined it. */
  ran: boolean;
  settled: number;
  stillPending: number;
  /** Sats swept to the account address; null when the sweep did not run. */
  paidSat: number | null;
  payoutError?: string;
  skippedPayout?: string;
}

let inFlight: Promise<AutoSettleResult> | null = null;

export function autoSettleInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Drain, then sweep. `username` is the logged-in account — its address
 * `<username>@<FLASH_LN_ADDRESS>` is resolved through the flash ln-address
 * service, so the payout lands in the merchant's own wallet.
 */
export async function runAutoSettlement(
  username: string | undefined,
): Promise<AutoSettleResult> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = (async (): Promise<AutoSettleResult> => {
    const drain = await settlePending(Date.now());

    const settled = await listSettledProofs();
    let paidSat: number | null = null;
    let payoutError: string | undefined;
    let skippedPayout: string | undefined;

    if (settled.length === 0) {
      skippedPayout = 'nothing settled to sweep';
    } else if (!username) {
      // Not signed in: the proofs stay in the store and the banner stays up.
      skippedPayout = 'no logged-in account to sweep to';
    } else {
      try {
        const payout = await sweepSettledProofs({
          mintUrl: FLASH_CASHU_MINT_URL,
          lightningAddress: `${username}@${FLASH_LN_ADDRESS}`,
          lnurlpUrl: FLASH_LN_ADDRESS_URL,
          // The till float: small proofs held back so offline purchases can
          // make change without the network. Everything above it sweeps.
          keepReserveSat: 16,
        });
        paidSat = payout.paidSat;
      } catch (error) {
        // The sweep is best-effort on top of a confirmed settlement: the
        // proofs remain in the store and the next run retries the sweep.
        payoutError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      ran: true,
      settled: drain.settled,
      stillPending: drain.stillPending,
      paidSat,
      payoutError,
      skippedPayout,
    };
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export interface CashuOutstanding {
  /** Sats in the settlement queue, not yet swapped at the mint. */
  queueSat: number;
  queueCount: number;
  /** Sats swapped at the mint but not yet swept to the account address. */
  settledSat: number;
}

/**
 * Everything the merchant is owed that has not reached their wallet, split by
 * which leg is holding it. The banner renders this; sums are per-unit `sat`
 * (the queue is multi-unit by design — never total across units).
 */
export async function cashuOutstanding(): Promise<CashuOutstanding> {
  const [exposure, settled] = await Promise.all([
    pendingExposure(),
    listSettledProofs(),
  ]);
  const sat = exposure.totals.sat;
  return {
    queueSat: sat ? sat.amount : 0,
    queueCount: exposure.count,
    settledSat: settled.reduce((t, p) => t + p.amount, 0),
  };
}
