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
  blindMessage,
  HttpResponseError,
  isMintOperationError,
  isP2PKSpendAuthorised,
  pointFromHex,
  schnorrVerifyDigest,
  serializeSwapPreview,
  unblindSignature,
  verifyDLEQProof_reblind,
  verifyDLEQProof,
  Wallet,
  type Proof,
  type ProofLike,
} from '@cashu/cashu-ts';
import {sha256} from '@noble/hashes/sha256';
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils';

import {
  allAttempted,
  PermanentSettlementError,
  ProofAlreadySpentError,
  recordOwedCardChange,
  TransportSettlementError,
  toCashuProof,
  toSigAllInputs,
  type MerchantBlinding,
  type OwedCardChange,
  type SettlementEntry,
  type SettlementInput,
  type SettlementOutput,
} from './cashuSettlement';
import {getSecure, removeSecure, setSecure} from './secureStorage';
import {splitPow2} from '../utils/denominations';
import {readTill, updateTill, recordedPayout} from './cashuTillStore';

/** NUT-XX: the mint holds this exact proof already. */
const TOKEN_ALREADY_SPENT = 11001;

const pendingKey = (id: string) => `@cashu_settlement_swap:${id}`;

/**
 * The NUT-10 secret of a 0.x card proof (SIG_INPUTS), rebuilt from the nonce
 * and the card key. Kept only so a v1 settlement entry written before protocol
 * 2.0 can still be read and drained; nothing new is made in this form.
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

/**
 * The format-4 secret of a 2.0 card piece (cashu-javacard spec/NUT-XX.md),
 * rebuilt from what the card stores — the nonce and the date — and its key
 * and refund key:
 *
 *   ["P2PK",{"nonce":"…","data":"<card key>","tags":[["sigflag","SIG_ALL"]]}]
 *   ["P2PK",{"nonce":"…","data":"<card key>","tags":[["locktime","<date>"],["refund","<key>"],["sigflag","SIG_ALL"]]}]
 *
 * Byte-exactness is the whole function: the card hashes exactly this text
 * into the SIG_ALL message it signs, and the mint hashed it at mint time. A
 * reconstruction that differs by a space, a key order or a hex case is a
 * different secret — a payment the mint refuses AFTER the card burned it.
 * Pinned against the applet's own vectors (spec/vectors/secret.json).
 */
export function buildCardSigAllSecret(
  nonce: string,
  cardPubkey: string,
  date = 0,
  refundKey: string | null = null,
): string {
  const tags: string[][] = [];
  if (date) {
    if (!refundKey) {
      throw new Error("a dated piece names the card's refund key");
    }
    tags.push(['locktime', String(date)], ['refund', refundKey.toLowerCase()]);
  }
  tags.push(['sigflag', 'SIG_ALL']);
  return JSON.stringify([
    'P2PK',
    {nonce: nonce.toLowerCase(), data: cardPubkey.toLowerCase(), tags},
  ]);
}

/**
 * The NUT-11 SIG_ALL message's SHA-256: every input's secret and C (hex),
 * then every output's amount (decimal) and B_ (hex), concatenated as text in
 * the order the card signs them. What the card's one signature is over, and
 * what the terminal verifies that signature (and any SPEND_ALL_AGAIN reply)
 * against before it is used.
 */
export function sigAllMessage(
  inputs: {secret: string; C: string}[],
  outputs: {amount: number; B_: string}[],
): Uint8Array {
  let text = '';
  for (const input of inputs) {
    text += input.secret + input.C.toLowerCase();
  }
  for (const output of outputs) {
    text += String(output.amount) + output.B_.toLowerCase();
  }
  return sha256(utf8ToBytes(text));
}

/** True when `signature` (hex) is the card's over `message` (32 bytes or hex). */
export function verifyCardSignature(
  signature: string,
  message: Uint8Array | string,
  cardPubkey: string,
): boolean {
  try {
    return schnorrVerifyDigest(
      signature,
      typeof message === 'string' ? hexToBytes(message) : message,
      cardPubkey,
    );
  } catch {
    return false;
  }
}

/**
 * NUT-12 for a piece as the card keeps it: rebuild B' = Y + r·G and
 * C' = C + r·K from the secret, C and the kept r, and check the mint's (e, s)
 * with its key K for the amount. A piece that passes was signed by the mint;
 * it says nothing about whether the piece is still unspent.
 *
 * `keys` maps amount → the mint's compressed public key (a keyset's keys,
 * persisted so the check works offline: `cachedKeysets`).
 */
export function verifyPieceDleq(
  piece: {secret: string; C: string; amount: number},
  dleq: {e: string; s: string; r: string} | null | undefined,
  keys: Record<string, string> | undefined,
): boolean {
  if (!dleq || !keys) {
    return false;
  }
  const K = keys[String(piece.amount)];
  if (!K) {
    return false;
  }
  try {
    return verifyDLEQProof_reblind(
      utf8ToBytes(piece.secret),
      {
        e: hexToBytes(dleq.e),
        s: hexToBytes(dleq.s),
        r: BigInt(`0x${dleq.r}`),
      },
      pointFromHex(piece.C),
      pointFromHex(K),
    );
  } catch {
    return false;
  }
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
  checkState: (
    entry: SettlementEntry,
  ) => Promise<'spent' | 'unspent' | 'unknown'>;
  recover: (entry: SettlementEntry) => Promise<void>;
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
      // Best effort: the keysets (and their public keys) are what an offline
      // charge checks a card's pieces against and blinds its outputs for.
      await persistKeysets(mintUrl, w).catch(() => {});
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

// ── keysets, kept for offline use ───────────────────────────────────────────

/**
 * A mint keyset as this terminal keeps it: enough to expand a card's 8-byte
 * keyset id, price a swap's input fee, blind outputs and check a piece's
 * DLEQ with no network.
 */
export interface CachedKeyset {
  id: string;
  unit: string;
  active: boolean;
  /** NUT-02 input fee, parts per thousand per input. */
  inputFeePpk: number;
  /** amount → the mint's compressed public key for it. */
  keys: Record<string, string>;
}

const keysetsKey = (mintUrl: string) => `@cashu_keysets:${mintUrl}`;

/** The keysets last seen at `mintUrl`; `[]` when none were kept or they will not read. */
export async function cachedKeysets(mintUrl: string): Promise<CachedKeyset[]> {
  try {
    const raw = await getSecure(keysetsKey(mintUrl));
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CachedKeyset[]) : [];
  } catch {
    return [];
  }
}

/** Keep `keysets` for `mintUrl` (public data: ids, fees and public keys). */
export async function saveKeysets(
  mintUrl: string,
  keysets: CachedKeyset[],
): Promise<void> {
  await setSecure(keysetsKey(mintUrl), JSON.stringify(keysets));
}

async function persistKeysets(mintUrl: string, wallet: Wallet): Promise<void> {
  const chain = (wallet as {keyChain?: {getKeysets?: () => unknown[]}})
    .keyChain;
  if (!chain || typeof chain.getKeysets !== 'function') {
    return;
  }
  const listed = chain.getKeysets();
  if (!Array.isArray(listed) || listed.length === 0) {
    return;
  }
  const fresh = (
    listed as {
      id: string;
      unit: string;
      isActive: boolean;
      fee: number;
      hasKeys: boolean;
      keys: Record<number, string>;
    }[]
  ).map(
    (k): CachedKeyset => ({
      id: k.id,
      unit: k.unit,
      active: k.isActive,
      inputFeePpk: k.fee ?? 0,
      keys: k.hasKeys
        ? Object.fromEntries(
            Object.entries(k.keys).map(([a, key]) => [String(a), key]),
          )
        : {},
    }),
  );
  // Keep keys learned earlier for a keyset the mint now lists without them
  // (an inactive keyset whose keys were fetched once): the pieces on a card
  // can be older than the mint's active keyset.
  const previous = new Map((await cachedKeysets(mintUrl)).map(k => [k.id, k]));
  await saveKeysets(
    mintUrl,
    fresh.map(k =>
      Object.keys(k.keys).length === 0 && previous.get(k.id)
        ? {...k, keys: previous.get(k.id)!.keys}
        : k,
    ),
  );
}

/** No keyset of the mint matches what the card stores. */
export class UnknownKeysetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownKeysetError';
  }
}

/**
 * The keyset a card's stored 8 bytes name: the ONE keyset whose id begins
 * with them (an 8-byte id is itself; a 33-byte v2 id is named by its first 8
 * bytes). Refuses an ambiguous or unknown prefix rather than guessing.
 */
export function expandKeysetId(
  cardKeysetId: string,
  keysets: CachedKeyset[],
): CachedKeyset {
  const prefix = cardKeysetId.toLowerCase().slice(0, 16);
  const found = keysets.filter(k => k.id.toLowerCase().startsWith(prefix));
  if (found.length !== 1) {
    throw new UnknownKeysetError(
      found.length === 0
        ? `the mint has no keyset ${prefix}`
        : `keyset ${prefix} names ${found.length} keysets`,
    );
  }
  return found[0];
}

/**
 * The keyset a card piece names, with its keys: from the kept keysets when
 * they have it, else (with `online`) from the mint, which refreshes what is
 * kept. Throws `UnknownKeysetError` when neither has it.
 */
export async function keysetFor(
  mintUrl: string,
  cardKeysetId: string,
  {online = true}: {online?: boolean} = {},
): Promise<CachedKeyset> {
  const kept = await cachedKeysets(mintUrl);
  try {
    const hit = expandKeysetId(cardKeysetId, kept);
    if (Object.keys(hit.keys).length > 0) {
      return hit;
    }
  } catch (error) {
    if (!online) {
      throw error;
    }
  }
  if (!online) {
    throw new UnknownKeysetError(
      `the keys of keyset ${cardKeysetId} are not kept on this terminal`,
    );
  }
  const wallet = await getWallet(mintUrl);
  const chain = (
    wallet as {
      keyChain?: {
        getKeysets?: () => {id: string}[];
        ensureKeysetKeys?: (id: string) => Promise<unknown>;
      };
    }
  ).keyChain;
  if (chain?.getKeysets && chain.ensureKeysetKeys) {
    const prefix = cardKeysetId.toLowerCase().slice(0, 16);
    const ids = chain
      .getKeysets()
      .map(k => k.id)
      .filter(id => id.toLowerCase().startsWith(prefix));
    if (ids.length === 1) {
      await chain.ensureKeysetKeys(ids[0]);
    }
  }
  await persistKeysets(mintUrl, wallet);
  const refreshed = expandKeysetId(cardKeysetId, await cachedKeysets(mintUrl));
  if (Object.keys(refreshed.keys).length === 0) {
    throw new UnknownKeysetError(
      `the mint gave no keys for keyset ${refreshed.id}`,
    );
  }
  return refreshed;
}

/**
 * Force a fresh listing of `mintUrl`'s keysets from the mint, overwriting
 * whatever is cached (ENG-674 should-fix): `keysetFor`'s offline-first
 * lookup returns a cached keyset as soon as it has keys, never checking
 * whether the mint has since rotated it — and SIG_ALL binds the change
 * keyset's `active` flag and its fee into the swap's outputs for good, so a
 * charge about to build them must not trust a cache that might be stale.
 * Resolves true only once the fresh listing is persisted. False when the
 * mint will not answer in full within `timeoutMs` (a failed or slow keys
 * fetch, a store write refused), leaving whatever is cached untouched: the
 * caller must then treat the cache as stale, as it would with no mint at
 * all — never sign on it as if it were fresh (ENG-674). A refresh that
 * lands after the deadline may still update the cache; the caller has
 * already been told "not fresh" and acts on that.
 */
export async function refreshKeysets(
  mintUrl: string,
  timeoutMs = 3000,
): Promise<boolean> {
  const attempt = (async () => {
    try {
      const wallet = await getWallet(mintUrl);
      await wallet.loadMint(true);
      await persistKeysets(mintUrl, wallet);
      return true;
    } catch {
      return false;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether the mint answers at all, within `timeoutMs` — asked before a card
 * pays with pieces this terminal cannot check offline (no DLEQ, or no keys
 * kept): such a payment must be swapped in the same tap. A transport or
 * HTTP failure is "no".
 */
export async function mintReachable(
  mintUrl: string,
  timeoutMs = 3000,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetchFn(
      `${mintUrl.replace(/\/+$/, '')}/v1/keysets`,
      controller ? {signal: controller.signal} : {},
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** NUT-02: the input fee for `inputs` pieces of `keyset`, rounded up. */
export const inputFee = (keyset: CachedKeyset, inputs: number): number =>
  Math.ceil(((keyset.inputFeePpk ?? 0) * inputs) / 1000);

// ── the charge's swap: SIG_ALL outputs made BEFORE the card signs ───────────

/** The merchant's side of a charge's outputs: the blinded messages and their openings. */
export interface ChargeOutputs {
  outputs: SettlementOutput[];
  blinding: MerchantBlinding[];
}

/** Validate that the private recovery material actually opens each merchant output. */
export function validateChargeOutputs(merchant: ChargeOutputs): void {
  if (
    !merchant.outputs.length ||
    merchant.outputs.length !== merchant.blinding.length
  ) {
    throw new Error('merchant outputs are missing their recovery openings');
  }
  for (let i = 0; i < merchant.outputs.length; i++) {
    const output = merchant.outputs[i];
    const opening = merchant.blinding[i];
    if (
      !/^[0-9a-f]{64}$/i.test(opening.r) ||
      !opening.secret ||
      !Number.isSafeInteger(output.amount) ||
      output.amount <= 0
    ) {
      throw new Error('merchant recovery opening is invalid');
    }
    const {B_} = blindMessage(
      utf8ToBytes(opening.secret),
      BigInt('0x' + opening.r),
    );
    if (bytesToHex(B_.toBytes(true)) !== output.B_.toLowerCase()) {
      throw new Error('merchant recovery opening does not match its output');
    }
  }
}

/**
 * The merchant's outputs for a charge, blinded locally (no network): one
 * random-secret output per power-of-two piece of `merchantSat`, in
 * `keysetId`. They must exist before SPEND_ALL_SIGN, because SIG_ALL signs
 * the swap's outputs; the blinding is kept with the payment (the queue
 * entry) so whoever completes the swap can unblind them.
 */
export function prepareChargeOutputs({
  keysetId,
  merchantSat,
}: {
  keysetId: string;
  merchantSat: number;
}): ChargeOutputs {
  if (!Number.isInteger(merchantSat) || merchantSat <= 0) {
    throw new Error(
      `the merchant's outputs must be worth something, got ${merchantSat}`,
    );
  }
  const outputs: SettlementOutput[] = [];
  const blinding: MerchantBlinding[] = [];
  for (const amount of splitPow2(merchantSat)) {
    const secret = bytesToHex(randomBytes(32));
    const {B_, r} = blindMessage(utf8ToBytes(secret));
    outputs.push({amount, B_: bytesToHex(B_.toBytes(true)), keysetId});
    blinding.push({r: r.toString(16).padStart(64, '0'), secret});
  }
  return {outputs, blinding};
}

/** A swap signature's amount, whatever cashu-ts normalised it to. */
const amountOf = (amount: unknown): number =>
  typeof amount === 'object' &&
  amount !== null &&
  typeof (amount as {toNumber?: unknown}).toNumber === 'function'
    ? (amount as {toNumber: () => number}).toNumber()
    : Number(amount);

/** C = C_ − r·K, compressed hex. */
function unblind(C_: string, r: string, K: string): string {
  return unblindSignature(
    pointFromHex(C_),
    BigInt(`0x${r}`),
    pointFromHex(K),
  ).toHex(true);
}

export interface SignedSwap {
  /** Every piece the payment burned, in the order the card signed them. */
  inputs: SettlementInput[];
  /** The card's one SIG_ALL signature, hex. */
  witness: string;
  /** Every output, in the order the card signed them. */
  outputs: SettlementOutput[];
  /** Unblinding for `outputs[0 .. blinding.length)`, the merchant's. */
  merchantBlinding: MerchantBlinding[];
  /** The first output that is the card's own change; absent for none. */
  cardChangeIndex?: number;
}

export interface SwapSignedResult {
  /** The merchant's outputs, unblinded: liquid proofs for the till. */
  till: SettledProof[];
  /** The card's change: the mint's blind signatures, as the card's openings need them. */
  cardChange: OwedCardChange[];
}

/**
 * Submit a SIG_ALL swap exactly as the card signed it — the one witness on
 * the first input, the stored outputs in the stored order — and split what
 * the mint signs: the merchant's outputs are unblinded into till proofs, the
 * card's change comes back as blind signatures (C_ with its DLEQ) for the
 * card's own openings to finish.
 *
 * The caller (the charge, or the drain's adapter) owns the error mapping and
 * the bookkeeping order. A throw before the response is "the swap did not
 * happen or its outcome is unknown"; nothing is written here.
 */
export async function swapSigned(
  mintUrl: string,
  signed: SignedSwap,
): Promise<SwapSignedResult> {
  const wallet = await getWallet(mintUrl);
  const witness = JSON.stringify({signatures: [signed.witness]});
  const response = await withRateLimitRetry(() =>
    wallet.mint.swap({
      inputs: signed.inputs.map((input, i) => ({
        id: input.keysetId,
        amount: input.amount,
        secret: input.secret,
        C: input.C,
        ...(i === 0 ? {witness} : {}),
      })) as unknown as Proof[],
      outputs: signed.outputs.map(o => ({
        amount: o.amount,
        id: o.keysetId,
        B_: o.B_,
      })) as never,
    }),
  );
  return decodePromises(mintUrl, signed, response.signatures, false);
}

type PromiseSignature = {
  amount: unknown;
  id: string;
  C_: string;
  dleq?: {e: string; s: string};
};
async function decodePromises(
  mintUrl: string,
  signed: SignedSwap,
  signatures: PromiseSignature[],
  requireDleq: boolean,
): Promise<SwapSignedResult> {
  if (signatures.length !== signed.outputs.length || !signatures.length) {
    throw new Error('mint promises do not cover the original outputs');
  }
  const changeAt = signed.cardChangeIndex ?? signed.outputs.length;
  if (
    changeAt < 0 ||
    changeAt > signed.outputs.length ||
    signed.merchantBlinding.length !== changeAt
  ) {
    throw new Error('invalid merchant output boundary');
  }
  validateChargeOutputs({
    outputs: signed.outputs.slice(0, changeAt),
    blinding: signed.merchantBlinding,
  });

  const till: SettledProof[] = [];
  const cardChange: OwedCardChange[] = [];
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    const output = signed.outputs[i];
    const amount = amountOf(sig.amount);
    if (amount !== output.amount || sig.id !== output.keysetId) {
      throw new Error('mint promise does not match the original amount/keyset');
    }
    const keyset = await keysetFor(mintUrl, output.keysetId);
    const K = keyset.keys[String(amount)];
    if (!K || (requireDleq && !sig.dleq)) {
      throw new Error('mint promise is missing its verification key or DLEQ');
    }
    if (
      sig.dleq &&
      !verifyDLEQProof(
        {e: hexToBytes(sig.dleq.e), s: hexToBytes(sig.dleq.s)},
        pointFromHex(output.B_),
        pointFromHex(sig.C_),
        pointFromHex(K),
      )
    ) {
      throw new Error('mint promise DLEQ does not verify');
    }
    const dleq = sig.dleq
      ? {e: String(sig.dleq.e), s: String(sig.dleq.s)}
      : undefined;
    if (i >= changeAt) {
      cardChange.push({
        keysetId: output.keysetId,
        amount,
        B_: output.B_,
        C_: sig.C_,
        ...(dleq ? {dleq} : {}),
      });
      continue;
    }
    const blinding = signed.merchantBlinding[i];
    if (!blinding) {
      throw new Error(`no blinding kept for the merchant's output ${i}`);
    }
    till.push({
      id: output.keysetId,
      amount,
      secret: blinding.secret,
      C: unblind(sig.C_, blinding.r, K),
      mintUrl,
    });
  }
  return {till, cardChange};
}

/**
 * The card's change, finished: C = C_ − r·K with the r from the card's
 * opening. `keys` is the change keyset's (amount → K).
 */
export function finishCardChange(
  C_: string,
  r: string,
  amount: number,
  keys: Record<string, string>,
): string {
  const K = keys[String(amount)];
  if (!K) {
    throw new UnknownKeysetError(`no key for ${amount}`);
  }
  return unblind(C_, r, K);
}

export function createSettlementAdapter(): SettlementAdapter {
  // drainQueue does not filter entries by mint — it hands every pending entry
  // to swap — so the adapter must settle each proof against the mint that
  // issued it (SettlementEntry.mintUrl), not against whatever the terminal is
  // currently configured with.
  const swap = async (entry: SettlementEntry): Promise<void> => {
    if (entry.sigflag === 'SIG_ALL') {
      return settleSigAll(entry);
    }
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
      // A 429 mid-burst is the routine throttle, not a verdict — retrying
      // inside the adapter keeps it from surfacing as a permanent settlement
      // failure (the drain used to park entries on exactly that). Mint
      // operation errors are deliberately NOT retried (withRateLimitRetry
      // only retries a throttle): codes like 11002 are the mint's answer,
      // and mapSwapError owns them.
      const swapped = await withRateLimitRetry(() =>
        wallet.completeSwap(preview),
      );
      // The keep/send split is PAYMENT-flow semantics — send is what a payer
      // hands to a recipient. In a settlement the terminal is the recipient
      // of the entire swap: every output the mint signs is merchant money.
      // Persisting only `keep` (empty when the inputs exactly cover the
      // amount, because send shapes the full amount) books a settled payment
      // as nothing — found in the field when the payout step then read an
      // empty store.
      const {keep, send} = swapped;
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

  /**
   * A 2.0 payment: resubmit EXACTLY the stored inputs and outputs (SIG_ALL
   * binds them; fresh outputs would void the witness). The witness is checked
   * against the stored message, and the message against the stored payment,
   * before any network call — a local mistake must not become a mint-side
   * rejection. The card's change comes back as blind signatures and is
   * recorded owed to its card (the next tap loads it from the card's own
   * openings), the merchant's outputs join the till.
   */
  const settleSigAll = async (entry: SettlementEntry): Promise<void> => {
    // Throws for an entry with no witness: nothing to submit yet.
    toSigAllInputs(entry);
    const message = bytesToHex(sigAllMessage(entry.inputs, entry.outputs));
    if (
      !entry.message ||
      message !== entry.message.toLowerCase() ||
      !verifyCardSignature(entry.witness!, message, entry.cardPubkey)
    ) {
      throw new PermanentSettlementError(
        `settlement ${entry.id}: the card's witness does not sign this payment`,
      );
    }
    let result: SwapSignedResult;
    try {
      result = await swapSigned(entry.mintUrl, {
        inputs: entry.inputs,
        witness: entry.witness!,
        outputs: entry.outputs,
        merchantBlinding: entry.merchantBlinding,
        cardChangeIndex: entry.cardChangeIndex,
      });
    } catch (error) {
      throw mapSwapError(error, entry);
    }
    // The mint holds the payment. From here a failure is a persistence
    // problem: the customer's change and the merchant's take each exist
    // nowhere else, so BOTH writes always run, whether or not the other
    // lands (ENG-642's `allAttempted` pattern) — a keychain that refuses
    // the change write must never cost the merchant's take, and the other
    // way round. Rethrowing the first failure leaves the entry ambiguous,
    // which the drain resolves by checkState — honest, never marked failed.
    await allAttempted([
      () =>
        recordOwedCardChange(
          entry.cardPubkey,
          result.cardChange,
          {mintUrl: entry.mintUrl, unit: entry.unit},
          Date.now(),
        ),
      () => appendSettledProofs(result.till),
    ]);
  };

  const checkState = async (
    entry: SettlementEntry,
  ): Promise<'spent' | 'unspent' | 'unknown'> => {
    const inputs =
      entry.sigflag === 'SIG_ALL'
        ? entry.inputs
        : [{keysetId: entry.keysetId, secret: entry.secret}];
    if (
      !inputs.length ||
      new Set(inputs.map(p => p.secret)).size !== inputs.length
    ) {
      return 'unknown';
    }
    const wallet = await getWallet(entry.mintUrl);
    const states = await wallet.checkProofsStates(
      inputs.map(p => ({id: p.keysetId, secret: p.secret})),
    );
    if (states.length !== inputs.length) {
      return 'unknown';
    }
    if (states.every(s => s.state === 'SPENT')) {
      return 'spent';
    }
    if (states.every(s => s.state === 'UNSPENT')) {
      return 'unspent';
    }
    return 'unknown';
  };

  const recover = async (entry: SettlementEntry): Promise<void> => {
    if (entry.sigflag !== 'SIG_ALL' || entry.unit !== 'sat') {
      throw new Error(
        'this payment requires supervised merchant output recovery',
      );
    }
    toSigAllInputs(entry);
    const message = bytesToHex(sigAllMessage(entry.inputs, entry.outputs));
    if (
      message !== entry.message?.toLowerCase() ||
      !verifyCardSignature(entry.witness!, message, entry.cardPubkey)
    ) {
      throw new Error('stored payment signature does not verify');
    }
    // Initial recovery profile is exact payments. Change needs its own durable
    // delivery/retirement fence before a restore can safely recreate an owed record.
    if (
      (entry.cardChangeIndex ?? entry.outputs.length) < entry.outputs.length
    ) {
      throw new Error(
        'payment change requires supervised recovery; original records retained',
      );
    }
    if ((await checkState(entry)) !== 'spent') {
      throw new Error('every original input must be confirmed spent');
    }
    const wallet = await getWallet(entry.mintUrl);
    const response = await wallet.mint.restore({
      outputs: entry.outputs.map(o => ({
        id: o.keysetId,
        amount: o.amount,
        B_: o.B_,
      })) as never,
    });
    if (
      response.outputs.length !== entry.outputs.length ||
      response.signatures.length !== entry.outputs.length ||
      new Set(entry.outputs.map(o => o.B_)).size !== entry.outputs.length
    ) {
      throw new Error('restore did not cover every distinct original output');
    }
    const paired = new Map<string, PromiseSignature>();
    for (let i = 0; i < response.outputs.length; i++) {
      const got = response.outputs[i];
      const expected = entry.outputs.find(o => o.B_ === got.B_);
      if (
        !expected ||
        paired.has(got.B_) ||
        got.id !== expected.keysetId ||
        amountOf(got.amount) !== expected.amount
      ) {
        throw new Error('restore substituted or duplicated an original output');
      }
      paired.set(got.B_, response.signatures[i]);
    }
    const result = await decodePromises(
      entry.mintUrl,
      {
        inputs: entry.inputs,
        witness: entry.witness!,
        outputs: entry.outputs,
        merchantBlinding: entry.merchantBlinding,
        cardChangeIndex: entry.cardChangeIndex,
      },
      entry.outputs.map(o => paired.get(o.B_)!),
      true,
    );
    const states = await wallet.checkProofsStates(
      result.till as unknown as Proof[],
    );
    if (
      states.length !== result.till.length ||
      states.some(s => s.state !== 'UNSPENT' && s.state !== 'SPENT')
    ) {
      throw new Error(
        'restored merchant inventory state is incomplete or pending',
      );
    }
    // SPENT output promises prove issuance, not another credit. Persist both
    // available outputs and consumed-output fences before completing the queue.
    const consumed = result.till.filter((_, i) => states[i].state === 'SPENT');
    const accounted = await recordedPayout(consumed);
    await updateTill({
      add: result.till.filter((_, i) => states[i].state === 'UNSPENT'),
      retire: consumed,
    });
    if (!accounted) {
      throw new Error('consumed merchant outputs need payout reconciliation');
    }
  };

  return {swap, checkState, recover};
}

/**
 * Map a cashu-ts failure onto the queue's error classes. Anything not mapped
 * is rethrown unchanged: the queue reads a plain throw as "outcome unknown",
 * which is the conservative default for everything ambiguous.
 *
 * Shared with `executeCharge`'s inline swap (ENG-674): a mint rejection or
 * HTTP 4xx must never be deferred as paid there either, so both callers
 * classify a swap failure the same way.
 */
export function mapSwapError(error: unknown, entry: SettlementEntry): unknown {
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
      `settlement ${entry.id}: the request never reached the network (${String(
        error,
      )})`,
    );
  }
  return error;
}

function isHttpResponse(
  error: unknown,
): error is {status: number; message: string} {
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

/** Repeated recovery of the same output credits the inventory once. */
export async function appendSettledProofsTill(
  proofs: SettledProof[],
): Promise<void> {
  await updateTill({add: proofs});
}
export const listSettledProofs = readTill;
const appendSettledProofs = appendSettledProofsTill;

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
  /**
   * Melt exactly these settled proofs; omitted = the whole store. The sweep
   * passes its selection so nothing outside it is melted or invoiced for.
   */
  proofs?: SettledProof[];
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
  proofs: subset,
  now = Date.now(),
}: PayoutArgs): Promise<PayoutResult> {
  if (Boolean(bolt11) === Boolean(lightningAddress)) {
    throw new Error('payout needs exactly one of bolt11 or lightningAddress');
  }
  const proofs = subset ?? (await listSettledProofs());
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
    const needed = Number(quote.amount) + Number(quote.fee_reserve);
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

  const needed = Number(quote.amount) + Number(quote.fee_reserve);
  if (needed > totalSat) {
    throw new Error(
      `payout needs ${needed} sat but the settled balance is ${totalSat} sat`,
    );
  }

  // Persist the melt intent before the network call: if the app dies after
  // the mint pays, these secrets + quote are the reconciliation record.
  await setSecure(
    PENDING_PAYOUT_KEY,
    JSON.stringify({
      quoteId: quote.quote,
      bolt11,
      lightningAddress,
      secrets: proofs.map(p => p.secret),
      at: now,
    }),
  );

  let response: Awaited<ReturnType<typeof wallet.meltProofsBolt11>>;
  try {
    const result = await wallet.meltProofsBolt11(quote, proofs as ProofLike[]);
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
  await updateTill({retire: proofs, add: change, disposition: 'paid'});
  await removeSecure(PENDING_PAYOUT_KEY);

  return {
    paidSat: Number(quote.amount),
    feeReserveSat: Number(quote.fee_reserve),
    preimage: response.quote.payment_preimage ?? null,
    change,
  };
}

/**
 * The mint said "slow down": cashu-ts raises `RateLimitError` (an
 * `HttpResponseError` with status 429) for a literal 429; older paths and
 * hand-rolled fetches surface the same verdict as a status field or a
 * message. A throttle is a signal the caller must honour by backing off —
 * never a failure to swallow and retry on the next tick (ENG-626: a 20 s
 * cadence of swallowed 429s re-armed forge's limiter indefinitely).
 */
export function isRateLimited(error: unknown): boolean {
  if (error instanceof HttpResponseError && error.status === 429) {
    return true;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as {status?: unknown}).status === 429
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : '';
  // Only an explicit HTTP status counts: a bare `429` in free text is just
  // as likely an amount (`payout needs 429 sat …`), and a real payout
  // failure must never be read as a throttle. The lnurlp fetches above say
  // `HTTP 429`; cashu-ts's own 429 is a typed error caught earlier.
  return /\bHTTP\s*429\b|rate.?limit|too many requests/i.test(message);
}

/**
 * Reconcile asks the mint about every till proof (NUT-07 checkstate). The
 * till only drifts when a melt/swap response is lost, so once per window is
 * plenty — and the auto-settle loop would otherwise ask every 20 s for as
 * long as the app is in the foreground.
 */
export const RECONCILE_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastReconcileAt = 0;

/** Test seam: forget when the till was last reconciled. */
export function __resetReconcileThrottle(): void {
  lastReconcileAt = 0;
}

/**
 * Drop till listings the mint no longer honours. The store can drift from
 * mint reality when a melt/swap consumes a proof but the response (and its
 * store update) is lost — every later sweep/payout then fails 11001. The
 * mint's own checkstate is the arbiter: a spent listing is worthless
 * bookkeeping and leaves.
 *
 * Throttled to once per `RECONCILE_MIN_INTERVAL_MS`: a call inside the
 * window returns 0 without touching the network, unless `force` is set —
 * the mint just answered 11001, so the store is provably stale and waiting
 * out the window would only repeat the failure. A 429 from the mint is
 * rethrown so the caller backs off; every other failure keeps the last
 * known state. Paths that need a fresh verdict right now (the 11001 retry
 * in makeChangeOnTill) call `checkProofsStates` directly, not this.
 */
export async function reconcileTill(
  mintUrl: string,
  opts: {now?: number; force?: boolean} = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
    return 0;
  }
  const proofs = await listSettledProofs();
  if (proofs.length === 0) {
    return 0;
  }
  // Stamp the attempt, not the success: a throttled or offline reconcile
  // must not be re-asked on the next tick either.
  lastReconcileAt = now;
  try {
    const wallet = await getWallet(mintUrl);
    const states = await wallet.checkProofsStates(proofs as unknown as Proof[]);
    const spent = new Set(
      proofs.filter((_, i) => states[i]?.state === 'SPENT').map(p => p.secret),
    );
    if (spent.size === 0) {
      return 0;
    }
    await updateTill({retire: proofs.filter(p => spent.has(p.secret))});
    return spent.size;
  } catch (error) {
    if (isRateLimited(error)) {
      throw error;
    }
    // A failed reconcile keeps the last known state — never flip to
    // all-clear on a network error.
    return 0;
  }
}

/**
 * Sweep the settled till to the account address.
 *
 * Protocol 2.0 keeps no till float: the card makes its own change, so in
 * production everything settled sweeps (`keepReserveSat` 0). The reserve
 * stays an explicit parameter, held back largest-first so the smallest
 * proofs are the ones kept.
 *
 * `minSweepSat` keeps a dust till off the mint: below it the run answers
 * from the store alone, with no reconcile and no melt quote (ENG-626).
 *
 * Only the selected proofs are melted, and the invoice is sized from them:
 * `meltSettledProofs` takes the selection and drops exactly those from the
 * store, so nothing the mint consumed stays listed as money in the till.
 */
export async function sweepSettledProofs(opts: {
  mintUrl: string;
  bolt11?: string;
  lightningAddress?: string;
  lnurlpUrl?: string;
  keepReserveSat?: number;
  minSweepSat?: number;
  now?: number;
}): Promise<PayoutResult> {
  const {keepReserveSat = 0, minSweepSat = 0, mintUrl} = opts;
  const sumSat = (ps: SettledProof[]) => ps.reduce((t, p) => t + p.amount, 0);
  const nothing: PayoutResult = {
    paidSat: 0,
    feeReserveSat: 0,
    preimage: null,
    change: [],
  };
  const tooSmall = (total: number) =>
    total <= keepReserveSat || total < minSweepSat;
  // Nothing to sweep (at or under the reserve, or under the minimum): answer
  // from the store alone, with no mint call. Reconciling first here is what
  // ENG-626 was: a small till asked the mint checkstate every 20 s, took a
  // 429 each time, and the run still read as clean.
  if (tooSmall(sumSat(await listSettledProofs()))) {
    return nothing;
  }
  // Reconcile before melting: a till listing the mint already spent
  // (consumed by an earlier melt/swap whose store update was lost) would
  // fail every payout with 11001 forever. Drop spent listings, then sweep
  // the survivors. A 429 propagates: the caller backs off.
  await reconcileTill(mintUrl, {now: opts.now});
  // The reconcile is throttled, so a listing that went stale INSIDE the
  // window (a melt response lost since the last ask) still reaches the melt
  // and comes back 11001. That verdict is the mint telling us the store is
  // stale right now: reconcile again regardless of the window and retry
  // once, so the self-heal stays silent instead of toasting on every tick
  // until the window reopens. The retry re-reads the healed store and
  // selects again.
  for (let attempt = 0; ; attempt += 1) {
    const proofs = await listSettledProofs();
    const total = sumSat(proofs);
    if (tooSmall(total)) {
      return nothing;
    }
    // Largest-first selection, stopping once it covers everything above the
    // reserve. Only these are melted; the rest stay in the store untouched.
    const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
    const meltTarget = total - keepReserveSat;
    let acc = 0;
    const toMelt: SettledProof[] = [];
    for (const p of sorted) {
      if (acc >= meltTarget) {
        break;
      }
      toMelt.push(p);
      acc += p.amount;
    }
    try {
      return await meltSettledProofs({...opts, proofs: toMelt});
    } catch (error) {
      if (
        attempt === 0 &&
        isMintOperationError(error) &&
        error.code === TOKEN_ALREADY_SPENT &&
        (await reconcileTill(mintUrl, {now: opts.now, force: true})) > 0
      ) {
        continue;
      }
      throw error;
    }
  }
}

// ── the mint's throttle ───────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Forge rate-limits bursts, and a charge is a burst: settle + change-swap
 * inside one session. One retry after the mint's own retryAfterMs (or 2.5s)
 * clears the routine throttle. Only a throttle is retried: a mint operation
 * error (11001 and friends) is the mint's verdict and re-sending the same
 * request would only repeat it.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isRateLimited(error)) {
      throw error;
    }
    const wait = (error as {retryAfterMs?: number}).retryAfterMs ?? 2500;
    await sleep(wait);
    return fn();
  }
}
