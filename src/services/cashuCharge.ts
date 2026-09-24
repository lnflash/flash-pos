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
import {
  getBalance,
  getInfo,
  getProof,
  getSlotStatuses,
  getPubkey,
  loadProof,
  selectApplet,
  verifyCardPin,
  toHex,
  type CardProofSlot,
  type Transceiver,
} from './cashuCard';
import {
  listSettledProofs,
  makeChangeOnTill,
  rebalanceTill,
  selectChangeFromTill,
} from './cashuMint';
import {burnPlannedSlot} from './cashuSpend';
import type {SettlementEntry} from './cashuSettlement';

export const DEFAULT_UNIT = 'sat';

/**
 * Rank the ways to cover `amountSat` from the card's unspent slots, cheapest
 * change first. A proof is atomic, so "enter amount" means coin selection:
 * exact subsets when the denominations allow, otherwise the smallest
 * over-cover. Greedy largest-first is NOT among the strategies — burning a
 * 256-sat proof for a 14-sat bill would demand 242 sat of change from a till
 * that may hold pocket change (found in the field).
 *
 * Candidates are deduplicated by slot-set and sorted by change; the caller
 * walks them until the till can back one.
 */
export interface PurchasePlan {
  slots: number[];
  burnedSat: number;
  changeSat: number;
}

export function planPurchase(
  unspent: CardProofSlot[],
  amountSat: number,
): PurchasePlan[] {
  if (amountSat <= 0) {return [];}
  const total = unspent.reduce((t, p) => t + p.amount, 0);
  if (total < amountSat) {return [];}

  const candidates: PurchasePlan[] = [];

  // 1. Exact subsets: DP over reachable sums, fewest-slot witness each.
  const reach: (number[] | null)[] = new Array(total + 1).fill(null);
  reach[0] = [];
  for (const p of unspent) {
    for (let s = total; s >= p.amount; s--) {
      const prev = reach[s - p.amount];
      if (prev !== null && reach[s] === null) {
        reach[s] = [...prev, p.slot];
      }
    }
  }
  for (let sum = amountSat; sum <= total; sum++) {
    if (reach[sum]) {
      candidates.push({
        slots: reach[sum]!,
        burnedSat: sum,
        changeSat: sum - amountSat,
      });
    }
  }

  // 2. The smallest single proof that covers the bill.
  const ascending = [...unspent].sort((a, b) => a.amount - b.amount);
  const single = ascending.find(p => p.amount >= amountSat);
  if (single) {
    candidates.push({
      slots: [single.slot],
      burnedSat: single.amount,
      changeSat: single.amount - amountSat,
    });
  }

  // 3. Ascending accumulation: the smallest overage from mixed small proofs.
  let sum = 0;
  const acc: number[] = [];
  for (const p of ascending) {
    if (sum >= amountSat) {break;}
    acc.push(p.slot);
    sum += p.amount;
  }
  if (sum >= amountSat) {
    candidates.push({slots: acc, burnedSat: sum, changeSat: sum - amountSat});
  }

  // Dedupe by slot-set, cheapest change first, fewest slots as tiebreak.
  const seen = new Set<string>();
  return candidates
    .sort(
      (a, b) => a.changeSat - b.changeSat || a.slots.length - b.slots.length,
    )
    .filter(c => {
      const key = [...c.slots].sort((x, y) => x - y).join(',');
      if (seen.has(key)) {return false;}
      seen.add(key);
      return true;
    })
    .slice(0, 8);
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
  /** Progress callback — the trust surface: the screen renders exactly where
   *  the charge is, and an error names the step it died on. */
  onPhase?: (phase: string) => void;
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
  onPhase = () => {},
}: ChargeArgs): Promise<ChargeResult> {
  const step = async <T,>(phase: string, fn: () => Promise<T>): Promise<T> => {
    onPhase(phase);
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${phase}] ${message}`);
    }
  };

  // D13: one VERIFY covers spend AND load for this session.
  await step('reading card', () => selectApplet(transceive));
  const info = await step('reading card', () => getInfo(transceive));
  if (info.pinState === 'locked') {
    throw new Error('card PIN is blocked — the card must be re-provisioned');
  }
  if (info.pinState === 'set') {
    if (!pin) {
      throw new Error(
        'this card has a PIN — ask the customer for it before tapping',
      );
    }
    await step('verifying PIN', () => verifyCardPin(transceive, pin));
  }

  const statuses = await step('reading card', () =>
    getSlotStatuses(transceive, info.maxSlots),
  );
  const unspent: CardProofSlot[] = [];
  for (let slot = 0; slot < statuses.length; slot++) {
    if (statuses[slot] === 'unspent') {
      unspent.push(await step('reading card', () => getProof(transceive, slot)));
    }
  }
  const cardPubkey = await step('reading card', () =>
    getPubkey(transceive).then(toHex),
  );

  // The till must be able to make the change EXACTLY before any burn — a plan
  // whose change fails later would leave the customer stranded. When the till
  // is short and the device is ONLINE, one rebalance (a self-swap breaking a
  // proof into the needed denominations) is attempted before giving up;
  // offline, the rebalance fails harmlessly and the refusal stands.
  const planWith = (
    tillProofs: Awaited<ReturnType<typeof listSettledProofs>>,
  ): PurchasePlan | {error: string; changeSatHint?: number} => {
    const candidates = planPurchase(unspent, amountSat);
    if (candidates.length === 0) {
      return {
        error: `card holds ${unspent.reduce(
          (t, p) => t + p.amount,
          0,
        )} sat; the bill is ${amountSat} sat`,
      };
    }
    let minChange: number | undefined;
    for (const candidate of candidates) {
      if (candidate.changeSat === 0) {
        return candidate;
      }
      minChange ??= candidate.changeSat;
      if (selectChangeFromTill(tillProofs, candidate.changeSat) !== null) {
        return candidate;
      }
    }
    return {
      error: `the till cannot make ${minChange} sat exact change — ask for a different card`,
      changeSatHint: minChange,
    };
  };

  onPhase('planning');

  let till = await listSettledProofs();
  let plan = planWith(till);
  if ('error' in plan) {
    // ONLINE recovery: reshape the till, then plan once more. Offline the
    // rebalance fails harmlessly and the refusal stands.
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
  for (const [index, slot] of plan.slots.entries()) {
    const proof = unspent.find(p => p.slot === slot)!;
    // The shared burn-with-recovery: an APDU glitch mid-burn records the slot
    // as needs-card instead of losing it (found in the field: a CoreNFC
    // framing error burned a 16-sat slot and the value went unrecorded).
    burned.push(
      await step(
        `burning ${proof.amount} sat (proof ${index + 1}/${plan.slots.length})`,
        () =>
          burnPlannedSlot({
            transceive,
            proof,
            cardPubkey,
            mintUrl,
            unit,
            now,
          }),
      ),
    );
  }

  let changeLoaded = 0;
  const changeSat = plan.changeSat; // narrowed: all error plans threw above
  if (changeSat > 0) {
    const minted = await step('making change', () =>
      makeChangeOnTill({
        mintUrl,
        changeSat,
        p2pkPubkey: cardPubkey,
      }),
    );
    if (!minted.ok) {
      // The burns are done and recorded (the full burned value settles
      // regardless) — but the UI must not claim change was given.
      throw new Error(
        `payment recorded, but change could not be written: ${minted.reason}`,
      );
    }
    for (const proof of minted.change) {
      await step('writing change to card', () =>
        loadProof(transceive, {
          keysetId: proof.id,
          amount: proof.amount,
          nonce: nonceFromSecret(proof.secret),
          C: proof.C,
        }),
      );
      changeLoaded += 1;
    }
  }

  const balanceAfter = await step('reading card', () =>
    getBalance(transceive),
  );
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
