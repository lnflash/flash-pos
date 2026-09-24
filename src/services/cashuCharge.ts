/**
 * Model B charging: the merchant enters an amount, the customer taps, the
 * terminal spends exactly enough of the card and makes change from the till.
 *
 * Why the till and not the mint: a Cashu proof is atomic — a 16-sat proof
 * cannot pay 10 sat. Change is new mint-signed proofs, and the mint only
 * signs over the network. So change comes from the terminal's own float
 * (small-denomination proofs already held in the settled store), which the
 * auto-pipeline keeps stocked while ONLINE. That makes the entire purchase
 * work OFFLINE: PIN verify, burn, change — all on-card plus local state.
 *
 * Ordering guarantees (same family as cashuSpend):
 *   - the PIN gate runs before anything: verify in-session first, so a wrong
 *     PIN never burns a slot;
 *   - the burn plan is computed BEFORE any burn — a plan whose change the
 *     till cannot cover is refused up front rather than stranding the
 *     customer mid-transaction;
 *   - change is staged from the till (pending record) before the LOADs, and
     committed only after every LOAD succeeds — a failed load leaves the
 *     till intact and the error surfaces.
 */
import {sha256} from '@noble/hashes/sha256';
import {utf8ToBytes} from '@noble/hashes/utils';

import {
  getInfo,
  getProof,
  getBalance,
  getSlotStatuses,
  getPubkey,
  loadProof,
  selectApplet,
  spendProof,
  verifyCardPin,
  toHex,
  type CardProofSlot,
  type Transceiver,
} from './cashuCard';
import {
  buildCardP2PKSecret,
  listSettledProofs,
  rebalanceTill,
  selectChangeFromTill,
  stageChangeFromTill,
} from './cashuMint';
import {recordSpend, type SettlementEntry} from './cashuSettlement';

export const DEFAULT_UNIT = 'sat';

/**
 * Pick the slots to burn: an exact subset when one exists (DP over ≤32 slots),
 * otherwise the smallest over-cover whose change the till can make.
 * Returns null with a reason when nothing fits.
 */
export function planPurchase(
  unspent: CardProofSlot[],
  amountSat: number,
  tillCoverableSat: number,
): {slots: number[]; burnedSat: number; changeSat: number} | {error: string; changeSatHint?: number} {
  if (amountSat <= 0) {
    return {error: 'amount must be positive'};
  }
  // Exact subsets first: DP over reachable sums, tracking one witness path.
  const reachable: (number[] | null)[] = new Array(amountSat + 1).fill(null);
  reachable[0] = [];
  for (const p of unspent) {
    for (let s = amountSat; s >= p.amount; s--) {
      const prev = reachable[s - p.amount];
      if (prev !== null && reachable[s] === null) {
        reachable[s] = [...prev, p.slot];
      }
    }
  }
  if (reachable[amountSat] !== null) {
    return {slots: reachable[amountSat]!, burnedSat: amountSat, changeSat: 0};
  }
  // Smallest over-cover: greedy largest-first is near-minimal and simple; the
  // change it implies must be within the till's capacity.
  const sorted = [...unspent].sort((a, b) => b.amount - a.amount);
  let sum = 0;
  const slots: number[] = [];
  for (const p of sorted) {
    if (sum >= amountSat) {break;}
    slots.push(p.slot);
    sum += p.amount;
  }
  if (sum < amountSat) {
    return {error: `card holds ${sum} sat; the bill is ${amountSat} sat`};
  }
  const changeSat = sum - amountSat;
  if (changeSat > tillCoverableSat) {
    return {
      error:
        `change would be ${changeSat} sat but the till holds ${tillCoverableSat} sat — ` +
        'ask for a different card (exact change settles offline too)',
      changeSatHint: changeSat,
    };
  }
  return {slots, burnedSat: sum, changeSat};
}

export interface ChargeArgs {
  transceive: Transceiver;
  amountSat: number;
  /** The CUSTOMER's card PIN — required only when their card has one. The
   *  terminal learns that from GET_INFO.pinState and prompts accordingly. */
  pin?: string;
  mintUrl: string;
  unit?: string;
  now?: number;
}

export interface ChargeResult {
  amountSat: number;
  burned: SettlementEntry[];
  changeSat: number;
  changeLoaded: number;
  balanceAfter: number;
}

/**
 * The full in-session charge: verify PIN → read the card → plan → burn →
 * change from the till → load change back onto the card. Everything needs the
 * customer's card in the field and nothing needs the network — the settlement
 * and sweep happen afterwards through the normal auto-pipeline.
 */
export async function chargeCard({
  transceive,
  amountSat,
  pin,
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
}: ChargeArgs): Promise<ChargeResult> {
  // D13: one VERIFY covers spend AND load for this session.
  await selectApplet(transceive);
  const info = await getInfo(transceive);
  if (info.pinState === 'locked') {
    throw new Error('card PIN is blocked — the card must be re-provisioned');
  }
  if (info.pinState === 'set') {
    if (!pin) {
      throw new Error(
        'this card has a PIN — ask the customer for it before tapping',
      );
    }
    await verifyCardPin(transceive, pin);
  }

  const statuses = await getSlotStatuses(transceive, info.maxSlots);
  const unspent: CardProofSlot[] = [];
  for (let slot = 0; slot < statuses.length; slot++) {
    if (statuses[slot] === 'unspent') {
      unspent.push(await getProof(transceive, slot));
    }
  }
  const cardPubkey = toHex(await getPubkey(transceive));

  // The till must be able to make the change EXACTLY before any burn — a plan
  // whose change fails later would leave the customer stranded. When the till
  // is short and the device is ONLINE, one rebalance (a self-swap breaking a
  // proof into the needed denominations) is attempted before giving up;
  // offline, the rebalance fails harmlessly and the refusal stands.
  const planWith = (
    tillProofs: Awaited<ReturnType<typeof listSettledProofs>>,
  ): {slots: number[]; burnedSat: number; changeSat: number} | {error: string; changeSatHint?: number} => {
    const candidate = planPurchase(
      unspent,
      amountSat,
      tillProofs.reduce((t, p) => t + p.amount, 0),
    );
    if ('error' in candidate) {
      return {error: candidate.error, changeSatHint: candidate.changeSatHint};
    }
    if (
      candidate.changeSat > 0 &&
      selectChangeFromTill(tillProofs, candidate.changeSat) === null
    ) {
      return {
        error: `the till cannot make ${candidate.changeSat} sat exact change — ask for a different card`,
      };
    }
    return candidate;
  };

  let till = await listSettledProofs();
  let plan = planWith(till);
  if ('error' in plan) {
    // ONLINE recovery: reshape the till, then plan once more.
    try {
      await rebalanceTill(mintUrl, 'changeSatHint' in plan ? plan.changeSatHint : 0);
      till = await listSettledProofs();
      plan = planWith(till);
    } catch {
      // Offline or mint unreachable — the refusal stands.
    }
  }
  if ('error' in plan) {
    throw new Error(plan.error);
  }

  const burned: SettlementEntry[] = [];
  for (const slot of plan.slots) {
    const proof = unspent.find(p => p.slot === slot)!;
    const secret = buildCardP2PKSecret(proof.nonce, cardPubkey);
    const message = Array.from(sha256(utf8ToBytes(secret)));
    const witness = toHex(await spendProof(transceive, slot, message));
    burned.push(
      await recordSpend(
        {
          cardPubkey,
          slot,
          keysetId: proof.keysetId,
          mintUrl,
          unit,
          amount: proof.amount,
          nonce: proof.nonce,
          secret,
          C: proof.C,
          witness,
        },
        now,
      ),
    );
  }

  let changeLoaded = 0;
  if (plan.changeSat > 0) {
    const staged = await stageChangeFromTill(plan.changeSat);
    if (!staged.ok) {
      // The burns are done and recorded; the till shortfall becomes a
      // settlement-side fact (the full burned value settles regardless).
      // Surface it — the UI must not tell the customer change was given.
      throw new Error(
        `payment recorded, but change could not be written: ${staged.reason}`,
      );
    }
    try {
      for (const proof of staged.proofs) {
        await loadProof(transceive, {
          keysetId: proof.id,
          amount: proof.amount,
          nonce: proof.secret ? nonceFromSecret(proof.secret) : '',
          C: proof.C,
        });
        changeLoaded += 1;
      }
      await staged.commit();
    } catch (error) {
      // Till intact (pending record still set): the change proofs are safe
      // and can be re-attempted on the customer's next tap.
      await staged.abort();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  const balanceAfter = await getBalance(transceive);
  return {
    amountSat,
    burned,
    changeSat: plan.changeSat,
    changeLoaded,
    balanceAfter,
  };
}

/**
 * The nonce lives inside the P2PK secret this terminal built; recover it for
 * the LOAD. (Till proofs carry secrets of the canonical shape this service
 * writes — non-standard secrets cannot be re-loaded, which is fine: they were
 * never this terminal's change.)
 */
function nonceFromSecret(secret: string): string {
  try {
    const parsed = JSON.parse(secret) as [{kind: string}, {nonce: string}];
    return parsed[1].nonce;
  } catch {
    throw new Error('till proof has a non-canonical secret; cannot write change');
  }
}
