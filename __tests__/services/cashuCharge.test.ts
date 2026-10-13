/**
 * cashuCharge — Model B on a 2.0 card: enter amount, tap, ONE SIG_ALL
 * signature over the pieces, the merchant's outputs and the card's own
 * change; the swap at the mint; the change finished from the card's
 * openings and loaded back.
 *
 * The 2.0 card model and the test mint (`__tests__/support/cardProtocol2.ts`)
 * meet the REAL planning, the REAL swap path (cashu-ts's Wallet is replaced
 * by a double whose `mint.swap` is the test mint, which checks the SIG_ALL
 * witness and every input's C) and the REAL queues over a mocked keychain.
 * The ENG-630/642/645 guarantees keep their shape: change recorded before
 * the first LOAD, a failure after the swap is PAID, the burn point held.
 */
import {
  CARD_NEEDS_UPDATE,
  CardError,
  CardNeedsUpdateError,
  describeStatusWord,
  isAppletNotFound,
  isPinNeededForPayment,
  type Transceiver,
} from '../../src/services/cashuCard';
import {
  __resetWalletCache,
  buildCardSigAllSecret,
  cachedKeysets,
  listSettledProofs,
  saveKeysets,
} from '../../src/services/cashuMint';
import {
  CHANGE_NEEDS_MINT,
  DAILY_LIMIT_REACHED,
  ONLINE_ONLY,
  PHASE_SETTLING_UNCONFIRMED,
  allowanceCovers,
  chargeCard,
  executeCharge,
  headerTime,
  isPaidFailure,
  overDailyLimit,
  owedChangePhase,
  PHASE_RECORDING_PAYMENT,
  PHASE_RECORDING_PAYMENT_CHANGE_ON_CARD,
  PHASE_WRITING_CHANGE,
  PHASE_WRITING_CHANGE_UNRECORDED,
  PhaseError,
  planPurchase,
  readAndPlan,
  reconcileOwedChange,
  selectFittingPlan,
  writeOwedChange,
} from '../../src/services/cashuCharge';
import {
  clearQueue,
  hasUnsettledForCard,
  listOwedChange,
  listSettlements,
  OWED_CHANGE_KEY,
  outstandingChangeForCard,
  recordOwedCardChange,
  type OwedChangeEntry,
} from '../../src/services/cashuSettlement';
import {describeCardFailure} from '../../src/services/cashuCardNfc';
import {
  changeOnCard,
  failedAfterSwap,
  failureBody,
  parseFailure,
  pinFailureText,
} from '../../src/components/cashu/charge/money';
import {
  FakeCard2,
  KEYSET_ID,
  MINT_URL,
  cardWithPieces,
  headerVectors,
  pieceNonce,
  resetTestMint,
  scalar,
  testMint,
  type FakeCardOptions,
} from '../support/cardProtocol2';

const mockStore: Record<string, string> = {};

jest.mock('@cashu/cashu-ts', () => {
  const actual = jest.requireActual('@cashu/cashu-ts');
  const {MockWallet} = jest.requireActual('../support/cardProtocol2');
  return {...actual, Wallet: MockWallet};
});

jest.mock('../../src/services/secureStorage', () => ({
  getSecureStrict: jest.fn(async (k: string) => mockStore[k] ?? null),
  getSecure: jest.fn(async (k: string) => mockStore[k] ?? null),
  setSecure: jest.fn(async (k: string, v: string) => {
    mockStore[k] = v;
  }),
  removeSecure: jest.fn(async (k: string) => {
    delete mockStore[k];
  }),
}));

/** The tip header the charge shows the card is the test's to give: none by default. */
jest.mock('../../src/services/blockHeader', () => ({
  ...jest.requireActual('../../src/services/blockHeader'),
  cachedTipHeader: jest.fn(() => null),
}));

const OFFLINE = () => new TypeError('Network request failed');
const insOf = (apdu: number[]) => apdu[1];
const PAYMENT_INS = [0x22, 0x23, 0x24, 0x25, 0x26];

const tillProofs = () =>
  JSON.parse(mockStore['@cashu_settled_proofs'] ?? '[]') as {
    secret: string;
    amount: number;
    C: string;
  }[];

const owedStore = () =>
  (JSON.parse(mockStore[OWED_CHANGE_KEY] ?? '{"v":2,"entries":[]}').entries ??
    []) as OwedChangeEntry[];

/** The card's own 6A84, by class and status word: raw, or as a PhaseError's cause. */
const expectCardFull = (failure: unknown) => {
  const cause =
    failure instanceof PhaseError ? (failure.cause as unknown) : failure;
  expect(cause).toBeInstanceOf(CardError);
  expect((cause as CardError).sw).toBe(0x6a84);
};

/** A refusal of the n-th LOAD_PROOF with 6A84 (no free slot). */
const refuseLoadFull = (which: (n: number) => boolean) => (n: number) =>
  which(n) ? 0x6a84 : undefined;

let owedCounter = 0;

/**
 * Change an EARLIER charge left owed to this card: the openings sit on the
 * card (pending) and the mint's half is in the owed-change store, exactly as
 * a change write that never happened leaves them. `cards` get the same
 * openings (one physical card, read as several taps).
 */
async function owedFromEarlierCharge(
  amounts: number[],
  cards: FakeCard2[],
  now = 1000,
): Promise<OwedChangeEntry[]> {
  const change = amounts.map(amount => {
    owedCounter += 1;
    const nonce = scalar(`owed-nonce:${owedCounter}`);
    const r = scalar(`owed-r:${owedCounter}`);
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    let B_ = '';
    for (const card of cards) {
      B_ = card.addPendingChange({amount, nonce: hex(nonce), r: hex(r)});
    }
    const sig = testMint().sign(B_, amount);
    return {
      keysetId: KEYSET_ID,
      amount,
      B_,
      C_: sig.C_,
      dleq: sig.dleq,
    };
  });
  return recordOwedCardChange(
    cards[0].pubkey,
    change,
    {mintUrl: MINT_URL, unit: 'sat'},
    now,
  );
}

/** A PIN card holding real pieces of `amounts`. */
const pinCard = (
  amounts: number[],
  opts: Parameters<typeof cardWithPieces>[1] = {},
) => cardWithPieces(amounts, {pin: '1234', ...opts});

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  resetTestMint();
  __resetWalletCache();
  await saveKeysets(MINT_URL, [testMint().cachedKeyset()]);
  await clearQueue();
  // ENG-674: a charge whose change is due now asks `mintReachable` before
  // the card signs, whatever `requiresOnline` says — default it to a real
  // mint being there, same as a merchant's terminal normally is, so no test
  // makes an unmocked call to the real MINT_URL. A test that wants the mint
  // unreachable overrides this spy itself.
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ok: true} as Response);
});

describe('planPurchase', () => {
  const slots = [
    {slot: 0, amount: 16},
    {slot: 1, amount: 4},
    {slot: 2, amount: 1},
  ];
  const first = (r: ReturnType<typeof planPurchase>) => r[0];

  it('prefers an exact subset', () => {
    expect(first(planPurchase(slots, 4))).toEqual({
      slots: [1],
      burnedSat: 4,
      changeSat: 0,
    });
  });

  it('exact subsets can be multi-slot', () => {
    expect(first(planPurchase(slots, 5))).toEqual({
      slots: [1, 2],
      burnedSat: 5,
      changeSat: 0,
    });
  });

  it('over-cover candidates are ranked cheapest-change first', () => {
    const plans = planPurchase(slots, 10);
    // Exact-subset sums (11, 17, 20, 21) then the single 16 — all before the
    // ascending 21 accumulation. Cheapest change: 16 → 6.
    expect(first(plans)).toEqual({slots: [0], burnedSat: 16, changeSat: 6});
    expect(plans.map(p => p.changeSat)).toEqual([6, 7, 10, 11]);
  });

  it('a bigger card yields the tightest single-proof over-cover', () => {
    const rich = [...slots, {slot: 3, amount: 256}];
    // For a 14-sat bill the 16 beats the 256: change 2, not 242.
    expect(first(planPurchase(rich, 14))).toEqual({
      slots: [0],
      burnedSat: 16,
      changeSat: 2,
    });
  });

  it('refuses when the card cannot cover the bill at all', () => {
    expect(planPurchase(slots, 99)).toEqual([]);
  });

  it('never mixes pieces of different dates in one payment (the card refuses it)', () => {
    const dated = [
      {slot: 0, amount: 4, date: 0},
      {slot: 1, amount: 4, date: 1700000000},
      {slot: 2, amount: 2, date: 0},
    ];
    const plans = planPurchase(dated, 6);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const dates = new Set(plan.slots.map(s => dated[s].date));
      expect(dates.size).toBe(1);
    }
    expect(first(plans)).toEqual({slots: [0, 2], burnedSat: 6, changeSat: 0});
  });
});

describe('selectFittingPlan', () => {
  const plans = [
    {slots: [0], burnedSat: 13, changeSat: 3}, // 2 pieces: 2 + 1
    {slots: [1], burnedSat: 18, changeSat: 8}, // 1 piece
    {slots: [0, 1], burnedSat: 31, changeSat: 21}, // 3 pieces
  ];

  it('takes the first plan (cheapest change) whose change fits the free slots', () => {
    expect(selectFittingPlan(plans, 2)).toBe(plans[0]);
    expect(selectFittingPlan(plans, 1)).toBe(plans[1]);
  });

  it('an exact plan always fits, even with no free slot', () => {
    const exact = {slots: [2], burnedSat: 10, changeSat: 0};
    expect(selectFittingPlan([exact, ...plans], 0)).toBe(exact);
  });

  it('is null when no plan fits', () => {
    expect(selectFittingPlan(plans, 0)).toBeNull();
    expect(selectFittingPlan([], 5)).toBeNull();
  });
});

describe('readAndPlan', () => {
  it('reads, plans and reports the phases', async () => {
    const card = cardWithPieces([8, 16]);
    const phases: string[] = [];

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
      onPhase: phase => phases.push(phase),
    });

    expect(preRead.plan.burnedSat).toBe(16);
    expect(preRead.cardPubkey).toBe(card.pubkey);
    expect(preRead.pinRequired).toBe(false);
    expect(preRead.requiresOnline).toBe(false);
    expect(phases[0]).toBe('reading card');
    // Read only: GET_INFO, GET_CARD, GET_PUBKEY, GET_PIECES, GET_CHANGE,
    // GET_DLEQ — no payment command, no load.
    expect(
      card.insSent.filter(i => PAYMENT_INS.includes(i) || i === 0x30),
    ).toEqual([]);
  });

  it('wraps a phase failure with the phase in the message and the CardError as cause', async () => {
    // A BoltCard (NTAG 424 DNA) answers every SELECT with 0x6A82: the router
    // must be able to tell that apart from a Cashu card that failed, by
    // class and status word, after the phase wrapper has re-thrown it.
    const transceive: Transceiver = async () => [0x6a, 0x82];

    const failure = await readAndPlan({transceive, amountSat: 16}).catch(
      e => e,
    );

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[reading card\] SELECT failed/);
    expect(failure.cause).toBeInstanceOf(CardError);
    expect((failure.cause as CardError).sw).toBe(0x6a82);
    expect(isAppletNotFound(failure)).toBe(true);
  });

  it('a different card refusal is wrapped the same way but is not "applet not found"', async () => {
    const transceive: Transceiver = async () => [0x69, 0x83];

    const failure = await readAndPlan({transceive, amountSat: 16}).catch(
      e => e,
    );

    expect(failure).toBeInstanceOf(PhaseError);
    expect((failure.cause as CardError).sw).toBe(0x6983);
    expect(isAppletNotFound(failure)).toBe(false);
  });

  it('a 0.x card short-circuits as "needs an update": nothing but SELECT commands, no plan', async () => {
    const card = new FakeCard2({legacy: true, pieces: []});

    const failure = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(CardNeedsUpdateError);
    expect(failure).not.toBeInstanceOf(PhaseError);
    expect(failure.message).toBe(CARD_NEEDS_UPDATE);
    expect(card.insSent.every(i => i === 0xa4)).toBe(true);
  });

  it('asks for the PIN on a PIN card whose allowance does not cover the bill', async () => {
    const card = pinCard([16], {allowance: 10, noPinSpent: 0});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.pinRequired).toBe(true);
    expect(preRead.pinSet).toBe(true);
  });

  it('does not ask for the PIN when the no-PIN allowance covers the bill (decision 11)', async () => {
    const card = pinCard([16], {allowance: 50, noPinSpent: 30});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.pinRequired).toBe(false);
    expect(preRead.pinSet).toBe(true);
  });

  it('a piece with no DLEQ kept makes the charge online-only', async () => {
    const card = cardWithPieces([16], {withDleq: false});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.requiresOnline).toBe(true);
  });

  it('a piece whose DLEQ does not verify makes the charge online-only', async () => {
    const card = cardWithPieces([16]);
    card.slots[0]!.C = card.pubkey;
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.requiresOnline).toBe(true);
  });

  it('no mint keys kept on the terminal makes the charge online-only', async () => {
    const card = cardWithPieces([16]);
    await saveKeysets(MINT_URL, []);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.requiresOnline).toBe(true);
  });

  it('a blocked PIN is refused before any plan', async () => {
    const card = pinCard([16], {pinBlocked: true});
    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 16}),
    ).rejects.toThrow(/PIN is blocked/);
  });
});

describe('the daily limit (decision 2)', () => {
  const info = {
    dailyLimit: 100,
    now: 1_000_000,
    windowStart: 990_000,
    spentToday: 90,
  };
  const record = {rolls: 0, rollBudget: 7};

  it('overDailyLimit: over what the day has left', () => {
    expect(overDailyLimit(info, record, 10)).toBe(false);
    expect(overDailyLimit(info, record, 11)).toBe(true);
    expect(overDailyLimit({...info, dailyLimit: 0}, record, 1_000_000)).toBe(
      false,
    );
  });

  it('a day that is over begins again — while the rollover budget lasts', () => {
    const dayLater = 990_000 + 86_400;
    expect(overDailyLimit({...info, now: dayLater}, record, 100)).toBe(false);
    expect(
      overDailyLimit({...info, now: dayLater}, {rolls: 7, rollBudget: 7}, 100),
    ).toBe(true);
    // The header about to be shown to the card counts as its clock.
    expect(overDailyLimit(info, record, 100, dayLater)).toBe(false);
  });

  it("headerTime reads a block header's time", () => {
    const v = headerVectors()[0];
    expect(headerTime(Array.from(Buffer.from(v.header, 'hex')))).toBe(v.time);
    expect(headerTime(null)).toBe(0);
  });

  it("a bill over the card's daily limit is refused before anything burns", async () => {
    const card = pinCard([16], {
      dailyLimit: 20,
      spentToday: 10,
      now: 1_000_000,
      windowStart: 990_000,
    });
    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
    }).catch(e => e);

    expect(failure.message).toBe(DAILY_LIMIT_REACHED);
    expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
    const body = failureBody(parseFailure(describeCardFailure(failure)), {
      burnsDone: 0,
      paidSat: 16,
      changeSat: 0,
      fmt: (sat: number) => `${sat} sats`,
    });
    expect(body).toBe("This card has reached today's spending limit.");
  });

  it("the card's own 6A8F at SIGN burns nothing, is not paid, and reads as the limit", async () => {
    const card = pinCard([16]);
    const transceive: Transceiver = async apdu =>
      insOf(apdu) === 0x24 ? [0x6a, 0x8f] : card.transceive(apdu);

    const failure = await chargeCard({
      transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(isPaidFailure(failure)).toBe(false);
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
    expect(
      failureBody(parseFailure(describeCardFailure(failure)), {
        burnsDone: 1,
        paidSat: 16,
        changeSat: 0,
        fmt: (sat: number) => `${sat} sats`,
      }),
    ).toBe("This card has reached today's spending limit.");
  });
});

describe('the no-PIN allowance (decision 11)', () => {
  it("allowanceCovers: what is left of the day's allowance", () => {
    expect(allowanceCovers({allowance: 50, noPinSpent: 30}, 20)).toBe(true);
    expect(allowanceCovers({allowance: 50, noPinSpent: 30}, 21)).toBe(false);
    expect(allowanceCovers({allowance: 0, noPinSpent: 0}, 1)).toBe(false);
    expect(allowanceCovers({}, 1)).toBe(false);
  });

  it('a bill under the allowance is paid with no PIN, and its change goes on under the change grant', async () => {
    const card = pinCard([16], {allowance: 50});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 10,
    });
    expect(preRead.pinRequired).toBe(false);

    const result = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 10,
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(card.insSent).not.toContain(0x40);
    expect(result.changeSat).toBe(6);
    expect(result.changeLoaded).toBe(2);
    expect(card.balance).toBe(6);
    // The change went on after a fresh SELECT took the payment's change grant.
    const afterSign = card.insSent.slice(card.insSent.indexOf(0x24) + 1);
    expect(afterSign.indexOf(0xa4)).toBeLessThan(afterSign.indexOf(0x30));
  });

  it('a card that says the PIN is needed after all (6A94 at SIGN): nothing burned, the PIN is asked for', async () => {
    // The till thought the allowance covered it; the card's day disagrees.
    const card = pinCard([16], {allowance: 50});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.pinRequired).toBe(false);
    card.noPinSpent = 45;

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(isPinNeededForPayment(failure)).toBe(true);
    expect(isPaidFailure(failure)).toBe(false);
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
    // The PIN pad says why, in plain words.
    expect(
      pinFailureText(parseFailure(describeCardFailure(failure)).detail),
    ).toBe("This payment needs the card's PIN.");

    // The screen asks for the PIN and re-taps: the same plan, now with it.
    const result = await executeCharge({
      ...preRead,
      pinRequired: true,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });
    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
  });
});

describe('chargeCard', () => {
  it('exact charge: verifies PIN, burns, settles inline — the take joins the till', async () => {
    const card = pinCard([16, 4, 1]);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 5,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.amountSat).toBe(5);
    expect(result.changeSat).toBe(0);
    expect(result.changeLoaded).toBe(0);
    // One payment, two pieces, one signature.
    expect(result.burned).toHaveLength(1);
    expect(result.burned[0].inputs.map(i => i.amount)).toEqual([4, 1]);
    expect(card.burnCount).toBe(2);

    // VERIFY_PIN before the signature (D13): its APDU precedes SPEND_ALL_SIGN.
    const verifyIdx = card.insSent.indexOf(0x40);
    const signIdx = card.insSent.indexOf(0x24);
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(card.insSent.indexOf(0x22));
    expect(verifyIdx).toBeLessThan(signIdx);

    // The exact-bill swap settled inline — no dependence on the drain.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
    expect(tillProofs().map(t => t.amount)).toEqual([4, 1]);
    for (const p of tillProofs()) {
      expect(testMint().verifyProof(p.secret, p.C, p.amount)).toBe(true);
    }
  });

  it('exact bill with a failed swap defers to the drain instead of failing', async () => {
    const card = pinCard([16, 4, 1]);
    testMint().failAll = OFFLINE();

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 5,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    // The customer's payment still completes; the payment stays 'pending'
    // for the drain (nothing owed back onto the card).
    expect(result.changeSat).toBe(0);
    expect(result.changeLoaded).toBe(0);
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(1);
    expect(tillProofs()).toHaveLength(0);
  });

  it('makes change on the card and writes it back onto the card', async () => {
    const card = pinCard([16]);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.burned).toHaveLength(1);
    expect(result.changeSat).toBe(6);
    expect(result.changeLoaded).toBe(2);
    // The card made its own change (SPEND_ALL_CHANGE, 4 then 2) and took it back.
    expect(card.sent.filter(a => insOf(a) === 0x26).map(a => a[8])).toEqual([
      4, 2,
    ]);
    expect(card.loads.map(l => l.amount)).toEqual([4, 2]);
    expect(card.loads.every(l => l.dleq)).toBe(true);
    expect(card.balance).toBe(6);
    // The swap consumed the burned pieces: the payment ends settled, and the
    // merchant's take joined the till.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
    expect(tillProofs().map(t => t.amount)).toEqual([8, 2]);
    await expect(hasUnsettledForCard(card.pubkey)).resolves.toBe(false);
  });

  it('change is credited once: the card gets its change, the till the bill, and nothing twice (decision 13)', async () => {
    const card = pinCard([16]);
    const before = card.balance;

    await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    // One swap: its outputs are the till's 10 and the card's 6, once each.
    expect(testMint().swaps).toHaveLength(1);
    const [swap] = testMint().swaps;
    expect(swap.outputs.reduce((t, o) => t + Number(o.amount), 0)).toBe(16);
    expect(card.balance).toBe(before - 10);
    expect(tillProofs().reduce((t, p) => t + p.amount, 0)).toBe(10);
    // The owed record holds each change piece once, both written.
    expect(owedStore().map(e => [e.amount, e.status])).toEqual([
      [4, 'written'],
      [2, 'written'],
    ]);
    // And no terminal-made change: every change output was the card's own.
    const cardMade = card.sent.filter(a => insOf(a) === 0x26).length;
    expect(cardMade).toBe(2);
  });

  it("the piece loaded back is the card's own opening, finished with the mint's signature", async () => {
    const card = pinCard([16]);

    await chargeCard({
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
    });

    expect(card.loads).toHaveLength(1);
    const [load] = card.loads;
    // The nonce the card drew for its change, and a C the mint signed for the
    // secret the card will rebuild from it at its next payment.
    const secret = buildCardSigAllSecret(load.nonce, card.pubkey);
    expect(testMint().verifyProof(secret, load.C, load.amount)).toBe(true);
    expect(card.openings).toEqual([]);
  });

  it('a failed swap with change records the payment PAID (ENG-674 blocking 2) and reports the change honestly, queued', async () => {
    const card = pinCard([16]);
    testMint().failAll = OFFLINE();

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(
      /^\[settling payment and minting change \(change owed, next tap\)/,
    );
    // The card already signed and burned, so this must never be reported
    // unpaid: the screen's retry would burn it again for the same bill
    // (ENG-674 blocking 2 — before the fix, this threw unpaid and the entry
    // sat pending with nothing stopping a re-charge).
    expect(isPaidFailure(failure)).toBe(true);
    // The swap never landed: the payment stays PENDING with its witness and
    // its exact outputs — the next online auto-run settles it, and the
    // card's change comes back from it. Nothing is lost, and the UI did not
    // claim success.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(1);
    expect(entries[0].outputs.map(o => o.amount)).toEqual([8, 2, 4, 2]);
    expect(tillProofs()).toHaveLength(0);
  });

  it('a wrong PIN burns nothing', async () => {
    const card = pinCard([4]);
    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 4,
        pin: '9999',
        mintUrl: MINT_URL,
      }),
    ).rejects.toBeTruthy();
    expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
    await expect(listSettlements()).resolves.toEqual([]);
  });

  it("the mint's input fee comes out of the merchant's take, never the customer's change", async () => {
    resetTestMint({inputFeePpk: 1000});
    await saveKeysets(MINT_URL, [testMint().cachedKeyset()]);
    const card = pinCard([16]);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
    });

    expect(result.changeLoaded).toBe(2);
    expect(card.balance).toBe(6);
    expect(tillProofs().reduce((t, p) => t + p.amount, 0)).toBe(9);
  });

  it('pieces it cannot check offline are refused before the burn when the mint is out of reach', async () => {
    const card = pinCard([16], {withDleq: false});
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(OFFLINE());
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
      }).catch(e => e);
      expect(failure.message).toBe(`[preparing the payment] ${ONLINE_ONLY}`);
      expect(isPaidFailure(failure)).toBe(false);
      expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
      await expect(listSettlements()).resolves.toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('pieces it cannot check offline are paid when the mint answers', async () => {
    const card = pinCard([16], {withDleq: false});
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ok: true} as Response);
    try {
      const result = await chargeCard({
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
      });
      expect(result.changeSat).toBe(0);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${MINT_URL}/v1/keysets`,
        expect.anything(),
      );
      expect((await listSettlements())[0].status).toBe('settled');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('offline, an exact bill on pieces with a valid DLEQ is taken without asking the mint', async () => {
    const card = pinCard([16]);
    testMint().failAll = OFFLINE();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const result = await chargeCard({
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
      });
      expect(result.changeSat).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await listSettlements())[0].status).toBe('pending');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('shows the card the cached tip header before the payment', async () => {
    const header = Array.from(Buffer.from(headerVectors()[11].header, 'hex'));
    const {cachedTipHeader} = jest.requireMock(
      '../../src/services/blockHeader',
    );
    cachedTipHeader.mockReturnValue(header);
    const card = pinCard([16]);

    await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
    });

    expect(card.headers).toEqual([header]);
    expect(card.insSent.indexOf(0x36)).toBeLessThan(card.insSent.indexOf(0x22));
    cachedTipHeader.mockReturnValue(null);
  });

  it('recovers a payment the card burned with its signature lost, BEFORE the new one', async () => {
    let lose = true;
    const card = pinCard([8, 16], {
      loseSignAnswer: () => lose,
      loseAgain: () => lose,
    });
    // A first tap paid 8 and lost the signature: needs-card.
    const first = await chargeCard({
      transceive: card.transceive,
      amountSat: 8,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });
    expect(first.burned[0].status).toBe('needs-card');
    lose = false;

    // The next charge recovers it from SPEND_ALL_AGAIN before its own SIGN.
    await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    const lastSession = card.insSent.slice(card.insSent.lastIndexOf(0xa4));
    expect(lastSession.indexOf(0x25)).toBeLessThan(lastSession.indexOf(0x22));
    const entries = await listSettlements();
    expect(entries.find(e => e.id === first.burned[0].id)?.status).toBe(
      'pending',
    );
  });
});

describe('classifying a swap failure (ENG-674)', () => {
  it('an exact bill on pieces with forged C and no DLEQ is unpaid when the mint rejects it, and nothing is recorded as settled (blocking 1)', async () => {
    // A home-made card: C is just another key's pubkey, not this mint's
    // signature on the secret, and no DLEQ comes with it — the attack
    // readAndPlan cannot catch offline (no DLEQ ⇒ requiresOnline), that a
    // reachable mint must refuse outright rather than silently defer.
    const forgedC = new FakeCard2().pubkey;
    const card = new FakeCard2({
      pin: '1234',
      pieces: [
        {
          amount: 16,
          nonce: pieceNonce(900),
          C: forgedC,
          keysetId: KEYSET_ID.slice(0, 16),
        },
      ],
    });

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
      mintUrl: MINT_URL,
    });
    expect(preRead.requiresOnline).toBe(true);

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[settling payment and minting change\]/);
    expect(isPaidFailure(failure)).toBe(false);
    expect(tillProofs()).toEqual([]);
    const entries = await listSettlements();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('failed');
  });

  it('an exact bill with requiresOnline and a network failure on the swap is paid but not confirmed settled, and has no retry (blocking 1)', async () => {
    const card = pinCard([16], {withDleq: false});
    testMint().failAll = OFFLINE();

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message.startsWith(`[${PHASE_SETTLING_UNCONFIRMED}]`)).toBe(
      true,
    );
    // The card already signed and burned: a retry would burn it again for
    // the same bill, so this reuses the existing paid/no-retry machinery
    // (ENG-642) rather than a parallel one — but it must not read as a
    // confirmed "Paid" success either, since the mint never answered.
    expect(isPaidFailure(failure)).toBe(true);
    expect(tillProofs()).toEqual([]);
    const entries = await listSettlements();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('pending');
  });

  it('offline with change due: the card is never asked to sign, the charge is refused before anything burns (blocking 2a)', async () => {
    const card = pinCard([16]);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(OFFLINE());
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      expect(failure.message).toBe(
        `[preparing the payment] ${CHANGE_NEEDS_MINT}`,
      );
      expect(isPaidFailure(failure)).toBe(false);
      expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
      await expect(listSettlements()).resolves.toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a rotated keyset is refreshed before signing: a stale 'inactive' cache does not wrongly refuse the card's change (should-fix)", async () => {
    const card = pinCard([16]);
    // The cache says this keyset is inactive — stale. The mint (live, via
    // the test's keyChain double) still has it active; unrefreshed, the
    // charge would wrongly refuse to make change in a keyset the mint is
    // still issuing.
    await saveKeysets(MINT_URL, [
      {...testMint().cachedKeyset(), active: false},
    ]);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.changeSat).toBe(6);
    expect(result.changeLoaded).toBe(2);
    const kept = await cachedKeysets(MINT_URL);
    expect(kept.find(k => k.id === KEYSET_ID)?.active).toBe(true);
  });
});

describe('slot pre-flight (ENG-630)', () => {
  /** Pieces that are not the test mint's (any amount): for planning only. */
  const planningCard = (amounts: number[], opts: FakeCardOptions = {}) =>
    new FakeCard2({
      ...opts,
      pieces: amounts.map((amount, i) => ({
        amount,
        nonce: pieceNonce(100 + i),
        C: new FakeCard2().pubkey,
      })),
    });

  it('a full card is refused BEFORE anything burns', async () => {
    // One slot, holding 16; a 10-sat bill needs 6 sat of change = 2 slots.
    const card = pinCard([16], {slotCount: 1});

    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 10}),
    ).rejects.toThrow(/this card is full/);
    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
      }),
    ).rejects.toThrow(
      /this card is full: 6 sat of change needs 2 free slots and the card has 0/,
    );

    // Same assertion as "a wrong PIN burns nothing": no payment command went out.
    expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
    expect(card.insSent).not.toContain(0x30);
    await expect(listSettlements()).resolves.toEqual([]);
    expect(testMint().swaps).toHaveLength(0);
  });

  it('picks the cheapest plan whose change fits the free slots', async () => {
    // 13 → change 3 (2 pieces), 18 → change 8 (1 piece). One free slot:
    // the cheaper change does not fit, the next does.
    const card = planningCard([13, 18], {slotCount: 3});

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 10,
    });

    expect(preRead.plan).toEqual({slots: [1], burnedSat: 18, changeSat: 8});
    expect(preRead.owedChange).toEqual([]);
  });

  it('an exact bill goes through on a full card', async () => {
    const card = pinCard([16], {slotCount: 1});
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.plan.changeSat).toBe(0);
  });

  it('a card with too few change openings free is refused before anything burns', async () => {
    // Seven of the card's eight openings hold change another till made and
    // never handed back: a bill whose change is two pieces cannot be paid.
    const card = pinCard([16]);
    for (let i = 0; i < 7; i++) {
      card.addPendingChange({
        amount: 1,
        nonce: pieceNonce(200 + i),
        r: pieceNonce(300 + i),
      });
    }
    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 10}),
    ).rejects.toThrow(/needs 2 change openings and the card has 1 free/);
    // A bill whose change is one piece still fits.
    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 12}),
    ).resolves.toMatchObject({plan: {changeSat: 4}});
  });

  it('change owed from an earlier charge takes its slots off the top', async () => {
    const billFirstCard = pinCard([16], {slotCount: 3});
    const roomy = pinCard([16], {slotCount: 4});
    const tight = pinCard([16], {slotCount: 2});
    const full = pinCard([16], {slotCount: 1});
    await owedFromEarlierCharge([4, 2], [billFirstCard, roomy, tight, full]);

    // Two slots free, two owed pieces, and a 10-sat bill wanting 6 sat of
    // change (two more): the bill wins — it takes both empties, no owed
    // piece is written this tap, and both stay owed on disk.
    const billFirst = await readAndPlan({
      transceive: billFirstCard.transceive,
      amountSat: 10,
    });
    expect(billFirst.plan).toEqual({slots: [0], burnedSat: 16, changeSat: 6});
    expect(billFirst.owedChange).toEqual([]);
    await expect(outstandingChangeForCard(roomy.pubkey)).resolves.toHaveLength(
      2,
    );

    // Three slots free: the bill's two pieces, then one owed piece fits.
    const shared = await readAndPlan({
      transceive: roomy.transceive,
      amountSat: 10,
    });
    expect(shared.plan.changeSat).toBe(6);
    expect(shared.owedChange.map(e => e.amount)).toEqual([4]);

    // One slot free for two owed pieces and an EXACT bill: the charge needs
    // no slot, so it goes through; the one piece that fits is written and
    // the other stays owed on disk for a later tap. (The card ENG-630 came
    // from is full with change owed — it must be able to pay again.)
    const preRead = await readAndPlan({
      transceive: tight.transceive,
      amountSat: 16,
    });
    expect(preRead.plan.changeSat).toBe(0);
    expect(preRead.owedChange.map(e => e.amount)).toEqual([4]);
    await expect(outstandingChangeForCard(tight.pubkey)).resolves.toHaveLength(
      2,
    );

    // No slot free at all, exact bill: nothing owed is written, the charge
    // still goes through, the change stays owed.
    const onFull = await readAndPlan({
      transceive: full.transceive,
      amountSat: 16,
    });
    expect(onFull.plan.changeSat).toBe(0);
    expect(onFull.owedChange).toEqual([]);
  });

  it('a payable bill is never refused for owed change: the bill takes the slot, the owed piece waits', async () => {
    // One empty slot, one owed piece, a 16-sat piece and a 12-sat bill: the
    // 4 sat of change is one piece and the card can physically take it.
    const card = pinCard([16], {slotCount: 2});
    const [owed] = await owedFromEarlierCharge([4], [card]);

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 12,
    });
    expect(preRead.plan).toEqual({slots: [0], burnedSat: 16, changeSat: 4});
    expect(preRead.owedChange).toEqual([]);

    const result = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(4);
    expect(result.changeLoaded).toBe(1);
    // The bill's change is what went on; the owed piece is still owed.
    expect(card.loads).toHaveLength(1);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 0}),
    ]);
  });

  it('the refusal names the slots the card reported, not the count after owed change', async () => {
    // One empty slot, one owed piece, and a 10-sat bill from a 16: the 6 sat
    // of change is two pieces — no plan fits the one raw empty either.
    const card = pinCard([16], {slotCount: 2});
    await owedFromEarlierCharge([4], [card]);

    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 10}),
    ).rejects.toThrow(
      /this card is full: 6 sat of change needs 2 free slots and the card has 1/,
    );
  });

  it('an exact bill on a full card owed change: the charge completes and the change is still owed after', async () => {
    const card = pinCard([16], {slotCount: 1});
    const [owed] = await owedFromEarlierCharge([4], [card]);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
    expect(card.insSent).not.toContain(0x30);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 0}),
    ]);
  });
});

describe('owed change (ENG-630)', () => {
  it('records the minted change durably BEFORE the first LOAD_PROOF', async () => {
    const card = pinCard([16]);
    // What the owed-change store held the instant the first LOAD went out.
    let storeAtFirstLoad: string | undefined | null = null;
    const transceive: Transceiver = async apdu => {
      if (insOf(apdu) === 0x30 && storeAtFirstLoad === null) {
        storeAtFirstLoad = mockStore[OWED_CHANGE_KEY];
      }
      return card.transceive(apdu);
    };

    await chargeCard({
      transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(storeAtFirstLoad).toEqual(expect.any(String));
    const recorded = JSON.parse(storeAtFirstLoad as unknown as string)
      .entries as OwedChangeEntry[];
    expect(recorded.map(e => e.amount)).toEqual([4, 2]);
    // The mint's half (B_, C_) is what exists before the card's openings are read.
    expect(recorded.every(e => e.B_ && e.C_)).toBe(true);
    expect(recorded.every(e => e.status === 'owed')).toBe(true);
    // Both loads answered: both pieces are written, with their slots.
    expect(owedStore().map(e => [e.status, e.slot])).toEqual([
      ['written', 1],
      ['written', 2],
    ]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('a 6A84 on the second piece leaves the piece owed on disk, the payment settled, and the next tap writes it first', async () => {
    const card = pinCard([16], {
      // The card reported room at read time; the second LOAD is refused
      // anyway (the pre-flight cannot see a slot the card loses between the
      // read tap and the PIN tap).
      refuseLoad: refuseLoadFull(n => n === 1),
    });

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    // The 4-sat piece the card took before the refusal is named in the
    // phase, so the body can say how much landed (ENG-645).
    expect(failure.message).toMatch(
      /^\[writing change to card \(4 sat on card\)\] LOAD_PROOF failed: card is full/,
    );
    expectCardFull(failure);
    expect(failedAfterSwap(parseFailure(describeCardFailure(failure)))).toBe(
      true,
    );
    expect(
      failureBody(parseFailure(describeCardFailure(failure)), {
        burnsDone: 1,
        paidSat: 10,
        changeSat: 6,
        paid: isPaidFailure(failure),
        fmt: (sat: number) => `${sat} sats`,
      }),
    ).toBe(
      '10 sats are paid. 4 sats of your 6 sats change are on the card. The other 2 sats are saved on this terminal and will be added once the card has a free slot.',
    );
    // The payment settled at the mint: the merchant's money is accounted for.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
    // One piece on the card, one still owed — and opened: a whole piece.
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'owed', undefined],
    ]);
    const owed = await outstandingChangeForCard(card.pubkey);
    expect(owed.map(e => e.amount)).toEqual([2]);
    expect(owed[0].nonce).toEqual(expect.any(String));

    // The next tap, same card: it now holds the 4-sat piece (unspent) and
    // the burned slot. A 4-sat bill is exact; the owed 2 sat goes on first.
    const before = card.sent.length;
    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 4,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    const session = card.sent.slice(before).map(insOf);
    const verifyIdx = session.lastIndexOf(0x40);
    const loadIdx = session.lastIndexOf(0x30);
    const signIdx = session.lastIndexOf(0x24);
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(verifyIdx);
    expect(signIdx).toBeGreaterThan(loadIdx);
    expect(card.loads.map(l => l.amount)).toEqual([4, 2]);
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'written', 2],
    ]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('a lost LOAD answer is reconciled from the card: the opening is gone, the piece is marked and never re-sent', async () => {
    const card = pinCard([16], {loseLoadAnswer: n => n === 0});

    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 12,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }),
    ).rejects.toThrow(/^\[writing change to card\] Tag was lost/);
    expect(owedStore()).toEqual([
      expect.objectContaining({amount: 4, status: 'owed'}),
    ]);

    // Next tap: the card holds the piece (the LOAD landed) and let its
    // opening go. The read marks it written and sends no LOAD.
    const loadsBefore = card.sent.filter(a => insOf(a) === 0x30).length;
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 4,
      now: 2000,
    });

    expect(preRead.owedChange).toEqual([]);
    expect(card.sent.filter(a => insOf(a) === 0x30)).toHaveLength(loadsBefore);
    expect(owedStore()).toEqual([expect.objectContaining({status: 'written'})]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('reconcileOwedChange reads nothing when the card is owed nothing', async () => {
    const card = pinCard([16]);

    await expect(
      reconcileOwedChange({
        transceive: card.transceive,
        cardPubkey: card.pubkey,
        now: 1000,
      }),
    ).resolves.toEqual([]);
    expect(card.sent).toEqual([]);
  });

  it("reconcileOwedChange reads the card's openings once, and leaves another card's change alone", async () => {
    const other = new FakeCard2({privateKey: '44'.repeat(32)});
    await owedFromEarlierCharge([4], [other]);
    const card = pinCard([16]);
    const [owed] = await owedFromEarlierCharge([2], [card]);

    const remaining = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 2000,
    });

    expect(remaining.map(e => e.id)).toEqual([owed.id]);
    // Opened from the card's opening: a whole piece the mint signed.
    const [opened] = remaining;
    expect(
      testMint().verifyProof(
        buildCardSigAllSecret(opened.nonce!, card.pubkey),
        opened.C!,
        2,
      ),
    ).toBe(true);
    expect(card.insSent).toEqual([0x19]);
    await expect(outstandingChangeForCard(other.pubkey)).resolves.toHaveLength(
      1,
    );
  });

  it('reconcileOwedChange uses the openings the caller already read: no APDU', async () => {
    const card = pinCard([16]);
    const [owed] = await owedFromEarlierCharge([2], [card]);
    const openings = card.openings.map(o => ({
      amount: o.amount,
      keysetId: o.keysetId,
      date: o.date,
      nonce: o.nonce,
      r: o.r,
    }));

    const remaining = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      openings,
      now: 2000,
    });

    expect(remaining.map(e => e.id)).toEqual([owed.id]);
    expect(card.sent).toEqual([]);
  });

  it('reconcileOwedChange leaves a piece it cannot finish (no keys kept) owed, unwritten', async () => {
    const card = pinCard([16]);
    const [owed] = await owedFromEarlierCharge([2], [card]);
    await saveKeysets(MINT_URL, []);

    const remaining = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 2000,
    });

    expect(remaining.map(e => e.id)).toEqual([owed.id]);
    expect(remaining[0].nonce).toBeUndefined();
    await expect(
      writeOwedChange({
        transceive: card.transceive,
        owed: remaining,
        now: 3000,
      }),
    ).resolves.toEqual([]);
    expect(card.loads).toEqual([]);
  });

  it('reconcileOwedChange tolerates the store refusing a written mark: the piece on the card stays out of the remainder and the charge proceeds', async () => {
    // Two pieces owed: the 4-sat one is already on the card (its LOAD answer
    // was lost: its opening is gone), the 2-sat one is not. The keychain
    // then refuses the `written` mark. The read must not turn into a
    // refused charge with a raw store error for a title: the piece IS on
    // the card, so it is not owed, and the stale record is harmless (the
    // next reconcile finds it again).
    const card = pinCard([16], {slotCount: 4});
    const [onCard, missing] = await owedFromEarlierCharge([4, 2], [card]);
    // Land the 4 on the card (as a lost-answer LOAD would have).
    const landing = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 1500,
    });
    card.pinVerified = true;
    await writeOwedChange({
      transceive: card.transceive,
      owed: landing.filter(e => e.id === onCard.id),
      now: 1600,
    });
    card.pinVerified = false;
    // …with the store still saying owed for it.
    const env = JSON.parse(mockStore[OWED_CHANGE_KEY]);
    env.entries = env.entries.map((e: OwedChangeEntry) =>
      e.id === onCard.id ? {...e, status: 'owed', attempts: 1} : e,
    );
    mockStore[OWED_CHANGE_KEY] = JSON.stringify(env);

    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const remaining = await reconcileOwedChange({
        transceive: card.transceive,
        cardPubkey: card.pubkey,
        now: 2000,
      });

      expect(remaining.map(e => e.id)).toEqual([missing.id]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/written mark was refused/),
        'keychain write denied',
      );
      // The store still says 'owed' for the piece on the card — stale, and
      // harmless: the next reconcile finds its opening gone again.
      expect(owedStore().map(e => [e.amount, e.status])).toEqual([
        [4, 'owed'],
        [2, 'owed'],
      ]);

      // The same refusal from inside `readAndPlan` (outside `step`) does
      // not refuse the charge: the plan carries only the piece that is
      // genuinely missing, and the bill goes through.
      const preRead = await readAndPlan({
        transceive: card.transceive,
        amountSat: 16,
      });
      expect(preRead.owedChange.map(e => e.id)).toEqual([missing.id]);
      const result = await executeCharge({
        ...preRead,
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 3000,
      });
      expect(result.changeSat).toBe(0);
      expect(card.burnCount).toBe(1);
      // The piece already on the card was never loaded a second time.
      expect(card.loads.filter(l => l.amount === 4)).toHaveLength(1);
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('writeOwedChange marks each piece as the card answers and records a refusal', async () => {
    const card = new FakeCard2({slotCount: 1});
    await owedFromEarlierCharge([4, 2], [card]);
    const owed = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 1500,
    });
    const phases: string[] = [];

    const failure = await writeOwedChange({
      transceive: card.transceive,
      owed,
      now: 2000,
      onPhase: p => phases.push(p),
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expectCardFull(failure);
    expect(failure.message).toBe(
      `[${owedChangePhase(
        2,
      )}] LOAD_PROOF failed: card is full — no free slot (0x6A84)`,
    );
    expect(phases).toEqual([owedChangePhase(4), owedChangePhase(2)]);
    expect(owedStore()).toEqual([
      expect.objectContaining({amount: 4, status: 'written', slot: 0}),
      expect.objectContaining({
        amount: 2,
        status: 'owed',
        attempts: 1,
        lastError: expect.stringMatching(/card is full/),
      }),
    ]);
  });

  it("writeOwedChange reads the card's 6A94 as landed, never as a failure", async () => {
    const card = new FakeCard2({
      refuseLoad: n => (n === 0 ? 0x6a94 : undefined),
    });
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const opened = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 1500,
    });

    const written = await writeOwedChange({
      transceive: card.transceive,
      owed: opened,
      now: 2000,
    });

    expect(written.map(e => e.id)).toEqual([owed.id]);
    expect(owedStore()[0]).toMatchObject({status: 'written'});
  });

  it('writeOwedChange never sends 0.x change or a piece it has not opened', async () => {
    const card = new FakeCard2();
    const legacy = {
      id: `${card.pubkey}:${'71'.repeat(32)}`,
      cardPubkey: card.pubkey,
      mintUrl: MINT_URL,
      unit: 'sat',
      keysetId: KEYSET_ID,
      amount: 4,
      secret: 'legacy',
      C: card.pubkey,
      nonce: '71'.repeat(32),
      status: 'owed' as const,
      createdAt: 0,
      updatedAt: 0,
      attempts: 0,
    };
    const [unopened] = await owedFromEarlierCharge([2], [card]);
    await expect(
      writeOwedChange({
        transceive: card.transceive,
        owed: [legacy, unopened],
        now: 1,
      }),
    ).resolves.toEqual([]);
    expect(card.sent).toEqual([]);
  });

  it('executeCharge writes the owed change after the PIN and before any burn, and a refusal there burns nothing', async () => {
    const card = pinCard([16], {refuseLoad: () => 0x6a84});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    }).catch(e => e);

    expectCardFull(failure);
    expect(card.insSent.filter(i => PAYMENT_INS.includes(i))).toEqual([]);
    await expect(listSettlements()).resolves.toEqual([]);
    expect(testMint().swaps).toHaveLength(0);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 1}),
    ]);
  });

  it('a PIN-flow retry with the same args never re-sends an owed piece the first attempt landed', async () => {
    const card = pinCard([16], {slotCount: 4});
    const [first, second] = await owedFromEarlierCharge([4, 2], [card]);
    // The tag drops under the second LOAD before the card sees it: the 4 is
    // on the card (marked written as it answered), the 2 is still owed.
    let loads = 0;
    let dropNextLoad = true;
    const transceive: Transceiver = async apdu => {
      if (insOf(apdu) === 0x30 && ++loads === 2 && dropNextLoad) {
        dropNextLoad = false;
        throw new Error('Tag was lost.');
      }
      return card.transceive(apdu);
    };
    const preRead = await readAndPlan({transceive, amountSat: 16});
    expect(preRead.owedChange.map(e => e.id)).toEqual([first.id, second.id]);
    const args = {
      ...preRead,
      transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    };

    await expect(executeCharge(args)).rejects.toThrow(
      /^\[adding 2 sat of change owed from an earlier charge\] Tag was lost/,
    );
    expect(card.loads.map(l => l.amount)).toEqual([4]);
    expect(card.burnCount).toBe(0);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: second.id, status: 'owed', attempts: 1}),
    ]);

    // The customer re-enters the PIN: the screen calls back in with the SAME
    // plan and the same owedChange snapshot. Only the piece the store still
    // calls owed goes on; the 4 is not loaded a second time.
    const result = await executeCharge({...args, now: 3000});

    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
    expect(card.loads.map(l => l.amount)).toEqual([4, 2]);
    // What reached the card: the 4 once, the 2 once (the dropped LOAD never
    // got there) — never a second 4 for the nonce the first attempt landed.
    expect(card.sent.filter(a => insOf(a) === 0x30)).toHaveLength(2);
    expect(loads).toBe(3);
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'written', 2],
    ]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('a PIN-flow retry reconciles against the card when the first LOAD landed but its answer was lost', async () => {
    // The card writes the slot and the tag drops before the 9000 reaches
    // the host: the 4 is ON the card, the store still calls it owed with
    // one attempt counted.
    const card = pinCard([16], {slotCount: 4, loseLoadAnswer: n => n === 0});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);
    const args = {
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    };

    await expect(executeCharge(args)).rejects.toThrow(
      /^\[adding 4 sat of change owed from an earlier charge\] Tag was lost/,
    );
    expect(card.loads.map(l => l.amount)).toEqual([4]);
    expect(card.burnCount).toBe(0);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 1}),
    ]);

    // The customer re-enters the PIN: same plan, same owedChange snapshot.
    // The store still says owed with an attempt counted, so the card's
    // openings are read before anything is sent — the opening is gone, the
    // piece is marked written, never loaded a second time.
    const result = await executeCharge({...args, now: 3000});

    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
    expect(card.sent.filter(a => insOf(a) === 0x30)).toHaveLength(1);
    expect(card.loads.map(l => l.amount)).toEqual([4]);
    expect(owedStore().map(e => [e.amount, e.status])).toEqual([
      [4, 'written'],
    ]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('a PIN-flow retry never re-sends an owed piece whose LOAD landed but whose written mark the store refused', async () => {
    const card = pinCard([16], {slotCount: 4, dropBeforeSign: n => n === 0});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    // The card takes the LOAD and answers its slot; the keychain then
    // refuses the `written` mark. The piece is ON the card and `owed` on
    // disk. Then the tag drops under the SIGN before the card commits: the
    // charge dies before any money moves, and the PIN pad retries.
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    let owedWrites = 0;
    try {
      const preRead = await readAndPlan({
        transceive: card.transceive,
        amountSat: 16,
      });
      expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);
      storage.setSecure.mockImplementation(async (k: string, v: string) => {
        // 1st owed-store write of the session = the write-ahead attempt mark
        // (lands); 2nd = the `written` mark after the card answered (refused).
        if (k === OWED_CHANGE_KEY && ++owedWrites === 2) {
          throw new Error('keychain write denied');
        }
        return realSet(k, v);
      });
      const args = {
        ...preRead,
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 2000,
      };

      await expect(executeCharge(args)).rejects.toThrow(
        /^\[burning 16 sat \(proof 1\/1\)\] Tag was lost/,
      );
      expect(card.loads.map(l => l.amount)).toEqual([4]);
      expect(card.burnCount).toBe(0);
      // The attempt was counted BEFORE the LOAD went out, so the refused
      // `written` mark leaves a record that still says "this was sent".
      await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
        expect.objectContaining({id: owed.id, status: 'owed', attempts: 1}),
      ]);

      // The customer re-enters the PIN: same plan, same owedChange snapshot.
      // `attempts > 0` sends the retry to the card first; the opening is
      // gone, the piece is marked written, and never loaded a second time.
      const result = await executeCharge({...args, now: 3000});

      expect(result.changeSat).toBe(0);
      expect(card.burnCount).toBe(1);
      expect(card.sent.filter(a => insOf(a) === 0x30)).toHaveLength(1);
      expect(card.loads.map(l => l.amount)).toEqual([4]);
      expect(owedStore().map(e => [e.amount, e.status])).toEqual([
        [4, 'written'],
      ]);
      await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
    } finally {
      storage.setSecure.mockImplementation(realSet);
    }
  });

  it('an owed piece whose attempt mark the store refuses is never sent: nothing owed goes on, the charge completes', async () => {
    const card = pinCard([16], {slotCount: 4});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await executeCharge({
        ...preRead,
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 2000,
      });

      expect(result.changeSat).toBe(0);
      expect(card.burnCount).toBe(1);
      // A LOAD the store could not count ahead would be invisible to the
      // next retry — so it is not sent. The piece waits for a later tap.
      expect(card.insSent).not.toContain(0x30);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/owed-change attempt could not be recorded/),
        'keychain write denied',
      );
      await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
        expect.objectContaining({id: owed.id, status: 'owed', attempts: 0}),
      ]);
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('writeOwedChange resolves with exactly the pieces it put on the card', async () => {
    const card = new FakeCard2({slotCount: 4});
    const [a, b] = await owedFromEarlierCharge([4, 2], [card]);
    const opened = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 1500,
    });

    const written = await writeOwedChange({
      transceive: card.transceive,
      owed: opened,
      now: 2000,
    });

    expect(written.map(e => e.id)).toEqual([a.id, b.id]);
    expect(card.loads.map(l => l.nonce)).toEqual(opened.map(e => e.nonce));
  });

  it('writeOwedChange cut short by the store resolves with only what went out, so a caller cannot claim the rest', async () => {
    const card = new FakeCard2({slotCount: 4});
    const [a, b] = await owedFromEarlierCharge([4, 2], [card]);
    const opened = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: card.pubkey,
      now: 1500,
    });
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The very first write-ahead mark is refused: nothing is sent, and the
      // result says so — an empty list, not the two pieces it was handed.
      storage.setSecure.mockImplementation(async (k: string, v: string) => {
        if (k === OWED_CHANGE_KEY) {
          throw new Error('keychain write denied');
        }
        return realSet(k, v);
      });
      await expect(
        writeOwedChange({transceive: card.transceive, owed: opened, now: 2000}),
      ).resolves.toEqual([]);
      expect(card.loads).toEqual([]);
      expect(owedStore().map(e => [e.amount, e.status, e.attempts])).toEqual([
        [4, 'owed', 0],
        [2, 'owed', 0],
      ]);

      // The mark for the second piece is refused after the first landed:
      // the result names the first piece alone.
      let owedWrites = 0;
      storage.setSecure.mockImplementation(async (k: string, v: string) => {
        // 1st = a's write-ahead mark, 2nd = a's `written` mark, 3rd = b's
        // write-ahead mark (refused).
        if (k === OWED_CHANGE_KEY && ++owedWrites === 3) {
          throw new Error('keychain write denied');
        }
        return realSet(k, v);
      });
      const written = await writeOwedChange({
        transceive: card.transceive,
        owed: opened,
        now: 3000,
      });

      expect(written.map(e => e.id)).toEqual([a.id]);
      expect(card.loads).toHaveLength(1);
      expect(owedStore().map(e => [e.id, e.status, e.attempts])).toEqual([
        [a.id, 'written', 1],
        [b.id, 'owed', 0],
      ]);
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('a first owed write does not re-read the card', async () => {
    const card = pinCard([16], {slotCount: 4});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);
    const apdusAfterRead = card.sent.length;

    await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    // Session 2 never asks GET_INFO (0x01), GET_PIECES (0x17) or the
    // openings (0x19) before the LOAD: the attempt count was 0 and the read
    // had already opened the piece.
    const session2 = card.sent.slice(apdusAfterRead);
    const firstLoad = session2.findIndex(a => insOf(a) === 0x30);
    expect(firstLoad).toBeGreaterThan(-1);
    expect(session2.slice(0, firstLoad).map(insOf)).toEqual([0xa4, 0x40]);
  });

  it('an unreadable owed-change store skips the owed write and the charge still completes', async () => {
    const card = pinCard([16], {slotCount: 4});
    const [owed] = await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange.map(e => e.id)).toEqual([owed.id]);
    // The store goes unreadable between the read tap and the PIN tap.
    const {getSecureStrict} = jest.requireMock(
      '../../src/services/secureStorage',
    );
    getSecureStrict.mockRejectedValueOnce(new Error('keychain locked'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });
    warn.mockRestore();

    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
    // Nothing owed was written — a duplicate is the one outcome worse than
    // a wait — and the piece is still owed for a later tap.
    expect(card.insSent).not.toContain(0x30);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 0}),
    ]);
  });

  it('a record that will not land is logged and the change still goes onto the card', async () => {
    const card = pinCard([16]);
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      });

      expect(result.changeLoaded).toBe(2);
      expect(card.loads).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/owed change could not be recorded/),
        'keychain write denied',
      );
      expect(mockStore[OWED_CHANGE_KEY]).toBeUndefined();
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('a change write that fails with NO record landed is reported under the unrecorded phase, naming the piece that landed', async () => {
    const card = pinCard([16], {refuseLoad: refuseLoadFull(n => n === 1)});
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const phases: string[] = [];
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
        onPhase: p => phases.push(p),
      }).catch(e => e);

      expect(failure).toBeInstanceOf(PhaseError);
      // The first piece (4 sat) landed before the refusal (ENG-645).
      expect(failure.message).toBe(
        '[writing change to card (unrecorded, 4 sat on card)] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      );
      expectCardFull(failure);
      // The stage still saw the ordinary change-write phase, once per piece.
      expect(phases.filter(p => p === 'writing change to card')).toHaveLength(
        2,
      );
      expect(phases).not.toContain(PHASE_WRITING_CHANGE_UNRECORDED);
      expect(phases.filter(p => /unrecorded/.test(p))).toEqual([]);
      expect(mockStore[OWED_CHANGE_KEY]).toBeUndefined();
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('one unparseable element in the owed store does not refuse the charge: the good piece is still written', async () => {
    const card = pinCard([16]);
    const [owed] = await owedFromEarlierCharge([4], [card]);
    // A downgraded build meeting a status it does not know, say.
    const envelope = JSON.parse(mockStore[OWED_CHANGE_KEY]);
    envelope.entries.push({...owed, id: 'future', status: 'future-status'});
    mockStore[OWED_CHANGE_KEY] = JSON.stringify(envelope);

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    expect(card.loads.map(l => l.amount)).toEqual([4]);
    expect(owedStore().map(e => [e.id, e.status, e.slot])).toEqual([
      [owed.id, 'written', 1],
    ]);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toEqual([]);
  });

  it('listOwedChange enumerates the store', async () => {
    await owedFromEarlierCharge([4], [new FakeCard2()]);
    await expect(listOwedChange()).resolves.toHaveLength(1);
  });
});

describe('card-full classification', () => {
  it('names the status word — the wording the charge UI classes a full card by', () => {
    const raw = new CardError(0x6a84, 'LOAD_PROOF');
    expect(describeStatusWord(0x6a84)).toBe('card is full — no free slot');
    expect(raw.message).toBe(
      'LOAD_PROOF failed: card is full — no free slot (0x6A84)',
    );
    expect(isAppletNotFound(raw)).toBe(false);
    expect(new PhaseError('writing change to card', raw).cause).toBe(raw);
  });
});

describe('the point of no return: a failure after the swap is PAID (ENG-642)', () => {
  /**
   * The screen ends a charge as paid on `isPaidFailure`, and picks the body
   * copy with `failedAfterSwap` on the message the screen displays. Both are
   * pinned here against what the service really throws.
   */
  const classified = (failure: unknown) =>
    failedAfterSwap(parseFailure(describeCardFailure(failure)));

  it('a change write the card refuses (recorded): flagged paid, and the copy classifier agrees', async () => {
    const card = pinCard([16], {refuseLoad: () => 0x6a84});

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(
      new RegExp(`^\\[${PHASE_WRITING_CHANGE}\\] `),
    );
    expect(failure.paid).toBe(true);
    expect(isPaidFailure(failure)).toBe(true);
    expect(classified(failure)).toBe(true);
  });

  it('a change write that fails unrecorded: flagged paid, and the copy classifier agrees', async () => {
    const card = pinCard([16], {refuseLoad: () => 0x6a84});
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 12,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      expect(failure).toBeInstanceOf(PhaseError);
      expect(failure.message).toMatch(
        new RegExp(
          `^\\[${PHASE_WRITING_CHANGE_UNRECORDED.replace(/[()]/g, '\\$&')}\\] `,
        ),
      );
      expect(isPaidFailure(failure)).toBe(true);
      expect(classified(failure)).toBe(true);
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('a change LOAD the card answers 6982 (no PIN in the tap): flagged paid, the change saved', async () => {
    const card = pinCard([16], {refuseLoad: () => 0x6982});

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(isPaidFailure(failure)).toBe(true);
    expect(classified(failure)).toBe(true);
    await expect(outstandingChangeForCard(card.pubkey)).resolves.toHaveLength(
      1,
    );
  });

  it('an exact bill whose card leaves the field on the final balance read: the charge completes', async () => {
    const card = pinCard([16], {loseTagOnBalanceAfterSign: true});

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    // The read is display-only: no failure, so no retry, so no second burn.
    expect(result.changeSat).toBe(0);
    expect(result.balanceAfter).toBeNull();
    expect(card.burnCount).toBe(1);
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
  });

  it('an exact bill whose swap is deferred, then the card leaves on the final read: still completes', async () => {
    const card = pinCard([16], {loseTagOnBalanceAfterSign: true});
    testMint().failAll = OFFLINE();

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.balanceAfter).toBeNull();
    expect(card.burnCount).toBe(1);
  });

  it('the settlement store refusing markEntriesSettled after the swap: flagged paid under its own phase, the till still written', async () => {
    const card = pinCard([16]);
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (testMint().swaps.length > 0 && k === '@cashu_settlement_queue') {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      expect(testMint().swaps).toHaveLength(1);
      expect(failure).toBeInstanceOf(PhaseError);
      expect(failure.message).toBe(
        `[${PHASE_RECORDING_PAYMENT}] keychain write denied`,
      );
      expect(isPaidFailure(failure)).toBe(true);
      // Not a change write: the copy classifier says so, and the screen
      // still ends it as paid on the flag.
      expect(classified(failure)).toBe(false);
      expect(card.burnCount).toBe(1);
      // The merchant's take: it exists only in this process until the till
      // write lands, so the settlement queue refusing must not drop it.
      expect((await listSettledProofs()).map(p => p.amount)).toEqual([16]);
    } finally {
      storage.setSecure.mockImplementation(realSet);
    }
  });

  it('the till store refusing after the swap: the payment is still marked settled, and the charge is flagged paid', async () => {
    const card = pinCard([16]);
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (testMint().swaps.length > 0 && k === '@cashu_settled_proofs') {
        throw new Error('till write denied');
      }
      return realSet(k, v);
    });
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 16,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      expect(failure).toBeInstanceOf(PhaseError);
      expect(failure.message).toBe(
        `[${PHASE_RECORDING_PAYMENT}] till write denied`,
      );
      expect(isPaidFailure(failure)).toBe(true);
      // The swap spent the burned pieces: a queue left 'pending' would have
      // the drain swap them again. The settle write ran despite the till.
      const entries = await listSettlements();
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('settled');
      expect(card.burnCount).toBe(1);
    } finally {
      storage.setSecure.mockImplementation(realSet);
    }
  });

  /**
   * The Keychain refusing every write once the swap has settled (device
   * locked, Keychain busy): the owed-change record, the till and the
   * settlement queue all fail together. The change exists only in this
   * process, and the card in the field is its only home left.
   */
  const refuseEveryWriteAfterSwap = () => {
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      setSecure: jest.Mock;
    };
    const realSet = storage.setSecure.getMockImplementation()!;
    storage.setSecure.mockImplementation(async (k: string, v: string) => {
      if (testMint().swaps.length > 0) {
        throw new Error('keychain write denied');
      }
      return realSet(k, v);
    });
    return () => storage.setSecure.mockImplementation(realSet);
  };

  const paidBody = (failure: unknown) =>
    failureBody(parseFailure(describeCardFailure(failure)), {
      burnsDone: 1,
      paidSat: 10,
      changeSat: 6,
      paid: isPaidFailure(failure),
      fmt: (sat: number) => `${sat} sats`,
    });

  it('every write refused after the swap: the change still goes onto the card, the charge is paid, and the copy never calls the change missing', async () => {
    const card = pinCard([16]);
    const restore = refuseEveryWriteAfterSwap();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      // Both pieces reached the card despite the bookkeeping failing first.
      expect(card.loads).toHaveLength(2);
      expect(card.loads.map(l => l.amount)).toEqual([4, 2]);
      expect(card.burnCount).toBe(1);

      expect(failure).toBeInstanceOf(PhaseError);
      expect(failure.message).toBe(
        `[${PHASE_RECORDING_PAYMENT_CHANGE_ON_CARD}] keychain write denied`,
      );
      expect(isPaidFailure(failure)).toBe(true);
      const parsed = parseFailure(describeCardFailure(failure));
      expect(changeOnCard(parsed)).toBe(true);
      expect(failedAfterSwap(parsed)).toBe(false);
      const body = paidBody(failure);
      expect(body).toBe('10 sats are paid. Your 6 sats change is on the card.');
      expect(body).not.toMatch(/did not reach|could not be put|saved/i);
    } finally {
      restore();
      warn.mockRestore();
    }
  });

  it('bookkeeping refused AND a change LOAD refused: the load failure is the one thrown, still paid', async () => {
    const card = pinCard([16], {refuseLoad: refuseLoadFull(n => n === 1)});
    const restore = refuseEveryWriteAfterSwap();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failure = await chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }).catch(e => e);

      // The first piece landed; the second was refused.
      expect(card.loads).toHaveLength(1);
      expect(failure).toBeInstanceOf(PhaseError);
      // The owed-change record was refused too, so the load reports the
      // change as unrecorded — the more specific story for the body copy —
      // and names the 4 sats the card already took (ENG-645).
      expect(failure.message).toBe(
        '[writing change to card (unrecorded, 4 sat on card)] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      );
      expect(failure.message).not.toMatch(/recording the payment/);
      expect(isPaidFailure(failure)).toBe(true);
      expect(changeOnCard(parseFailure(describeCardFailure(failure)))).toBe(
        false,
      );
      // How much landed and how much did not: never the whole 6 sats
      // called missing when 4 of them are on the card (ENG-645).
      expect(paidBody(failure)).toBe(
        '10 sats are paid. 4 sats of your 6 sats change are on the card. The other 2 sats could not be put on the card.',
      );
      expect(paidBody(failure)).not.toMatch(/Your 6 sats change/);
      // The superseded bookkeeping failure (the refused till write) is
      // logged, not silently dropped.
      expect(warn).toHaveBeenCalledWith(
        '[charge] post-swap bookkeeping failed; superseded by the change write failure',
        expect.stringMatching(/recording the payment/),
      );
    } finally {
      restore();
      warn.mockRestore();
    }
  });

  it('a settlement queue that will not read for the needs-card recovery: the charge completes', async () => {
    const card = pinCard([16]);
    const storage = jest.requireMock('../../src/services/secureStorage') as {
      getSecureStrict: jest.Mock;
    };
    const realGet = storage.getSecureStrict.getMockImplementation()!;
    // Unreadable once: the recovery's read, between the PIN and the payment.
    let verified = false;
    const transceive: Transceiver = async apdu => {
      if (insOf(apdu) === 0x40) {
        verified = true;
      }
      return card.transceive(apdu);
    };
    let refused = false;
    storage.getSecureStrict.mockImplementation(async (k: string) => {
      if (verified && !refused && k === '@cashu_settlement_queue') {
        refused = true;
        throw new Error('keychain read denied');
      }
      return realGet(k);
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await chargeCard({
        transceive,
        amountSat: 12,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      });
      expect(result.changeLoaded).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/needs-card recovery skipped/),
        expect.stringContaining('keychain read denied'),
      );
    } finally {
      storage.getSecureStrict.mockImplementation(realGet);
      warn.mockRestore();
    }
  });

  it('a failure BEFORE the swap is not paid: a SIGN that loses the tag before the card commits', async () => {
    const card = pinCard([16], {dropBeforeSign: () => true});

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[burning 16 sat/);
    expect(isPaidFailure(failure)).toBe(false);
    expect(card.burnCount).toBe(0);
    expect(testMint().swaps).toHaveLength(0);
  });

  it('a signed swap that fails ambiguously with change owed is PAID (ENG-674 blocking 2): nothing reached the till, the change is queued', async () => {
    const card = pinCard([16]);
    testMint().failAll = OFFLINE();

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    // The card already signed and burned for this bill and its own change:
    // a transport failure on the swap must never be reported unpaid, or the
    // screen offers "Tap card again" and burns the card a second time for
    // the same bill (the exact bug ENG-674 blocking 2 fixes).
    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(
      /^\[settling payment and minting change \(change owed, next tap\)/,
    );
    expect(isPaidFailure(failure)).toBe(true);
    expect(tillProofs()).toEqual([]);
    // Nothing settled or failed: the entry stays queued, witness and exact
    // outputs intact, for the drain's next online run.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(1);
  });
});

describe('the burn point: onBurnStart (ENG-645)', () => {
  it('fires once, after the PIN verify and before SPEND_ALL_SIGN', async () => {
    const card = pinCard([8, 4]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 12,
    });
    expect(preRead.plan.slots).toHaveLength(2);
    const before = card.sent.length;
    const sentAtBurnStart: number[][] = [];
    const phases: string[] = [];
    const onBurnStart = jest.fn(() => {
      sentAtBurnStart.push(card.sent.slice(before).map(insOf));
    });

    await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 12,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
      onPhase: p => phases.push(p),
      onBurnStart,
    });

    // Once, for the one payment of both pieces.
    expect(onBurnStart).toHaveBeenCalledTimes(1);
    // The PIN was verified (0x40) and no SPEND_ALL_SIGN (0x24) had gone out.
    expect(sentAtBurnStart[0]).toContain(0x40);
    expect(sentAtBurnStart[0]).not.toContain(0x24);
    // The one signature went out after it, burning both.
    const session = card.sent.slice(before).map(insOf);
    expect(session.filter(i => i === 0x24)).toHaveLength(1);
    expect(card.burnCount).toBe(2);
    // On the stage, the burn phases (one per piece) land after the verify.
    expect(phases).toContain('verifying PIN');
    expect(phases.filter(p => p.startsWith('burning'))).toEqual([
      'burning 8 sat (proof 1/2)',
      'burning 4 sat (proof 2/2)',
    ]);
    expect(phases.indexOf('verifying PIN')).toBeLessThan(
      phases.indexOf('burning 8 sat (proof 1/2)'),
    );
  });

  it('is not called when the charge fails before the burn: a wrong PIN', async () => {
    const card = pinCard([16]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    const onBurnStart = jest.fn();

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '9999',
      mintUrl: MINT_URL,
      now: 1000,
      onBurnStart,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[verifying PIN\]/);
    expect(onBurnStart).not.toHaveBeenCalled();
    expect(card.burnCount).toBe(0);
  });

  it('is not called when owed change from an earlier charge is refused before the burn', async () => {
    const card = pinCard([16], {slotCount: 4, refuseLoad: () => 0x6a84});
    await owedFromEarlierCharge([4], [card]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange).toHaveLength(1);
    const onBurnStart = jest.fn();

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
      onBurnStart,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[adding 4 sat of change owed/);
    expect(isPaidFailure(failure)).toBe(false);
    expect(onBurnStart).not.toHaveBeenCalled();
    expect(card.burnCount).toBe(0);
  });

  it('is not called when the card refuses to begin the payment', async () => {
    const card = pinCard([16]);
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    card.slots[0]!.status = 2;
    const onBurnStart = jest.fn();

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      onBurnStart,
    }).catch(e => e);

    expect(failure.message).toMatch(
      /^\[preparing the payment\] SPEND_ALL_BEGIN failed/,
    );
    expect(onBurnStart).not.toHaveBeenCalled();
    expect(isPaidFailure(failure)).toBe(false);
  });
});
