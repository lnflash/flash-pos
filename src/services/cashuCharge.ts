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
  appendSettledProofsTill,
  mintChargeChange,
} from './cashuMint';
import {burnPlannedSlot} from './cashuSpend';
import {
  markEntriesSettled,
  type SettlementEntry,
} from './cashuSettlement';

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
 * Session 1: read the card and rank the covers — NO PIN yet. The customer's
 * card is only on the antenna for the silent read; a PIN-required card gets
 * the pad afterwards (tap → PIN → tap, D13's session flag is satisfied by the
 * fresh verify inside session 2).
 */
/**
 * Session 1: read the card and rank the covers — NO PIN yet. The customer's
 * card is only on the antenna for the silent read; a PIN-required card gets
 * the pad afterwards (tap → PIN → tap, D13's session flag is satisfied by the
 * fresh verify inside session 2).
 */
export interface PreReadCharge {
  plan: PurchasePlan;
  unspent: CardProofSlot[];
  cardPubkey: string;
  pinRequired: boolean;
}

export async function readAndPlan({
  transceive,
  amountSat,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  amountSat: number;
  onPhase?: (phase: string) => void;
}): Promise<PreReadCharge> {
  const step = async <T,>(phase: string, fn: () => Promise<T>): Promise<T> => {
    onPhase(phase);
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${phase}] ${message}`);
    }
  };

  await step('reading card', () => selectApplet(transceive));
  const info = await step('reading card', () => getInfo(transceive));
  if (info.pinState === 'locked') {
    throw new Error('card PIN is blocked — the card must be re-provisioned');
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

  const plans = planPurchase(unspent, amountSat);
  if (plans.length === 0) {
    throw new Error(
      `card holds ${unspent.reduce((t, p) => t + p.amount, 0)} sat; the bill is ${amountSat} sat`,
    );
  }
  return {
    plan: plans[0],
    cardPubkey,
    pinRequired: info.pinState === 'set',
    unspent,
  };
}

/**
 * The one-session charge used by the dev harness: readAndPlan + executeCharge
 * composed into a single session (the PIN, when required, must be provided
 * up front).
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
  const {plan, unspent, cardPubkey, pinRequired} = await readAndPlan({
    transceive,
    amountSat,
    onPhase,
  });
  if (pinRequired && !pin) {
    throw new Error('this card has a PIN — ask the customer for it before tapping');
  }
  return executeCharge({
    transceive,
    amountSat,
    plan,
    unspent,
    cardPubkey,
    pin,
    pinRequired,
    mintUrl,
    unit,
    now,
    onPhase,
  });
}

export interface ExecuteChargeArgs {
  transceive: Transceiver;
  amountSat: number;
  plan: PurchasePlan;
  unspent: CardProofSlot[];
  cardPubkey: string;
  pin?: string;
  pinRequired: boolean;
  mintUrl: string;
  unit?: string;
  now?: number;
  onPhase?: (phase: string) => void;
}

/**
 * The money leg: verify the PIN if the card has one, burn the planned slots,
 * settle + mint change in the atomic swap, write the change onto the card.
 */
export async function executeCharge({
  transceive,
  amountSat,
  plan,
  unspent,
  cardPubkey,
  pin,
  pinRequired,
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
  onPhase = () => {},
}: ExecuteChargeArgs): Promise<ChargeResult> {
  const step = async <T,>(phase: string, fn: () => Promise<T>): Promise<T> => {
    onPhase(phase);
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${phase}] ${message}`);
    }
  };

  // Session 2 opens a FRESH IsoDep channel: the card's active applet resets
  // to the default, so the applet SELECT must run again before any gated
  // command — without it Android answers 0x6E00 (CLA not supported) for
  // every verify/burn. Idempotent for the one-session wrapper.
  await step('reading card', () => selectApplet(transceive));

  if (pinRequired) {
    if (!pin) {
      throw new Error('this card has a PIN — ask the customer for it');
    }
    await step('verifying PIN', () => verifyCardPin(transceive, pin));
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
  const changeSat = plan.changeSat;
  // ONE ATOMIC SWAP is the whole online settlement: the burned proofs
  // (witnessed) go in; the outputs come out as P2PK change for THIS card
  // plus the merchant's take. The till never gates anything — change of
  // any size is possible by construction while online. Exact bills
  // (changeSat = 0) settle here too — deferring them to the drain left the
  // merchant's money queued on a silent drain failure. OFFLINE: the swap
  // throws and, when nothing must be written back onto the card this
  // session, the entries hold in the queue for the next online auto-run
  // (the change write follows on the card's next tap).
  const witnessed = burned.map(e => ({
    id: e.keysetId,
    keysetId: e.keysetId,
    amount: e.amount,
    secret: e.secret,
    C: e.C,
    // NUT-11 witness envelope — the raw SPEND_PROOF signature wrapped the
    // way the mint's verification expects.
    witness: JSON.stringify({signatures: [e.witness]}),
  }));
  let minted: Awaited<ReturnType<typeof mintChargeChange>> | null = null;
  try {
    minted = await step('settling payment and minting change', () =>
      mintChargeChange({
        mintUrl,
        entries: witnessed,
        changeSat,
        p2pkPubkey: cardPubkey,
      }),
    );
  } catch (error) {
    if (changeSat > 0) {
      throw error;
    }
    // Exact bill: no card write is pending, so a failed swap costs the
    // customer nothing — the entries stay 'pending' in the queue and the
    // drain settles (and pays out) on its next run.
    minted = null;
  }

  if (minted) {
    // The swap consumed the burned proofs: mark the entries settled.
    await markEntriesSettled(
      burned.map(e => e.id),
      now,
    );
    // The merchant's take joins the till (the sweep melts it above the
    // float reserve to the account address).
    await appendSettledProofsTill(minted.till);

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
