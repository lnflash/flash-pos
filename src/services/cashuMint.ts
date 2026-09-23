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
): Promise<string> {
  const at = address.indexOf('@');
  if (at <= 0 || at === address.length - 1) {
    throw new Error(`not a lightning address: ${address}`);
  }
  const name = address.slice(0, at);
  const domain = address.slice(at + 1);
  const metaUrl = `https://${domain}/.well-known/lnurlp/${name}`;
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
      bolt11 ?? (await resolveLightningAddress(lightningAddress!, attemptSat));
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
