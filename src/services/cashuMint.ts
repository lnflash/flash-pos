/**
 * The mint side of card settlement, on @cashu/cashu-ts.
 *
 * `drainQueue` (see cashuSettlement.ts) owns the state machine; this module
 * owns the network call it delegates to. The two touch only through the
 * contract `drainQueue` documents, which this module must honour exactly:
 *
 *   swap(entry)    resolves once the mint holds the proof. Anything thrown
 *                  after the mint accepted the request reads as "outcome
 *                  unknown" and is how a lost post-swap write is survived —
 *                  so this function persists the merchant's proofs *before*
 *                  resolving, and never resolves with money unrecorded.
 *   checkState     answers NUT-07 for an entry whose earlier attempt is
 *                  genuinely ambiguous ('submitting' on disk).
 *
 * Error mapping — the queue branches on these classes, and the branches are
 * the difference between money received and money written off:
 *
 *   mint operation error, code 11001  → ProofAlreadySpentError   (only ever
 *     raised for the mint's own "token already spent": the mint has
 *     identified this exact proof. Nothing else qualifies.)
 *   other mint operation error / 4xx  → PermanentSettlementError (a definitive
 *     rejection; retrying is pointless)
 *   5xx, 429, timeout, aborted read   → rethrown as-is           (the request
 *     may have landed; the queue keeps the entry 'submitting')
 *   connection never established      → TransportSettlementError (provably
 *     unsent; the only class allowed to revert an entry to 'pending')
 *
 * The merchant's settled proofs are bearer ecash held in secure storage. A
 * later step can sweep them to the flash backend; nothing here assumes one.
 */
import {
  isMintOperationError,
  isP2PKSpendAuthorised,
  OutputData,
  serializeSwapPreview,
  Wallet,
  type Proof,
  type ProofLike,
} from '@cashu/cashu-ts';

import {
  PermanentSettlementError,
  ProofAlreadySpentError,
  TransportSettlementError,
  toCashuProof,
  type SettlementEntry,
} from './cashuSettlement';
import {getSecureStrict, removeSecure, setSecure} from './secureStorage';

/** NUT-XX: the mint holds this exact proof already. */
const TOKEN_ALREADY_SPENT = 11001;

const SETTLED_PROOFS_KEY = '@cashu_settled_proofs';
const pendingKey = (id: string) => `@cashu_settlement_swap:${id}`;

/**
 * The NUT-10 secret for a card-loaded proof, rebuilt from the two values the
 * card does report.
 *
 * Byte-exactness is the whole function: the mint hashed this string at mint
 * time (`hashToCurve(utf8(secret))`), and a reconstruction that differs by a
 * space or a key order is a different secret — a proof the mint will reject
 * as unknown *after* the card has burned its slot. This must stay identical
 * to `buildP2PKSecret` in cashu-client (the loader's serialization) and is
 * pinned by a fixture test against a proof minted by the real toolchain.
 */
export function buildCardP2PKSecret(nonce: string, cardPubkey: string): string {
  return JSON.stringify([
    'P2PK',
    {
      nonce: nonce.toLowerCase(),
      data: cardPubkey.toLowerCase(),
      tags: [['sigflag', 'SIG_INPUTS']],
    },
  ]);
}

/** Bearer ecash the merchant holds once a settlement confirms. */
export interface SettledProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  /** The mint that signed this proof. Set by the adapter; entries written
   *  before this field existed fall back to the terminal's configured mint. */
  mintUrl?: string;
  dleq?: unknown;
}

export interface SettlementAdapter {
  swap: (entry: SettlementEntry) => Promise<void>;
  checkState: (entry: SettlementEntry) => Promise<'spent' | 'unspent' | 'unknown'>;
}

// One wallet per mint, shared by the settlement adapter and the payout melt.
// Cached ONLY while healthy: a failed loadMint (a mint rate-limiting a burst
// of setup calls is the routine case) evicts the promise, or the rejection is
// cached forever and every later call fails identically without ever reaching
// the network — which reads to the merchant as an entry that retries but
// never settles.
const wallets = new Map<string, Promise<Wallet>>();
function getWallet(mintUrl: string): Promise<Wallet> {
  let wallet = wallets.get(mintUrl);
  if (!wallet) {
    wallet = (async () => {
      const w = new Wallet(mintUrl);
      await w.loadMint();
      return w;
    })();
    wallets.set(mintUrl, wallet);
    wallet.catch(() => {
      // Only evict if this attempt is still the cached one.
      if (wallets.get(mintUrl) === wallet) {
        wallets.delete(mintUrl);
      }
    });
  }
  return wallet;
}

/** Test seam: drop cached mint wallets. Mirrors cashuSettlement.__resetDrainState. */
export function __resetWalletCache(): void {
  wallets.clear();
}

export function createSettlementAdapter(): SettlementAdapter {
  // drainQueue does not filter entries by mint — it hands every pending entry
  // to swap — so the adapter must settle each proof against the mint that
  // issued it (SettlementEntry.mintUrl), not against whatever the terminal is
  // currently configured with.
  const swap = async (entry: SettlementEntry): Promise<void> => {
    const wallet = await getWallet(entry.mintUrl);

    // The queue rebuilt this from the entry alone; cashu-ts accepts the
    // witness envelope as a string and normalizes it onto the mint payload.
    const queueProof = toCashuProof(entry);
    const proof = {
      id: queueProof.id,
      amount: queueProof.amount,
      secret: queueProof.secret,
      C: queueProof.C,
      witness: queueProof.witness,
    } as ProofLike as Proof;

    // Fail before any network call when the witness does not authorise this
    // spend: the card has already burned the slot, so an ask-the-mint-and-see
    // round trip converts a local mistake into a mint-side rejection.
    if (!isP2PKSpendAuthorised(proof)) {
      throw new PermanentSettlementError(
        `settlement ${entry.id}: the card's witness does not authorise this proof`,
      );
    }

    // Fees come out of the inputs, so the outputs the mint returns can sum to
    // less than the proof. prepareSwapToSend owns that math (NUT-02) and the
    // resulting preview is serializable — persisted here, before the request,
    // because after the mint accepts, the preview's blinding data is the only
    // way to unblind whatever signatures come back (same ordering argument as
    // fund-card's pending file in cashu-client).
    const preview = await wallet.prepareSwapToSend(entry.amount, [proof], {
      includeFees: true,
    });
    await setSecure(
      pendingKey(entry.id),
      JSON.stringify(serializeSwapPreview(preview)),
    );

    let settled: SettledProof[];
    try {
      const {keep, send} = await wallet.completeSwap(preview);
      // The keep/send split is PAYMENT-flow semantics — send is what a payer
      // hands to a recipient. In a settlement the terminal is the recipient
      // of the entire swap: every output the mint signs is merchant money.
      // Persisting only `keep` (empty when the inputs exactly cover the
      // amount, because send shapes the full amount) books a settled payment
      // as nothing — found in the field when the payout step then read an
      // empty store.
      settled = [...keep, ...send].map(p => ({
        id: p.id,
        amount: Number(p.amount),
        secret: p.secret,
        C: p.C,
        mintUrl: entry.mintUrl,
        ...(p.dleq ? {dleq: p.dleq} : {}),
      }));
    } catch (error) {
      throw mapSwapError(error, entry);
    }

    // The mint holds the proof. From here a failure is a persistence problem:
    // rethrowing leaves the pending preview (recoverable blinding data) on
    // disk and the entry ambiguous, which is honest — marking settled without
    // the proofs recorded would book money the app cannot spend.
    await appendSettledProofs(settled);
    await removeSecure(pendingKey(entry.id));
  };

  const checkState = async (
    entry: SettlementEntry,
  ): Promise<'spent' | 'unspent' | 'unknown'> => {
    const wallet = await getWallet(entry.mintUrl);
    const [state] = await wallet.checkProofsStates([
      {id: entry.keysetId, secret: entry.secret},
    ]);
    switch (state.state) {
      case 'SPENT':
        return 'spent';
      case 'UNSPENT':
        return 'unspent';
      default:
        return 'unknown';
    }
  };

  return {swap, checkState};
}

/**
 * Map a cashu-ts failure onto the queue's error classes. Anything not mapped
 * is rethrown unchanged: the queue reads a plain throw as "outcome unknown",
 * which is the conservative default for everything ambiguous.
 */
function mapSwapError(error: unknown, entry: SettlementEntry): unknown {
  if (isMintOperationError(error)) {
    if (error.code === TOKEN_ALREADY_SPENT) {
      return new ProofAlreadySpentError(
        `settlement ${entry.id}: the mint already holds this proof`,
      );
    }
    return new PermanentSettlementError(
      `settlement ${entry.id}: the mint rejected the proof (${error.code}: ${error.message})`,
    );
  }
  if (isHttpResponse(error)) {
    if (error.status >= 500 || error.status === 429) {
      return error;
    }
    return new PermanentSettlementError(
      `settlement ${entry.id}: the mint rejected the swap (HTTP ${error.status})`,
    );
  }
  if (isFetchNetworkError(error)) {
    return new TransportSettlementError(
      `settlement ${entry.id}: the request never reached the network (${String(error)})`,
    );
  }
  return error;
}

function isHttpResponse(error: unknown): error is {status: number; message: string} {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as {status?: unknown}).status === 'number'
  );
}

/**
 * A failure that happened before any socket could carry the request: RN's
 * fetch rejects with a TypeError for offline/DNS/refused. A timeout or an
 * aborted read is NOT here — by then the mint may hold the proof.
 */
function isFetchNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

export async function listSettledProofs(): Promise<SettledProof[]> {
  const raw = await getSecureStrict(SETTLED_PROOFS_KEY);
  if (!raw) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('settled proofs store is not an array');
  }
  return parsed as SettledProof[];
}

async function appendSettledProofs(proofs: SettledProof[]): Promise<void> {
  const existing = await listSettledProofs();
  await setSecure(
    SETTLED_PROOFS_KEY,
    JSON.stringify([...existing, ...proofs]),
  );
}

// ── payout: melt settled proofs to a bolt11 invoice or lightning address ──

const PENDING_PAYOUT_KEY = '@cashu_settled_payout';

/**
 * The bolt11 invoice behind a lightning address, for `amountSat`.
 *
 * A lightning address is an LNURL-pay endpoint: metadata at
 * `https://<domain>/.well-known/lnurlp/<name>` (with `minSendable`/`maxSendable`
 * in msat), then the `callback` URL with `amount=<msat>` returns `{pr: <bolt11>}`.
 * That is the whole protocol — no wallet-specific API anywhere.
 */
export async function resolveLightningAddress(
  address: string,
  amountSat: number,
  /** Override the meta URL: for the logged-in flash account the payRequest
   *  endpoint lives on the flash ln-address service, not under the display
   *  domain of the address. */
  lnurlpUrl?: string,
): Promise<string> {
  const at = address.indexOf('@');
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`not a lightning address: ${address}`);
  }
  const name = address.slice(0, at);
  const domain = address.slice(at + 1);
  const metaUrl = lnurlpUrl
    ? `${lnurlpUrl.replace(/\/$/, '')}/.well-known/lnurlp/${name}`
    : `https://${domain}/.well-known/lnurlp/${name}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(
      `lightning address ${address}: lookup failed (HTTP ${metaRes.status})`,
    );
  }
  const meta = (await metaRes.json()) as {
    tag?: string;
    minSendable?: string | number;
    maxSendable?: string | number;
    callback?: string;
  };
  if (meta.tag !== 'payRequest' || !meta.callback) {
    throw new Error(`lightning address ${address}: not a payRequest endpoint`);
  }
  const minSat = Math.ceil(Number(meta.minSendable ?? 0) / 1000);
  const maxSat = Math.floor(Number(meta.maxSendable ?? Infinity) / 1000);
  if (amountSat < minSat || amountSat > maxSat) {
    throw new Error(
      `lightning address ${address} accepts ${minSat}–${maxSat} sat; ` +
        `the settled balance is ${amountSat} sat`,
    );
  }
  const callback = new URL(meta.callback);
  callback.searchParams.set('amount', String(amountSat * 1000));
  const invRes = await fetch(callback.toString());
  if (!invRes.ok) {
    throw new Error(
      `lightning address ${address}: invoice request failed (HTTP ${invRes.status})`,
    );
  }
  const invoice = (await invRes.json()) as {pr?: string};
  if (!invoice.pr) {
    throw new Error(`lightning address ${address}: no invoice returned`);
  }
  return invoice.pr;
}

export interface PayoutArgs {
  mintUrl: string;
  /** A raw bolt11 invoice. Mutually exclusive with `lightningAddress`. */
  bolt11?: string;
  /** A `user@domain` lightning address; resolved via LNURL-pay at `amountSat`. */
  lightningAddress?: string;
  /** Serve the LNURL metadata from this base instead of the address's domain —
   *  the flash account's payRequest lives on the flash ln-address service. */
  lnurlpUrl?: string;
  now?: number;
}

export interface PayoutResult {
  /** Sats that left for the invoice, and what the mint reserved for routing. */
  paidSat: number;
  feeReserveSat: number;
  preimage: string | null;
  /** Change proofs returned for overpaid reserves, back in the settled store. */
  change: SettledProof[];
}

/**
 * Melt the merchant's settled proofs to a bolt11 invoice — the payout leg of
 * the terminal, mint → Lightning → any wallet.
 *
 * The same non-idempotence argument as the settlement swap applies, with the
 * roles reversed: the melt intent (quote + exact proofs) is persisted BEFORE
 * the call, because after the mint pays the invoice, those proofs are spent
 * whatever happens to the response. On success the melted proofs leave the
 * settled store and any change re-enters it.
 */
export async function meltSettledProofs({
  mintUrl,
  bolt11,
  lightningAddress,
  lnurlpUrl,
  now = Date.now(),
}: PayoutArgs): Promise<PayoutResult> {
  if (Boolean(bolt11) === Boolean(lightningAddress)) {
    throw new Error('payout needs exactly one of bolt11 or lightningAddress');
  }
  const proofs = await listSettledProofs();
  if (proofs.length === 0) {
    throw new Error('no settled proofs to pay out');
  }
  const mints = new Set(proofs.map(p => p.mintUrl ?? mintUrl));
  if (mints.size > 1) {
    throw new Error(
      'settled proofs span multiple mints; pay out per mint (not yet supported)',
    );
  }
  const wallet = await getWallet(mintUrl);
  const totalSat = proofs.reduce((t, p) => t + p.amount, 0);

  // For a lightning address WE choose the amount, so a fee reserve that
  // would overrun the balance is answered by asking for a smaller invoice —
  // the reserve is only knowable after a quote, hence the loop.
  let attemptSat = totalSat;
  let quote: Awaited<ReturnType<typeof wallet.createMeltQuoteBolt11>> | null =
    null;
  for (let tries = 0; tries < 3; tries++) {
    const request =
      bolt11 ??
      (await resolveLightningAddress(lightningAddress!, attemptSat, lnurlpUrl));
    quote = await wallet.createMeltQuoteBolt11(request);
    const needed =
      Number(quote.amount) + Number(quote.fee_reserve);
    if (needed <= totalSat || bolt11) {
      if (needed > totalSat) {
        throw new Error(
          `the invoice needs ${needed} sat (amount + ${Number(
            quote.fee_reserve,
          )} fee reserve) but the settled balance is ${totalSat} sat — ` +
            'use a smaller invoice',
        );
      }
      break;
    }
    if (lightningAddress && needed <= totalSat + Number(quote.fee_reserve)) {
      // The reserve alone overruns: ask the address for
      // `total − reserve` next round, so amount + reserve fits exactly.
      attemptSat = totalSat - Number(quote.fee_reserve);
      continue;
    }
    attemptSat = Math.floor(attemptSat / 2);
  }
  if (!quote) {
    throw new Error('payout: no melt quote');
  }

  const needed =
    Number(quote.amount) + Number(quote.fee_reserve);
  if (needed > totalSat) {
    throw new Error(
      `payout needs ${needed} sat but the settled balance is ${totalSat} sat`,
    );
  }

  // Persist the melt intent before the network call: if the app dies after
  // the mint pays, these secrets + quote are the reconciliation record.
  await setSecure(
    PENDING_PAYOUT_KEY,
    JSON.stringify({quoteId: quote.quote, bolt11, lightningAddress, secrets: proofs.map(p => p.secret), at: now}),
  );

  let response: Awaited<ReturnType<typeof wallet.meltProofsBolt11>>;
  try {
    const result = await wallet.meltProofsBolt11(
      quote,
      proofs as ProofLike[],
    );
    if (result.quote.state !== 'PAID') {
      throw new Error(
        `payout quote ${quote.quote} did not settle: ${result.quote.state}`,
      );
    }
    response = result;
  } catch (error) {
    // Leave the pending record in place — if the mint paid despite an
    // ambiguous failure, the quote is the recovery path (re-check the quote
    // state before re-spending these proofs).
    throw error instanceof Error ? error : new Error(String(error));
  }

  const change: SettledProof[] = response.change.map(p => ({
    id: p.id,
    amount: Number(p.amount),
    secret: p.secret,
    C: p.C,
    mintUrl,
  }));
  // Only now does the money have a new home: drop the melted proofs, keep
  // any change.
  const meltedSecrets = new Set(proofs.map(p => p.secret));
  const remaining = (await listSettledProofs()).filter(
    p => !meltedSecrets.has(p.secret),
  );
  await setSecure(SETTLED_PROOFS_KEY, JSON.stringify([...remaining, ...change]));
  await removeSecure(PENDING_PAYOUT_KEY);

  return {
    paidSat: Number(quote.amount),
    feeReserveSat: Number(quote.fee_reserve),
    preimage: response.quote.payment_preimage ?? null,
    change,
  };
}

// ── the till: change-making and float maintenance ──────────────────────────

/**
 * Select settled proofs summing EXACTLY to `changeSat`, smallest first.
 * Returns [] for 0, null when the till cannot make exact change.
 *
 * Exactness matters: the till proofs are bearer money — overpaying change
 * would give the customer more than they are owed, and underpaying steals
 * from them.
 */
export function selectChangeFromTill(
  proofs: SettledProof[],
  changeSat: number,
): SettledProof[] | null {
  if (changeSat === 0) {return [];}
  // Small first — spend small denominations before breaking big ones.
  const sorted = [...proofs].sort((a, b) => a.amount - b.amount);
  let remaining = changeSat;
  const chosen: SettledProof[] = [];
  for (const p of sorted) {
    if (p.amount <= remaining) {
      chosen.push(p);
      remaining -= p.amount;
    }
  }
  return remaining === 0 ? chosen : null;
}

/**
 * Break the till's largest proof into smaller denominations so change can be
 * made later. A self-swap: the till proofs are the merchant's own unlocked
 * bearer proofs, so no witness and no external invoice — just a NUT-03 swap
 * with chosen outputs. One proof per call; the auto-pipeline runs this while
 * ONLINE so purchases never need the network for change.
 */
export async function rebalanceTill(
  mintUrl: string,
  needSat?: number,
): Promise<number> {
  const proofs = await listSettledProofs();
  if (proofs.length === 0) {return 0;}
  const sortedDesc = [...proofs].sort((a, b) => b.amount - a.amount);
  let target = sortedDesc[0];
  let swapAmount = Math.floor(target.amount / 2);
  if (needSat && needSat > 0) {
    // Break the SMALLEST proof that covers the need — preserves bigger
    // denominations. No single proof covers it: the purchase plan already
    // reported that, so this call is a no-op.
    const sufficient = [...proofs].sort((a, b) => a.amount - b.amount).find(
      p => p.amount >= needSat,
    );
    if (!sufficient) {
      return 0;
    }
    target = sufficient;
    swapAmount = needSat;
  } else if (target.amount < 2) {
    return 0;
  }
  const wallet = await getWallet(mintUrl);
  // Send the needed amount; completeSwap returns the rest as `keep`. The
  // keep/send union is the whole reborn proof set (see the settlement comment).
  const preview = await withRateLimitRetry(() =>
    wallet.prepareSwapToSend(swapAmount, [
      {id: target.id, amount: target.amount, secret: target.secret, C: target.C},
    ]),
  );
  const {keep, send} = await withRateLimitRetry(() =>
    wallet.completeSwap(preview),
  );
  const reborn = [...keep, ...send].map(p => ({
    id: p.id,
    amount: Number(p.amount),
    secret: p.secret,
    C: p.C,
    mintUrl,
  }));
  const swappedSecret = new Set([target.secret]);
  const remaining = (await listSettledProofs()).filter(
    p => !swappedSecret.has(p.secret),
  );
  await setSecure(SETTLED_PROOFS_KEY, JSON.stringify([...remaining, ...reborn]));
  return reborn.length;
}

/**
 * Drop till listings the mint no longer honours. The store can drift from
 * mint reality when a melt/swap consumes a proof but the response (and its
 * store update) is lost — every later sweep/payout then fails 11001. The
 * mint's own checkstate is the arbiter: a spent listing is worthless
 * bookkeeping and leaves.
 */
export async function reconcileTill(mintUrl: string): Promise<number> {
  const proofs = await listSettledProofs();
  if (proofs.length === 0) {return 0;}
  try {
    const wallet = await getWallet(mintUrl);
    const states = await wallet.checkProofsStates(
      proofs as unknown as Proof[],
    );
    const spent = new Set(
      proofs.filter((_, i) => states[i]?.state === 'SPENT').map(p => p.secret),
    );
    if (spent.size === 0) {return 0;}
    const remaining = proofs.filter(p => !spent.has(p.secret));
    await setSecure(SETTLED_PROOFS_KEY, JSON.stringify(remaining));
    return spent.size;
  } catch {
    // A failed reconcile keeps the last known state — never flip to
    // all-clear on a network error.
    return 0;
  }
}

/**
 * Sweep everything except the change float to the account address.
 *
 * `keepReserveSat` is the till float: small-denomination proofs the terminal
 * holds back so offline purchases can make change. Greedy from the largest
 * proof, so the smallest denominations survive in the till.
 */
export async function sweepSettledProofs(opts: {
  mintUrl: string;
  bolt11?: string;
  lightningAddress?: string;
  lnurlpUrl?: string;
  keepReserveSat?: number;
  now?: number;
}): Promise<PayoutResult> {
  const {keepReserveSat = 0, mintUrl} = opts;
  // Reconcile first: a till listing the mint already spent (consumed by an
  // earlier melt/swap whose store update was lost) would fail every payout
  // with 11001 forever. Drop spent listings, then sweep the survivors.
  await reconcileTill(mintUrl);
  const proofs = await listSettledProofs();
  const total = proofs.reduce((t, p) => t + p.amount, 0);
  if (total <= keepReserveSat) {
    return {paidSat: 0, feeReserveSat: 0, preimage: null, change: []};
  }
  // Largest-first melt selection, stopping so the remaining proofs still
  // cover the reserve. Melted proofs leave the store inside
  // meltSettledProofs; the survivors are the float.
  const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
  const meltTarget = total - keepReserveSat;
  let acc = 0;
  const meltSet = new Set<string>();
  for (const p of sorted) {
    if (acc >= meltTarget) {break;}
    meltSet.add(p.secret);
    acc += p.amount;
  }
  const survivors = proofs.filter(p => !meltSet.has(p.secret));
  const result = await meltSettledProofs({...opts});
  // meltSettledProofs melted the WHOLE store; re-stage the survivors by
  // writing them back over whatever the melt left (its change).
  const current = await listSettledProofs();
  await setSecure(
    SETTLED_PROOFS_KEY,
    JSON.stringify([...current.filter(c => !survivors.some(s => s.secret === c.secret)), ...survivors]),
  );
  return result;
}

// ── change minting: till proofs → P2PK proofs for the customer's card ──────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Forge rate-limits bursts, and a charge is a burst: settle + rebalance +
 * change-swap inside one session. One retry after the mint's own
 * retryAfterMs (or 2.5s) clears the routine throttle.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const retryable =
      isMintOperationError(error) ||
      (error instanceof Error && /rate limit/i.test(error.message));
    if (!retryable) {throw error;}
    const wait =
      (error as {retryAfterMs?: number}).retryAfterMs ?? 2500;
    await sleep(wait);
    return fn();
  }
}

/** Greedy power-of-two decomposition (4 → [4]; 6 → [4,2]; 7 → [4,2,1]). */
function splitPow2(amountSat: number): number[] {
  const pieces: number[] = [];
  let remaining = amountSat;
  let denom = 1;
  while (denom * 2 <= remaining) {denom *= 2;}
  while (remaining > 0) {
    if (denom <= remaining) {
      pieces.push(denom);
      remaining -= denom;
    } else {
      denom = Math.floor(denom / 2);
    }
  }
  return pieces;
}

/**
 * Mint `changeSat` of change from the till, P2PK-locked to `p2pkPubkey` —
 * the customer's card key — so the proofs can be written straight onto their
 * card and spent by it later.
 *
 * The change is NEW mint-signed value: the till proofs are consumed as swap
 * inputs and the outputs are blinded with OUR canonical P2PK secrets
 * (buildCardP2PKSecret-shape — cashu-ts's serializer is byte-identical, so
 * the host's spend-time reconstruction reads them back exactly). When the
 * till cannot make the change exactly, one ONLINE rebalance is attempted
 * first; offline the function reports the shortfall and nothing moves.
 */
export async function makeChangeOnTill({
  mintUrl,
  changeSat,
  p2pkPubkey,
}: {
  mintUrl: string;
  changeSat: number;
  p2pkPubkey: string;
}): Promise<
  | {ok: true; change: SettledProof[]}
  | {ok: false; reason: string}
> {
  if (changeSat <= 0) {return {ok: true, change: []};}

  let proofs = await listSettledProofs();
  let chosen = selectChangeFromTill(proofs, changeSat);
  if (chosen === null) {
    // ONLINE recovery: reshape the till, then select once more.
    try {
      await rebalanceTill(mintUrl, changeSat);
      proofs = await listSettledProofs();
      chosen = selectChangeFromTill(proofs, changeSat);
    } catch {
      // Offline: fall through to the refusal.
    }
  }
  if (chosen === null) {
    const total = proofs.reduce((t, p) => t + p.amount, 0);
    return {
      ok: false,
      reason: `the till cannot make ${changeSat} sat exact change (holds ${total} sat)`,
    };
  }

  let chosenFinal = chosen;
  const keysetId = chosenFinal[0].id;
  const wallet = await getWallet(mintUrl);
  const keyset = await wallet.getKeyset(keysetId);

  // Outputs: the change as P2PK pieces locked to the customer's card.
  const pieces = splitPow2(changeSat);
  const outputData = pieces.map(a =>
    OutputData.createSingleP2PKData(
      {pubkey: p2pkPubkey, sigFlag: 'SIG_INPUTS'},
      a,
      keysetId,
    ),
  );

  // A till listing can drift from mint reality: an earlier swap may have
  // consumed a proof the store still holds. The mint says so with 11001 —
  // reconcile (checkstate every input, drop the spent listings) and retry
  // once, so one stale listing cannot block change-making.
  let swapResponse;
  try {
    swapResponse = await wallet.mint.swap({
      inputs: chosen as unknown as Proof[],
      outputs: outputData.map(od => od.blindedMessage),
    });
  } catch (error) {
    if (!isMintOperationError(error) || error.code !== TOKEN_ALREADY_SPENT) {
      throw error;
    }
    const states = await wallet.checkProofsStates(chosen as unknown as Proof[]);
    const spent = new Set(
      chosen
        .filter((_, i) => states[i]?.state === 'SPENT')
        .map(p => p.secret),
    );
    if (spent.size === 0) {throw error;}
    const remaining = (await listSettledProofs()).filter(
      p => !spent.has(p.secret),
    );
    await setSecure(SETTLED_PROOFS_KEY, JSON.stringify(remaining));
    const reChosen = selectChangeFromTill(remaining, changeSat);
    if (reChosen === null) {
      throw error;
    }
    swapResponse = await wallet.mint.swap({
      inputs: reChosen as unknown as Proof[],
      outputs: outputData.map(od => od.blindedMessage),
    });
    chosenFinal = reChosen;
  }

  const change = swapResponse.signatures.map((sig, i) => {
    const proof = outputData[i].toProof(
      sig,
      {...keyset.keys} as Parameters<OutputData['toProof']>[1],
    );
    return {
      id: proof.id,
      amount: Number(proof.amount),
      secret: proof.secret,
      C: proof.C,
      mintUrl,
    };
  });

  // Commit: the consumed till proofs leave the store.
  const consumed = new Set(chosenFinal.map(p => p.secret));
  const remaining = (await listSettledProofs()).filter(
    p => !consumed.has(p.secret),
  );
  await setSecure(SETTLED_PROOFS_KEY, JSON.stringify(remaining));
  return {ok: true, change};
}
