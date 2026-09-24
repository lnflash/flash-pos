/**
 * Tap-to-settle orchestration: everything between "merchant taps Spend" and
 * "the money is durably owed to us", plus the drain that finishes the job.
 *
 * The ordering this module exists to enforce — see the ⚠️ on `spendProof` and
 * the header of cashuSettlement.ts:
 *
 *   1. read the slot (GET_PROOF — nonce only; the card never returns secrets)
 *   2. rebuild the NUT-10 secret from nonce + card pubkey
 *   3. SPEND_PROOF — the card burns the slot *before* returning the witness
 *   4. recordSpend — the durable record that lets the UI say "paid"
 *
 * Step 3 is irreversible. If it throws, the slot may be burned with the
 * signature lost, so the orchestrator re-reads the slot: burned → record the
 * entry as `needs-card` (recovery via `resignWitness` on the next tap); still
 * unspent → the burn never happened and the error is surfaced normally.
 * Recording a `needs-card` entry for a slot that was never burned would show
 * the merchant an exposure that does not exist.
 */
import {sha256} from '@noble/hashes/sha256';
import {utf8ToBytes} from '@noble/hashes/utils';

import {
  getProof,
  getPubkey,
  getSlotStatuses,
  spendProof,
  toHex,
  type CardProofSlot,
  type Transceiver,
} from './cashuCard';
import {buildCardP2PKSecret, createSettlementAdapter} from './cashuMint';
import {
  drainQueue,
  recordSpend,
  type DrainResult,
  type SettlementEntry,
} from './cashuSettlement';

export const DEFAULT_UNIT = 'sat';

/**
 * The first spendable slot on the card, read in full, or null when every
 * non-empty slot is already spent.
 */
export async function firstUnspentSlot(
  transceive: Transceiver,
  maxSlots: number,
): Promise<CardProofSlot | null> {
  const statuses = await getSlotStatuses(transceive, maxSlots);
  const index = statuses.findIndex(status => status === 'unspent');
  if (index === -1) {
    return null;
  }
  return getProof(transceive, index);
}

export interface BurnAndRecordArgs {
  transceive: Transceiver;
  slot: number;
  mintUrl: string;
  unit?: string;
  now?: number;
}

/**
 * Spend one slot and durably record the settlement it is owed.
 *
 * Resolves with the queue entry — at that point the payment may be approved to
 * the customer: the witness (or its loss, as `needs-card`) is on disk.
 */
export async function burnAndRecord({
  transceive,
  slot,
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
}: BurnAndRecordArgs): Promise<SettlementEntry> {
  const proof = await getProof(transceive, slot);
  if (proof.status !== 'unspent') {
    throw new Error(
      `slot ${slot} is ${proof.status}; refusing to spend it again`,
    );
  }
  const cardPubkey = toHex(await getPubkey(transceive));
  return burnPlannedSlot({
    transceive,
    proof,
    cardPubkey,
    mintUrl,
    unit,
    now,
  });
}

/**
 * Burn one ALREADY-PLANNED slot and record it, with the burn-ambiguity
 * recovery. Shared by the single-slot flow and the multi-slot charge: an
 * APDU failure mid-burn must never leave a burned slot unrecorded — the
 * card re-read decides between a `needs-card` entry (burn landed, signature
 * lost) and surfacing the error (burn never happened).
 */
export async function burnPlannedSlot({
  transceive,
  proof,
  cardPubkey,
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
}: {
  transceive: Transceiver;
  proof: CardProofSlot;
  cardPubkey: string;
  mintUrl: string;
  unit?: string;
  now?: number;
}): Promise<SettlementEntry> {
  const secret = buildCardP2PKSecret(proof.nonce, cardPubkey);
  const message = Array.from(sha256(utf8ToBytes(secret)));

  let witness: string | undefined;
  try {
    witness = toHex(await spendProof(transceive, proof.slot, message));
  } catch (error) {
    // The burn may or may not have landed before the failure. Only a slot the
    // card now reports as spent becomes a `needs-card` entry.
    const after = await getProof(transceive, proof.slot).catch(() => null);
    if (!after || after.status !== 'spent') {
      throw error;
    }
  }

  return recordSpend(
    {
      cardPubkey,
      slot: proof.slot,
      keysetId: proof.keysetId,
      mintUrl,
      unit,
      amount: proof.amount,
      nonce: proof.nonce,
      secret,
      C: proof.C,
      ...(witness ? {witness} : {}),
    },
    now,
  );
}

/**
 * Drain the settlement queue against `mintUrl`.
 *
 * Each entry is settled against the mint that issued its proof (see
 * `SettlementEntry.mintUrl`) — a queue holding entries from several mints
 * drains correctly in one pass.
 */
export async function settlePending(now = Date.now()): Promise<DrainResult> {
  const adapter = createSettlementAdapter();
  return drainQueue(adapter.swap, now, {checkState: adapter.checkState});
}
