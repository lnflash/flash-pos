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
  dleq?: unknown;
}

export interface SettlementAdapter {
  swap: (entry: SettlementEntry) => Promise<void>;
  checkState: (entry: SettlementEntry) => Promise<'spent' | 'unspent' | 'unknown'>;
}

export function createSettlementAdapter(): SettlementAdapter {
  // drainQueue does not filter entries by mint — it hands every pending entry
  // to swap — so the adapter must settle each proof against the mint that
  // issued it (SettlementEntry.mintUrl), not against whatever the terminal is
  // currently configured with. Wallets are cached per mint, but ONLY while
  // healthy: a failed loadMint (a mint rate-limiting a burst of setup calls is
  // the routine case) evicts the promise, or the rejection is cached forever
  // and every drain fails identically without ever reaching the network —
  // which reads to the merchant as an entry that retries but never settles.
  const wallets = new Map<string, Promise<Wallet>>();
  const getWallet = (mintUrl: string): Promise<Wallet> => {
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
  };

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
      const {keep} = await wallet.completeSwap(preview);
      settled = keep.map(p => ({
        id: p.id,
        amount: Number(p.amount),
        secret: p.secret,
        C: p.C,
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
