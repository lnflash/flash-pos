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
  resignWitness,
  selectApplet,
  verifyCardPin,
  toHex,
  type CardProofSlot,
  type SlotStatus,
  type Transceiver,
} from './cashuCard';
import {appendSettledProofsTill, mintChargeChange} from './cashuMint';
import {burnPlannedSlot} from './cashuSpend';
import {
  attachRecoveredWitness,
  listSettlements,
  markEntriesSettled,
  markOwedChangeAttemptFailed,
  markOwedChangeSending,
  markOwedChangeWritten,
  nonceFromSecret,
  outstandingChangeForCard,
  owedChangeId,
  recordOwedChange,
  type OwedChangeEntry,
  type SettlementEntry,
} from './cashuSettlement';
import {pow2PieceCount} from '../utils/denominations';

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
  if (amountSat <= 0) {
    return [];
  }
  const total = unspent.reduce((t, p) => t + p.amount, 0);
  if (total < amountSat) {
    return [];
  }

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
    if (sum >= amountSat) {
      break;
    }
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
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

/**
 * The first plan (in `planPurchase`'s order, cheapest change first) whose
 * change fits the card's free slots: the mint mints change in power-of-two
 * pieces and the card takes one slot per piece, so a plan whose change needs
 * more slots than the card has free would burn and then strand the change.
 * An exact plan (`changeSat` 0) always fits. `null` when none does.
 */
export function selectFittingPlan(
  plans: PurchasePlan[],
  freeSlots: number,
): PurchasePlan | null {
  return plans.find(p => pow2PieceCount(p.changeSat) <= freeSlots) ?? null;
}

/**
 * Settle the owed-change record against what the card actually holds.
 * Read-only on the card. Nothing owed → `[]` without an APDU. Otherwise
 * every non-empty slot (spent too — a lost LOAD answer leaves a piece on the
 * card that the record still calls owed, and a spent slot is still
 * readable) is read and any owed piece whose nonce is already on the card is
 * marked written; the rest come back and are what the next write sends.
 * The card does not dedup a LOAD, so this must run before any re-send.
 *
 * `known` is what the caller has already pulled off the card this session
 * (`readAndPlan` reads every unspent slot before it gets here): those slots
 * are seeded from memory and not read again — up to 32 GET_PROOFs of ~80
 * bytes each, hundreds of ms of extra hold on CoreNFC for data already in
 * hand. Only the spent slots and any non-empty slot not in `known` cost an
 * APDU.
 */
export async function reconcileOwedChange({
  transceive,
  cardPubkey,
  statuses,
  known = [],
  now,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  cardPubkey: string;
  statuses: SlotStatus[];
  known?: CardProofSlot[];
  now: number;
  onPhase?: (phase: string) => void;
}): Promise<OwedChangeEntry[]> {
  const owed = await outstandingChangeForCard(cardPubkey);
  if (owed.length === 0) {
    return [];
  }
  const step = makeStep(onPhase);
  const onCard = new Map<string, number>();
  const seeded = new Set<number>();
  for (const proof of known) {
    if (statuses[proof.slot] !== 'empty') {
      onCard.set(proof.nonce, proof.slot);
      seeded.add(proof.slot);
    }
  }
  for (let slot = 0; slot < statuses.length; slot++) {
    if (statuses[slot] !== 'empty' && !seeded.has(slot)) {
      const proof = await step('reading card', () =>
        getProof(transceive, slot),
      );
      onCard.set(proof.nonce, slot);
    }
  }
  const remaining: OwedChangeEntry[] = [];
  let markRefused = false;
  for (const entry of owed) {
    const slot = onCard.get(entry.nonce);
    if (slot === undefined) {
      remaining.push(entry);
      continue;
    }
    try {
      await markOwedChangeWritten(entry.id, slot, now);
    } catch (error) {
      // The piece is on the card: it is NOT owed, whatever the store will
      // take right now, so it stays out of `remaining`. A stale 'owed'
      // record is harmless because every path that writes owed change
      // (`readAndPlan`, `executeCharge`'s retry gate, the keypad reader)
      // reconciles against the card first, so a stale record is never sent
      // without a read. That invariant — not the attempt count — is what
      // keeps a duplicate off the card: the bill's own change in
      // `executeCharge` is LOADed with `attempts` still 0, so an unconditional
      // reconcile is load-bearing. `writeOwedChange` and `executeCharge`
      // tolerate the same refusal the same way. From `readAndPlan` this runs
      // outside `step`: a throw here would refuse a charge the card can
      // physically take, with a raw store error for a title.
      if (!markRefused) {
        markRefused = true;
        console.warn(
          '[charge] owed change found on the card but its written mark was refused; leaving the stale record for the next reconcile',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  return remaining;
}

/** The phase string `writeOwedChange` emits per piece; `phaseToStation` keys on it. */
export const owedChangePhase = (amount: number): string =>
  `adding ${amount} sat of change owed from an earlier charge`;

/** The change-write phase as `executeCharge` emits it; `phaseToStation` keys on it. */
export const PHASE_WRITING_CHANGE = 'writing change to card';

/**
 * The phase a change-write failure is reported under when the owed-change
 * record did NOT land first. The phase emitted to the stage is unchanged
 * (`PHASE_WRITING_CHANGE`); only the thrown `PhaseError` carries this, so the
 * UI can tell "saved, written on the next tap" from "not saved anywhere"
 * and never claims the first when the second is true.
 */
export const PHASE_WRITING_CHANGE_UNRECORDED =
  'writing change to card (unrecorded)';

/**
 * Write change owed from an earlier charge onto the card, piece by piece,
 * marking each written as the card answers. A piece the card refuses (a
 * `6A84` — no free slot — or a lost tag) stays owed with the attempt
 * recorded, and the error surfaces as a `PhaseError` so the caller can
 * class it. Run after the PIN verify (LOAD_PROOF is PIN-gated) and before
 * any burn, so a failure here is a clean refusal with nothing taken.
 *
 * Resolves with the pieces this call put on the card — and ONLY those. It
 * resolves short, without throwing, when the store refuses the write-ahead
 * mark: nothing is sent for that piece or the rest. A caller that tells the
 * customer what was added must read it from the result, never from `owed`.
 */
export async function writeOwedChange({
  transceive,
  owed,
  now,
  onPhase = () => {},
}: {
  transceive: Transceiver;
  owed: OwedChangeEntry[];
  now: number;
  onPhase?: (phase: string) => void;
}): Promise<OwedChangeEntry[]> {
  const written: OwedChangeEntry[] = [];
  for (const entry of owed) {
    const phase = owedChangePhase(entry.amount);
    onPhase(phase);
    // Write-ahead: the attempt is counted BEFORE the LOAD goes out. The card
    // does not dedup a LOAD, so whatever fails after this point — the
    // answer lost, the `written` mark refused by the keychain, the process
    // killed — the next try sees `attempts > 0` and reads the card before
    // sending this piece again. If the store will not take the mark,
    // nothing is sent: this piece and the rest stay `owed` for a later tap
    // (writing nothing is the safe side; writing a duplicate is not).
    try {
      await markOwedChangeSending(entry.id, now);
    } catch (error) {
      console.warn(
        '[charge] owed-change attempt could not be recorded; leaving the rest owed for a later tap',
        error instanceof Error ? error.message : String(error),
      );
      return written;
    }
    let slot: number;
    try {
      slot = await loadProof(transceive, {
        keysetId: entry.keysetId,
        amount: entry.amount,
        nonce: entry.nonce,
        C: entry.C,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await markOwedChangeAttemptFailed(entry.id, reason, now);
      } catch {
        // The entry stays 'owed' on disk either way; the reason is
        // bookkeeping and must not mask the card's answer.
      }
      throw new PhaseError(phase, error);
    }
    try {
      await markOwedChangeWritten(entry.id, slot, now);
    } catch {
      // The piece is on the card. A stale 'owed' record is harmless: the
      // attempt was counted ahead, so the next try reconciles and finds the
      // nonce in its slot before it could send a duplicate.
    }
    written.push(entry);
  }
  return written;
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
 * A failure inside one phase of a charge. The message carries the phase for
 * the merchant-facing log ("[reading card] SELECT failed: ..."); `cause` keeps
 * the original error — a `CardError` with its status word, for one — so
 * callers branch on the class, not on the wording.
 *
 * Declared as a field rather than passed as `new Error(message, {cause})`:
 * Hermes supports `cause`, but the React Native tsconfig's `lib` stops short
 * of `es2022.error`, which is where that overload and `Error.cause` are typed.
 */
export class PhaseError extends Error {
  readonly cause: unknown;

  constructor(phase: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`[${phase}] ${message}`);
    this.name = 'PhaseError';
    this.cause = cause;
  }
}

const makeStep =
  (onPhase: (phase: string) => void) =>
  async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    onPhase(phase);
    try {
      return await fn();
    } catch (error) {
      throw new PhaseError(phase, error);
    }
  };

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
  /**
   * Change from an earlier charge this card is still owed, does not yet
   * hold, and has a free slot for AFTER the bill's own change is placed.
   * `executeCharge` writes it first, so it is counted against the card's
   * empty slots when the plan is chosen — but the bill wins: when no plan
   * fits beside the owed pieces, the bill takes the empties and only the
   * owed pieces with room left are here. The others stay `owed` on disk
   * for a later tap and never refuse a charge the card can physically take.
   */
  owedChange: OwedChangeEntry[];
}

export async function readAndPlan({
  transceive,
  amountSat,
  now = Date.now(),
  onPhase = () => {},
}: {
  transceive: Transceiver;
  amountSat: number;
  now?: number;
  onPhase?: (phase: string) => void;
}): Promise<PreReadCharge> {
  const step = makeStep(onPhase);

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
      unspent.push(
        await step('reading card', () => getProof(transceive, slot)),
      );
    }
  }
  const cardPubkey = await step('reading card', () =>
    getPubkey(transceive).then(toHex),
  );

  const plans = planPurchase(unspent, amountSat);
  if (plans.length === 0) {
    throw new Error(
      `card holds ${unspent.reduce(
        (t, p) => t + p.amount,
        0,
      )} sat; the bill is ${amountSat} sat`,
    );
  }

  // Slot pre-flight, BEFORE anything burns: the change is written one slot
  // per power-of-two piece, and a LOAD the card answers 6A84 (no free slot)
  // after the swap strands mint-signed change (field-found: ENG-630). Change
  // still owed from an earlier charge is written first, as much of it as the
  // card has room for, and takes those slots off the top.
  const emptySlots = statuses.filter(s => s === 'empty').length;
  const stillOwed = await reconcileOwedChange({
    transceive,
    cardPubkey,
    statuses,
    known: unspent,
    now,
    onPhase,
  });
  // The bill comes first. Owed change is written this tap only out of the
  // slots the bill's own change does not need; the rest stays 'owed' on
  // disk for a later tap. Owed change must never refuse a charge on its
  // own: a card that reported one empty slot and could physically take the
  // change must not be declined because an earlier piece wanted that slot
  // (an exact bill needs no slot, and the card ENG-630 came from — full,
  // with change owed — has to be able to pay again). So: try the plan with
  // the owed pieces counted first; when nothing fits, give the bill every
  // empty slot and write only the owed pieces that still have room.
  let owedChange = stillOwed.slice(0, emptySlots);
  let plan = selectFittingPlan(plans, emptySlots - owedChange.length);
  if (!plan) {
    plan = selectFittingPlan(plans, emptySlots);
    if (!plan) {
      throw new Error(
        `this card is full: ${
          plans[0].changeSat
        } sat of change needs ${pow2PieceCount(
          plans[0].changeSat,
        )} free slots and the card has ${emptySlots}`,
      );
    }
    owedChange = stillOwed.slice(
      0,
      emptySlots - pow2PieceCount(plan.changeSat),
    );
  }
  return {
    plan,
    cardPubkey,
    pinRequired: info.pinState === 'set',
    unspent,
    owedChange,
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
  const {plan, unspent, cardPubkey, pinRequired, owedChange} =
    await readAndPlan({
      transceive,
      amountSat,
      now,
      onPhase,
    });
  if (pinRequired && !pin) {
    throw new Error(
      'this card has a PIN — ask the customer for it before tapping',
    );
  }
  return executeCharge({
    transceive,
    amountSat,
    plan,
    unspent,
    cardPubkey,
    pin,
    pinRequired,
    owedChange,
    mintUrl,
    unit,
    now,
    onPhase,
  });
}

/**
 * The STORE's entries for the subset of `owedChange` it still calls `owed`
 * on this card, in the caller's order — the store's, not the caller's
 * snapshot, so `attempts` is live and the caller can tell a first write from
 * a retry. `[]` when the store cannot be read: writing nothing is the safe
 * side (a later tap reconciles), writing a duplicate is not.
 */
async function stillOwedOf(
  cardPubkey: string,
  owedChange: OwedChangeEntry[],
): Promise<OwedChangeEntry[]> {
  let live: Map<string, OwedChangeEntry>;
  try {
    live = new Map(
      (await outstandingChangeForCard(cardPubkey)).map(e => [e.id, e]),
    );
  } catch (error) {
    console.warn(
      '[charge] owed-change store unreadable; skipping the owed write this tap',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
  return owedChange.flatMap(e => {
    const entry = live.get(e.id);
    return entry ? [entry] : [];
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
  /** From `readAndPlan`: change still owed to this card, written before the burn. */
  owedChange?: OwedChangeEntry[];
  mintUrl: string;
  unit?: string;
  now?: number;
  onPhase?: (phase: string) => void;
}

/**
 * The money leg: verify the PIN if the card has one, write any change the
 * card is still owed, burn the planned slots, settle + mint change in the
 * atomic swap, record the change, write it onto the card.
 */
export async function executeCharge({
  transceive,
  amountSat,
  plan,
  unspent,
  cardPubkey,
  pin,
  pinRequired,
  owedChange = [],
  mintUrl,
  unit = DEFAULT_UNIT,
  now = Date.now(),
  onPhase = () => {},
}: ExecuteChargeArgs): Promise<ChargeResult> {
  const step = makeStep(onPhase);

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

  // Change owed from an earlier charge goes on first: the PIN is verified,
  // nothing has burned, so a slot the card refuses here is a clean refusal.
  // Gated on the STORE, not on the caller's snapshot: the PIN flow keeps
  // `owedChange` across a failed attempt and calls back in with the same
  // args, and the card does not dedup a LOAD — a piece the first attempt
  // already landed (marked written as the card answered) must not go on
  // again as a duplicate proof. If the store will not read, nothing owed is
  // written this tap and a later one reconciles.
  //
  // The store alone is not enough on a retry: a LOAD whose answer was lost
  // (the tag dropped as the card wrote the slot) leaves the piece ON the
  // card and still `owed` on disk, with the attempt counted (it is counted
  // BEFORE the LOAD goes out — `writeOwedChange` — so a `written` mark the
  // keychain refused after the card answered looks the same). Re-sending
  // it from the store's word would put a second copy of the proof on the
  // card — a phantom balance and a mint rejection when the copy is spent.
  // So any piece that has already been attempted is settled against the
  // card first (`reconcileOwedChange`, the rule at its doc comment) and
  // only what the card does not hold goes on. A first attempt (`attempts`
  // 0) was never sent, so it skips the read and the common path costs no
  // APDU.
  if (owedChange.length > 0) {
    let toWrite = await stillOwedOf(cardPubkey, owedChange);
    if (toWrite.some(e => e.attempts > 0)) {
      const info = await step('reading card', () => getInfo(transceive));
      const statuses = await step('reading card', () =>
        getSlotStatuses(transceive, info.maxSlots),
      );
      const remaining = new Set(
        (
          await reconcileOwedChange({
            transceive,
            cardPubkey,
            statuses,
            known: unspent,
            now,
            onPhase,
          })
        ).map(e => e.id),
      );
      toWrite = toWrite.filter(e => remaining.has(e.id));
    }
    if (toWrite.length > 0) {
      await writeOwedChange({transceive, owed: toWrite, now, onPhase});
    }
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
    // The change exists only in this process until the card takes it: record
    // it durably FIRST — before the settlement bookkeeping and before any
    // LOAD — so a 6A84 on the second piece, a lost tag or a killed app leaves
    // a record the card's next tap writes from. A record that will not land
    // is logged and the loads still run: the card is the only home left.
    let changeRecorded = true;
    try {
      await recordOwedChange(cardPubkey, minted.change, {mintUrl, unit}, now);
    } catch (error) {
      changeRecorded = false;
      console.warn(
        '[charge] owed change could not be recorded; writing to the card unrecorded',
        error instanceof Error ? error.message : String(error),
      );
    }
    // The swap consumed the burned proofs: mark the entries settled.
    await markEntriesSettled(
      burned.map(e => e.id),
      now,
    );
    // The merchant's take joins the till (the sweep melts it above the
    // float reserve to the account address).
    await appendSettledProofsTill(minted.till);

    for (const proof of minted.change) {
      const nonce = nonceFromSecret(proof.secret);
      onPhase(PHASE_WRITING_CHANGE);
      let slot: number;
      try {
        slot = await loadProof(transceive, {
          keysetId: proof.id,
          amount: proof.amount,
          nonce,
          C: proof.C,
        });
      } catch (error) {
        // Recorded: the piece is owed on disk and the next tap writes it.
        // Unrecorded: it is nowhere but this process, and the error must say
        // so — the UI's "your change is saved" keys on the phase.
        throw new PhaseError(
          changeRecorded
            ? PHASE_WRITING_CHANGE
            : PHASE_WRITING_CHANGE_UNRECORDED,
          error,
        );
      }
      changeLoaded += 1;
      if (changeRecorded) {
        try {
          await markOwedChangeWritten(
            owedChangeId(cardPubkey, nonce),
            slot,
            now,
          );
        } catch {
          // The piece is on the card. A stale 'owed' record is harmless: the
          // next tap's reconcile finds the nonce in a slot and marks it.
        }
      }
    }
  }

  // Witness recovery — AFTER the customer's critical path: entries parked as
  // needs-card by earlier sessions (a burn whose SPEND_PROOF response was lost
  // mid-NFC) are re-signed while the card is still in the field and
  // PIN-verified; SIGN_ARBITRARY consumes nothing. Best-effort by design: a
  // tag lost mid-sign leaves the entry needs-card for the next session, and
  // must never fail the charge that is already complete.
  const orphaned = (await listSettlements()).filter(
    e => e.status === 'needs-card' && e.cardPubkey === cardPubkey,
  );
  for (const entry of orphaned) {
    onPhase(`re-signing recovered ${entry.amount} sat`);
    try {
      const signature = await resignWitness(transceive, entry);
      await attachRecoveredWitness(entry.id, toHex(signature), now);
    } catch {
      // The card left the field mid-sign: the entry stays needs-card and the
      // next session retries it. Never fail a completed charge for this.
    }
  }

  const balanceAfter = await step('reading card', () => getBalance(transceive));
  return {
    amountSat,
    burned,
    changeSat: plan.changeSat,
    changeLoaded,
    balanceAfter,
  };
}
