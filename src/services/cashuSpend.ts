/**
 * Tap-to-pay on a 2.0 card: everything between "the plan is chosen" and
 * "the payment is durably owed to us", plus the drain that finishes it.
 *
 * One payment is one NUT-11 SIG_ALL signature. The card signs the swap's
 * INPUTS and its OUTPUTS together, so the outputs must exist before it signs:
 *
 *   1. TELL_TIME, and SET_HEADER when the till has a fresh tip — before the
 *      payment begins, because any other command between BEGIN and SIGN
 *      gives the payment up
 *   2. SPEND_ALL_BEGIN (the places), SPEND_ALL_OUTPUTS (the merchant's),
 *      SPEND_ALL_CHANGE (the card's own change, one per power-of-two piece)
 *   3. the SIG_ALL message, rebuilt here from the same secrets and outputs
 *   4. SPEND_ALL_SIGN — every place burned in the commit that releases the
 *      signature
 *   5. the signature verified against the message, then `recordSpend` once
 *      for the whole payment — the durable record that lets the UI say "paid"
 *
 * Step 4 is irreversible. If its answer is lost, the card is asked which
 * places are spent: none → nothing burned, the error surfaces; spent → the
 * signature is fetched again (SPEND_ALL_AGAIN) and accepted only if it
 * verifies against this payment's message, else the payment is recorded
 * `needs-card` with everything it signed, for the next tap to recover. A
 * card that ANSWERS its SIGN with a signature that does not verify (and
 * gives none that does again) has nothing to recover: that payment is
 * recorded `failed`, for a human.
 * Recording a `needs-card` entry for places that never burned would show the
 * merchant an exposure that does not exist.
 */
import {bytesToHex} from '@noble/hashes/utils';

import {
  CardAuthError,
  CardError,
  CardProtocolError,
  getSlotStatuses,
  isProvenOver,
  setHeader,
  spendAllAgain,
  spendAllBegin,
  spendAllChange,
  spendAllOutputs,
  spendAllSign,
  tellTime,
  toHex,
  type ProvenCardKey,
  type Transceiver,
} from './cashuCard';
import {
  createSettlementAdapter,
  sigAllMessage,
  verifyCardSignature,
  type ChargeOutputs,
  type SignedSwap,
} from './cashuMint';
import {
  attachRecoveredWitness,
  drainQueue,
  markFailed,
  recordSpend,
  recoverableForCard,
  type DrainResult,
  type SettlementEntry,
  type SettlementInput,
  type SettlementOutput,
} from './cashuSettlement';
import {splitPow2} from '../utils/denominations';

export const DEFAULT_UNIT = 'sat';

/**
 * TELL_TIME, then SET_HEADER with `header` when there is one. Both are notes
 * the card checks or ignores on its own terms: a refusal (a header with too
 * little work, a stale one) never stops a payment. A transport failure does —
 * the card is gone.
 */
export async function tellTheClock(
  transceive: Transceiver,
  nowMs: number,
  header?: number[] | null,
): Promise<void> {
  try {
    await tellTime(transceive, Math.floor(nowMs / 1000));
  } catch (error) {
    if (!(error instanceof CardError)) {
      throw error;
    }
  }
  if (header) {
    try {
      await setHeader(transceive, header);
    } catch (error) {
      if (!(error instanceof CardError)) {
        throw error;
      }
    }
  }
}

export interface SpendAllArgs {
  transceive: Transceiver;
  /** The payment's pieces, in the order the card hashes them. */
  inputs: SettlementInput[];
  /** The merchant's outputs (`prepareChargeOutputs`). */
  merchant: ChargeOutputs;
  /** The card's own change, made on the card in power-of-two pieces. */
  changeSat: number;
  /** The full keyset id the card's change is minted in (the first piece's). */
  changeKeysetId: string;
  cardPubkey: string;
  mintUrl: string;
  unit?: string;
  now?: number;
  /** The tip header to show the card first, when the till has a fresh one. */
  header?: number[] | null;
  /**
   * Called once, synchronously, just before SPEND_ALL_SIGN: from here the
   * card may burn the payment, so the screen holds its exits (ENG-645).
   */
  onSign?: () => void;
}

export interface SpendAllResult {
  /**
   * The recorded payment: `pending` with its witness; `needs-card` when the
   * card's answer was lost; `failed` when the card answered with a
   * signature that does not verify (and SPEND_ALL_AGAIN gave none that does).
   */
  entry: SettlementEntry;
  /** What the swap submits, exactly as the card signed it. */
  signed: SignedSwap | null;
  /**
   * The card ANSWERED SPEND_ALL_SIGN with a signature that does not verify
   * against this payment, and SPEND_ALL_AGAIN gave none that does: nothing
   * is left to recover. Set whether or not the store took the `failed`
   * mark, so the caller never reads a refused signature as a lost answer
   * (which SPEND_ALL_AGAIN at a later tap might still recover).
   */
  signatureInvalid: boolean;
}

/** Record the payment the card has burned; `witness` absent = `needs-card`. */
function recordPayment(
  args: SpendAllArgs,
  outputs: SettlementOutput[],
  cardChangeIndex: number | undefined,
  message: string,
  witness: string | undefined,
  now: number,
): Promise<SettlementEntry> {
  const first = args.inputs[0];
  return recordSpend(
    {
      cardPubkey: args.cardPubkey,
      slot: first.slot,
      keysetId: first.keysetId,
      mintUrl: args.mintUrl,
      unit: args.unit ?? DEFAULT_UNIT,
      amount: args.inputs.reduce((t, i) => t + i.amount, 0),
      nonce: first.nonce,
      secret: first.secret,
      C: first.C,
      sigflag: 'SIG_ALL',
      inputs: args.inputs,
      outputs,
      merchantBlinding: args.merchant.blinding,
      ...(cardChangeIndex === undefined ? {} : {cardChangeIndex}),
      message,
      ...(witness ? {witness} : {}),
    },
    now,
  );
}

/**
 * Pay with the card: one SIG_ALL signature over the planned pieces, the
 * merchant's outputs and the card's own change, recorded once.
 *
 * Throws, with nothing burned, for any refusal before or at SIGN (a CardError:
 * `6A94` the PIN is needed, `6A8F` over the daily limit, …). Resolves once the
 * payment is durably recorded — `pending` with the witness; `needs-card`
 * when the card burned it and its answer was lost; `failed` when the card
 * answered with a signature that does not verify. Only `pending` comes with
 * `signed`: the caller must never call a payment without it paid.
 */
export async function spendAll(args: SpendAllArgs): Promise<SpendAllResult> {
  const {transceive, inputs, merchant, changeSat, cardPubkey} = args;
  const now = args.now ?? Date.now();
  if (inputs.length === 0) {
    throw new CardProtocolError('a payment needs at least one piece');
  }
  const slots = inputs.map(i => i.slot);
  const total = inputs.reduce((t, i) => t + i.amount, 0);

  await tellTheClock(transceive, now, args.header);

  const named = await spendAllBegin(transceive, slots);
  if (named !== total) {
    // The card's pieces are not the ones this plan read: stop before any
    // output goes in. The next command gives the payment up.
    throw new CardProtocolError(
      `SPEND_ALL_BEGIN: the card's places are worth ${named} sat, the plan ${total}`,
    );
  }
  await spendAllOutputs(transceive, merchant.outputs);
  const outputs: SettlementOutput[] = [...merchant.outputs];
  const cardChangeIndex = changeSat > 0 ? outputs.length : undefined;
  for (const amount of changeSat > 0 ? splitPow2(changeSat) : []) {
    const B_ = await spendAllChange(transceive, amount);
    outputs.push({amount, B_, keysetId: args.changeKeysetId});
  }
  const message = bytesToHex(sigAllMessage(inputs, outputs));
  const signedSwap = (witness: string): SignedSwap => ({
    inputs,
    witness,
    outputs,
    merchantBlinding: merchant.blinding,
    ...(cardChangeIndex === undefined ? {} : {cardChangeIndex}),
  });

  args.onSign?.();
  let signature: string | null = null;
  /**
   * SPEND_ALL_SIGN answered (9000, 64 bytes) with a signature that does not
   * verify against this payment's message. Distinct from an answer that
   * never came: a lost answer may still be recovered (SPEND_ALL_AGAIN at a
   * later tap); a card that answers its own SIGN with a signature for
   * something else is broken, or is not the card that holds the key (an
   * emulator replaying pieces read off a real card through GET_PIECES and
   * GET_DLEQ, which need no PIN), and has nothing to recover.
   */
  let refusedSignature = false;
  try {
    signature = toHex(await spendAllSign(transceive));
  } catch (error) {
    // The card's own refusal is answered before anything is burned (the
    // commit is the last thing SIGN does). Only a lost answer is ambiguous.
    if (error instanceof CardError) {
      throw error;
    }
    const statuses = await getSlotStatuses(transceive).catch(() => null);
    if (!statuses || !slots.some(slot => statuses[slot] === 'spent')) {
      throw error;
    }
  }

  if (signature && !verifyCardSignature(signature, message, cardPubkey)) {
    // A signature that does not sign this payment is no witness. The card
    // has burned (it signs only in the commit): ask for it again below.
    refusedSignature = true;
    signature = null;
  }
  if (!signature) {
    signature = await spendAllAgain(transceive)
      .then(toHex)
      .catch(() => null);
    if (signature && !verifyCardSignature(signature, message, cardPubkey)) {
      // Another payment's signature (the card gives only its LAST one).
      signature = null;
    }
  }
  let entry = await recordPayment(
    args,
    outputs,
    cardChangeIndex,
    message,
    signature ?? undefined,
    now,
  );
  if (!signature && refusedSignature) {
    // Not `needs-card`: there is no lost answer to recover, only a card that
    // will not sign this payment. Kept for a human, never drained (it has no
    // witness) and never offered to SPEND_ALL_AGAIN again.
    const reason = "the card's signature does not verify against the payment";
    try {
      entry = (await markFailed(entry.id, reason, now)) ?? entry;
    } catch (error) {
      console.warn(
        '[charge] a payment with a signature that does not verify could not be marked failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return {
    entry,
    signed: signature ? signedSwap(signature) : null,
    signatureInvalid: !signature && refusedSignature,
  };
}

/**
 * Recover payments this card burned whose signature was lost (`needs-card`):
 * SPEND_ALL_AGAIN gives the card's LAST signature, which is accepted for the
 * entry whose stored message it verifies against. Every other `needs-card`
 * entry of this card is then unrecoverable — the card has signed another
 * payment since, and its signature for this one is gone — and is marked
 * `failed` for a human, never dropped.
 *
 * Runs BEFORE a new payment begins (a new SIGN replaces the last signature).
 * Best effort: a card that will not answer (the PIN not given for a
 * PIN-signed payment, the tag lost) leaves every entry as it was.
 *
 * Destructive on an answer that does not verify, so the key must be PROVEN:
 * `cardKey` comes from `proveCardKey` (AUTH) over this same `transceive`.
 * GET_PUBKEY alone is a claim any card can make, and an impostor's AGAIN
 * would mark the real card's payments failed. Anything else throws
 * `CardAuthError` before the queue is read or the card is asked anything.
 *
 * Resolves with the entries recovered.
 */
export async function recoverNeedsCard({
  transceive,
  cardKey,
  now = Date.now(),
}: {
  transceive: Transceiver;
  cardKey: ProvenCardKey;
  now?: number;
}): Promise<SettlementEntry[]> {
  if (!isProvenOver(cardKey, transceive)) {
    throw new CardAuthError(
      'needs-card recovery needs the card key proven by AUTH in this tap',
    );
  }
  const cardPubkey = cardKey.pubkey;
  let orphaned: SettlementEntry[];
  try {
    orphaned = (await recoverableForCard(cardPubkey)).filter(
      e => e.sigflag === 'SIG_ALL' && e.message,
    );
  } catch (error) {
    console.warn(
      '[charge] settlement queue unreadable; needs-card recovery skipped',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
  if (orphaned.length === 0) {
    return [];
  }
  let signature: string;
  try {
    signature = toHex(await spendAllAgain(transceive));
  } catch {
    return [];
  }
  const recovered: SettlementEntry[] = [];
  for (const entry of orphaned) {
    try {
      if (verifyCardSignature(signature, entry.message!, cardPubkey)) {
        const attached = await attachRecoveredWitness(entry.id, signature, now);
        if (attached) {
          recovered.push(attached);
        }
      } else {
        await markFailed(
          entry.id,
          'the card has signed another payment since this one; its signature cannot be given again',
          now,
        );
      }
    } catch {
      // A store write that will not land leaves the entry needs-card for the
      // next tap.
    }
  }
  return recovered;
}

/**
 * Drain the settlement queue.
 *
 * Each entry is settled against the mint that issued its proofs (see
 * `SettlementEntry.mintUrl`) — a queue holding entries from several mints
 * drains correctly in one pass. A 2.0 payment is resubmitted exactly as the
 * card signed it.
 */
export async function settlePending(now = Date.now()): Promise<DrainResult> {
  const adapter = createSettlementAdapter();
  return drainQueue(adapter.swap, now, {checkState: adapter.checkState});
}
