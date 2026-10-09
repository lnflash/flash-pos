/**
 * cashuCharge — Model B: enter amount, tap, exact spend with change from the
 * till. The fake card (cashuSpend.test.ts's harness, extended with VERIFY_PIN
 * and LOAD_PROOF) meets the REAL planning, till staging, and queue recording;
 * the mint adapter is the seam (its wire behaviour is cashuMint.test.ts's).
 */
import {
  CardError,
  describeStatusWord,
  isAppletNotFound,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';
import {buildCardP2PKSecret} from '../../src/services/cashuMint';
import {
  chargeCard,
  executeCharge,
  owedChangePhase,
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
  recordOwedChange,
} from '../../src/services/cashuSettlement';

const mockStore: Record<string, string> = {};
const mockMintChargeChange = jest.fn();

const mockAdapterSwap = jest.fn();

jest.mock('../../src/services/cashuMint', () => ({
  ...jest.requireActual('../../src/services/cashuMint'),
  mintChargeChange: (...args: unknown[]) => mockMintChargeChange(...args),
  // The settlement drain's swap succeeds in-test: entries settle instead of
  // hitting the real mint with structurally-fake proofs.
  createSettlementAdapter: () => ({
    swap: (...args: unknown[]) => mockAdapterSwap(...args),
    checkState: async () => 'SPENT',
  }),
}));

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

const MINT_URL = 'https://forge.flashapp.me';
const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];

const PUBKEY = [0x03, ...Array.from({length: 32}, (_, i) => 0xa0 + i)];
const CARD_PUBKEY_HEX = toHex(PUBKEY);
const KEYSET_BYTES = [0x00, 0x59, 0x53, 0x4c, 0xe0, 0xbf, 0xa1, 0x9a];
const KEYSET_ID = toHex(KEYSET_BYTES);
const SIGNATURE = Array.from({length: 64}, (_, i) => (i * 3 + 1) & 0xff);

interface SlotSpec {
  amount: number;
  status: number;
}

/** The deterministic nonce the harness reports for a seeded slot. */
const seededNonce = (slot: number) =>
  toHex(Array.from({length: 32}, (_, i) => (0x40 + slot * 4 + i) & 0xff));

/** A slot the harness holds: seeded (deterministic nonce) or loaded (the LOAD's). */
interface Cell extends SlotSpec {
  nonce?: string;
  C?: string;
  keysetId?: string;
}

function fakeCard(opts: {
  slots: SlotSpec[];
  pin?: string;
  loadsGiven?: {slot: number}[];
  /**
   * Slot count the card reports; the seeded slots fill from 0 and the rest
   * are empty. Defaults to room for any change the fixtures mint. A card with
   * exactly `slots.length` is full.
   */
  maxSlots?: number;
  /**
   * The n-th LOAD attempt (0-based, counted across sessions) answers 6A84
   * even though a slot was free.
   */
  refuseLoad?: (loadAttempt: number) => boolean;
  /**
   * The n-th LOAD attempt lands on the card but its answer never reaches the
   * host: the tag is reported lost instead (the card does not dedup, so the
   * host must re-read before re-sending).
   */
  loseAnswerOnLoad?: (loadAttempt: number) => boolean;
}) {
  const sent: number[][] = [];
  const loads: {keysetId: string; amount: number; nonce: string; C: string}[] = [];
  const burned = new Set<number>();
  const maxSlots = opts.maxSlots ?? opts.slots.length + 8;
  const cells: (Cell | null)[] = Array.from({length: maxSlots}, (_, i) =>
    i < opts.slots.length ? {...opts.slots[i]} : null,
  );
  const statusOf = (i: number): number => {
    const c = cells[i];
    if (!c) {return 0x00;}
    return burned.has(i) ? 0x02 : c.status;
  };
  let burnCount = 0;
  let loadAttempts = 0;
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const [, ins] = apdu;
    const p1 = apdu[2];
    switch (ins) {
      case 0xa4:
        // SELECT: v0.2 applet.
        return ok([0, 2]);
      case 0x01: {
        const counts = cells.map((_, i) => statusOf(i));
        const unspent = counts.filter(st => st === 0x01).length;
        const spent = counts.filter(st => st === 0x02).length;
        const empty = counts.filter(st => st === 0x00).length;
        return ok([
          0,
          2,
          maxSlots,
          unspent,
          spent,
          empty,
          0x03,
          opts.pin === undefined ? 0x00 : 0x01,
        ]);
      }
      case 0x10:
        return ok(PUBKEY);
      case 0x11: {
        const bal = cells
          .map((c, i) => (c && statusOf(i) === 0x01 ? c.amount : 0))
          .reduce((t, a) => t + a, 0);
        return ok([0, 0, (bal >> 8) & 0xff, bal & 0xff]);
      }
      case 0x40:
        if (opts.pin === undefined) return sw(0x6984);
        const given = apdu.slice(5, 5 + apdu[4]);
        const expected = Array.from(opts.pin).map(c => c.charCodeAt(0));
        return Buffer.from(given).equals(Buffer.from(expected)) ? ok() : sw(0x63c2);
      case 0x14:
        return ok(cells.map((_, i) => statusOf(i)));
      case 0x13: {
        const s = cells[p1];
        if (!s) {return sw(0x6a88);}
        const status = statusOf(p1);
        const nonceHex = s.nonce ?? seededNonce(p1);
        const nonce = (nonceHex.match(/../g) ?? []).map(h => parseInt(h, 16));
        const c = s.C
          ? (s.C.match(/../g) ?? []).map(h => parseInt(h, 16))
          : [0x02, ...Array.from({length: 32}, (_, i) => (0x80 + p1 * 2 + i) & 0xff)];
        const keyset = s.keysetId
          ? (s.keysetId.match(/../g) ?? []).map(h => parseInt(h, 16))
          : KEYSET_BYTES;
        const a = s.amount;
        return ok([
          status,
          ...keyset,
          (a >>> 24) & 0xff,
          (a >>> 16) & 0xff,
          (a >>> 8) & 0xff,
          a & 0xff,
          ...nonce,
          ...c,
        ]);
      }
      case 0x20:
        burnCount += 1;
        burned.add(p1);
        return ok(SIGNATURE);
      case 0x30: {
        const loadIndex = loadAttempts++;
        const body = apdu.slice(5, 5 + apdu[4]);
        const amount = (body[8] << 24) | (body[9] << 16) | (body[10] << 8) | body[11];
        const record = {
          keysetId: toHex(body.slice(0, 8)),
          amount,
          nonce: toHex(body.slice(12, 44)),
          C: toHex(body.slice(44, 77)),
        };
        const free = cells.findIndex(c => c === null);
        if (free === -1 || opts.refuseLoad?.(loadIndex)) {
          return sw(0x6a84);
        }
        loads.push(record);
        cells[free] = {...record, status: 0x01};
        (opts.loadsGiven ?? (opts.loadsGiven = [])).push({slot: free});
        if (opts.loseAnswerOnLoad?.(loadIndex)) {
          throw new Error('Tag was lost.');
        }
        return ok([free]);
      }
      default:
        return sw(0x6d00);
    }
  };
  return {
    transceive,
    sent,
    loads,
    get burnCount() {return burnCount;},
    /** Slot statuses as `getSlotStatuses` would decode them now. */
    get statuses() {
      return cells.map(
        (_, i) => (['empty', 'unspent', 'spent'] as const)[statusOf(i)],
      );
    },
  };
}

function seedTill(proofs: {amount: number; denom: number}[]) {
  mockStore['@cashu_settled_proofs'] = JSON.stringify(
    proofs.map((p, i) => ({
      id: KEYSET_ID,
      amount: p.amount,
      // Canonical P2PK secrets, as real till proofs carry — the change-write
      // recovers the nonce from them, so fixtures must be well-formed.
      secret: buildCardP2PKSecret(
        Array.from({length: 32}, (_, j) => (0x50 + i * 8 + j) & 0xff)
          .map(b => b.toString(16).padStart(2, '0'))
          .join(''),
        CARD_PUBKEY_HEX,
      ),
      C: CARD_PUBKEY_HEX,
      mintUrl: MINT_URL,
    })),
  );
}

const tillProofs = () =>
  JSON.parse(mockStore['@cashu_settled_proofs'] ?? '[]') as {
    secret: string;
    amount: number;
  }[];

beforeEach(async () => {
  jest.clearAllMocks();
  mockAdapterSwap.mockResolvedValue(undefined);
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  await clearQueue();
});

describe('planPurchase', () => {
  const slots = [
    {slot: 0, amount: 16, keysetId: KEYSET_ID, nonce: 'aa', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
    {slot: 1, amount: 4, keysetId: KEYSET_ID, nonce: 'bb', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
    {slot: 2, amount: 1, keysetId: KEYSET_ID, nonce: 'cc', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
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
    const rich = [
      ...slots,
      {slot: 3, amount: 256, keysetId: KEYSET_ID, nonce: 'dd', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
    ];
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
});

describe('readAndPlan', () => {
  it('reads, plans and reports the phases', async () => {
    const card = fakeCard({
      slots: [
        {amount: 8, status: 0x01},
        {amount: 16, status: 0x01},
      ],
    });
    const phases: string[] = [];

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
      onPhase: phase => phases.push(phase),
    });

    expect(preRead.plan.burnedSat).toBe(16);
    expect(preRead.cardPubkey).toBe(CARD_PUBKEY_HEX);
    expect(phases[0]).toBe('reading card');
  });

  it('wraps a phase failure with the phase in the message and the CardError as cause', async () => {
    // A BoltCard (NTAG 424 DNA) answers the applet SELECT with 0x6A82: the
    // router must be able to tell that apart from a Cashu card that failed,
    // by class and status word, after the phase wrapper has re-thrown it.
    const transceive: Transceiver = async () => sw(0x6a82);

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
    const transceive: Transceiver = async () => sw(0x6983);

    const failure = await readAndPlan({transceive, amountSat: 16}).catch(
      e => e,
    );

    expect(failure).toBeInstanceOf(PhaseError);
    expect((failure.cause as CardError).sw).toBe(0x6983);
    expect(isAppletNotFound(failure)).toBe(false);
  });
});

describe('chargeCard', () => {
  it('exact charge: verifies PIN, burns, settles inline — the take joins the till', async () => {
    const card = fakeCard({
      slots: [
        {amount: 16, status: 0x01},
        {amount: 4, status: 0x01},
        {amount: 1, status: 0x01},
      ],
      pin: '1234',
    });
    seedTill([{amount: 8, denom: 8}]);
    mockMintChargeChange.mockResolvedValue({
      change: [],
      till: [
        {
          id: KEYSET_ID,
          amount: 5,
          secret: buildCardP2PKSecret('aa'.repeat(32), CARD_PUBKEY_HEX),
          C: CARD_PUBKEY_HEX,
          mintUrl: MINT_URL,
        },
      ],
    });

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
    expect(result.burned).toHaveLength(2);
    expect(mockMintChargeChange).toHaveBeenCalledWith(
      expect.objectContaining({changeSat: 0}),
    );

    // VERIFY_PIN before any burn (D13): its APDU precedes the SPEND_PROOFs.
    const verifyIdx = card.sent.findIndex(([, ins]) => ins === 0x40);
    const burnIdx = card.sent.findIndex(([, ins]) => ins === 0x20);
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(burnIdx);

    // The exact-bill swap settled inline — no dependence on the drain.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(2);
    expect(tillProofs()).toHaveLength(2);
    expect(tillProofs().some(t => t.amount === 5)).toBe(true);
  });

  it('exact bill with a failed swap defers to the drain instead of failing', async () => {
    const card = fakeCard({
      slots: [
        {amount: 16, status: 0x01},
        {amount: 4, status: 0x01},
        {amount: 1, status: 0x01},
      ],
      pin: '1234',
    });
    seedTill([{amount: 8, denom: 8}]);
    mockMintChargeChange.mockRejectedValue(new Error('429 rate limited'));

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 5,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    // The customer's payment still completes; the burned entries stay
    // 'pending' for the drain (nothing owed back onto the card).
    expect(result.changeSat).toBe(0);
    expect(result.changeLoaded).toBe(0);
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(2);
    expect(tillProofs()).toHaveLength(1);
  });

  it('makes change from the till and writes it back onto the card', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
    });
    seedTill([
      {amount: 4, denom: 4},
      {amount: 2, denom: 2},
    ]);
    // The change proofs are minted P2PK-locked to the customer's card —
    // canonical secrets whose nonces round-trip through the LOAD.
    const changeNonces = ['77'.repeat(32), '88'.repeat(32)];
    mockMintChargeChange.mockResolvedValue({
      change: [
        {
          id: KEYSET_ID,
          amount: 4,
          secret: buildCardP2PKSecret(changeNonces[0], CARD_PUBKEY_HEX),
          C: CARD_PUBKEY_HEX,
          mintUrl: MINT_URL,
        },
        {
          id: KEYSET_ID,
          amount: 2,
          secret: buildCardP2PKSecret(changeNonces[1], CARD_PUBKEY_HEX),
          C: CARD_PUBKEY_HEX,
          mintUrl: MINT_URL,
        },
      ],
      till: [
        {
          id: KEYSET_ID,
          amount: 10,
          secret: 'aa'.repeat(32),
          C: CARD_PUBKEY_HEX,
          mintUrl: MINT_URL,
        },
      ],
    });

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.burned).toHaveLength(1);
    expect(result.changeSat).toBe(6);
    expect(mockMintChargeChange).toHaveBeenCalledWith(
      expect.objectContaining({changeSat: 6, p2pkPubkey: CARD_PUBKEY_HEX}),
    );
    expect(result.changeLoaded).toBe(2);
    expect(card.loads.map(l => l.nonce)).toEqual(changeNonces);
    // The swap consumed the burned proofs: the entry ends settled, and the
    // merchant's take joined the till.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
    expect(tillProofs().some(t => t.amount === 10)).toBe(true);
    await expect(hasUnsettledForCard(CARD_PUBKEY_HEX)).resolves.toBe(false);
  });

  it('an online charge mints change even when the till was short', async () => {
    // The till (16) cannot back the 6-sat change up front — but ONLINE the
    // burned value settles in-session and backs the change itself. The old
    // pre-burn refusal would have blocked a legitimate payment.
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
    });
    seedTill([{amount: 16, denom: 16}]);

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
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
  });

  it('a failed change-mint records the burns and reports the owed change honestly', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
    });
    seedTill([{amount: 16, denom: 16}]);
    mockMintChargeChange.mockRejectedValue(
      new Error('the till cannot make 6 sat exact change'),
    );

    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
        now: 1000,
      }),
    ).rejects.toThrow(/cannot make 6 sat/);
    // The swap never landed: the burn entry stays PENDING with its witness
    // intact — the next online auto-run settles it. Nothing is lost, and the
    // UI did not claim success.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(1);
    expect(tillProofs()).toHaveLength(1);
  });

  it('a wrong PIN burns nothing', async () => {
    const card = fakeCard({
      slots: [{amount: 4, status: 0x01}],
      pin: '1234',
    });
    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 4,
        pin: '9999',
        mintUrl: MINT_URL,
      }),
    ).rejects.toBeTruthy();
    const burnApdu = card.sent.find(([, ins]) => ins === 0x20);
    expect(burnApdu).toBeUndefined();
    await expect(listSettlements()).resolves.toEqual([]);
  });

  it('the nonce written back is the one the change was minted with', async () => {
    const card = fakeCard({slots: [{amount: 16, status: 0x01}], pin: '1234'});
    seedTill([{amount: 4, denom: 4}, {amount: 2, denom: 2}]);
    const changeNonce = '99'.repeat(32);
    mockMintChargeChange.mockResolvedValue({
      change: [
        {
          id: KEYSET_ID,
          amount: 6,
          secret: buildCardP2PKSecret(changeNonce, CARD_PUBKEY_HEX),
          C: CARD_PUBKEY_HEX,
          mintUrl: MINT_URL,
        },
      ],
      till: [],
    });

    await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
    });

    // The LOAD carries the nonce from the minted P2PK secret, so the
    // customer's later spend reconstructs exactly what the mint signed.
    expect(card.loads.map(l => l.nonce)).toEqual([changeNonce]);
  });
});

/** A minted change proof P2PK-locked to the test card, in the adapter's shape. */
const changeProof = (amount: number, nonce: string) => ({
  id: KEYSET_ID,
  amount,
  secret: buildCardP2PKSecret(nonce, CARD_PUBKEY_HEX),
  C: CARD_PUBKEY_HEX,
  mintUrl: MINT_URL,
});

const insOf = (apdu: number[]) => apdu[1];

/** The card's own 6A84, by class and status word: raw, or as a PhaseError's cause. */
const expectCardFull = (failure: unknown) => {
  const cause =
    failure instanceof PhaseError ? (failure.cause as unknown) : failure;
  expect(cause).toBeInstanceOf(CardError);
  expect((cause as CardError).sw).toBe(0x6a84);
};

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

describe('slot pre-flight (ENG-630)', () => {
  it('a full card is refused BEFORE anything burns', async () => {
    // One slot, holding 16; a 10-sat bill needs 6 sat of change = 2 slots.
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      maxSlots: 1,
    });

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
    ).rejects.toThrow(/this card is full: 6 sat of change needs 2 free slots and the card has 0/);

    // Same assertion as "a wrong PIN burns nothing": no SPEND_PROOF went out.
    expect(card.sent.find(a => insOf(a) === 0x20)).toBeUndefined();
    expect(card.sent.find(a => insOf(a) === 0x30)).toBeUndefined();
    await expect(listSettlements()).resolves.toEqual([]);
    expect(mockMintChargeChange).not.toHaveBeenCalled();
  });

  it('picks the cheapest plan whose change fits the free slots', async () => {
    // 13 → change 3 (2 pieces), 18 → change 8 (1 piece). One free slot:
    // the cheaper change does not fit, the next does.
    const card = fakeCard({
      slots: [
        {amount: 13, status: 0x01},
        {amount: 18, status: 0x01},
      ],
      maxSlots: 3,
    });

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 10,
    });

    expect(preRead.plan).toEqual({slots: [1], burnedSat: 18, changeSat: 8});
    expect(preRead.emptySlots).toBe(1);
    expect(preRead.owedChange).toEqual([]);
  });

  it('an exact bill goes through on a full card', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      maxSlots: 1,
    });

    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });

    expect(preRead.plan.changeSat).toBe(0);
  });

  it('change owed from an earlier charge takes its slots off the top', async () => {
    await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32)), changeProof(2, '72'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    // Two slots free, two owed pieces, and a 10-sat bill wanting 6 sat of
    // change (two more): refused, with the owed change named.
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      maxSlots: 3,
    });

    await expect(
      readAndPlan({transceive: card.transceive, amountSat: 10}),
    ).rejects.toThrow(/this card is full: 6 sat of change needs 2 free slots and the card has 0/);

    // One slot free for two owed pieces and an EXACT bill: the charge needs
    // no slot, so it goes through; the one piece that fits is written and
    // the other stays owed on disk for a later tap. (The card ENG-630 came
    // from is full with change owed — it must be able to pay again.)
    const tight = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      maxSlots: 2,
    });
    const preRead = await readAndPlan({
      transceive: tight.transceive,
      amountSat: 16,
    });
    expect(preRead.plan.changeSat).toBe(0);
    expect(preRead.emptySlots).toBe(1);
    expect(preRead.owedChange.map(e => e.amount)).toEqual([4]);
    await expect(
      outstandingChangeForCard(CARD_PUBKEY_HEX),
    ).resolves.toHaveLength(2);

    // No slot free at all, exact bill: nothing owed is written, the charge
    // still goes through, the change stays owed.
    const full = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      maxSlots: 1,
    });
    const onFull = await readAndPlan({
      transceive: full.transceive,
      amountSat: 16,
    });
    expect(onFull.plan.changeSat).toBe(0);
    expect(onFull.owedChange).toEqual([]);
  });

  it('an exact bill on a full card owed change: the charge completes and the change is still owed after', async () => {
    const [owed] = await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      maxSlots: 1,
    });
    mockMintChargeChange.mockResolvedValueOnce({change: [], till: []});

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    expect(card.burnCount).toBe(1);
    expect(card.sent.find(a => insOf(a) === 0x30)).toBeUndefined();
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 0}),
    ]);
  });
});

describe('owed change (ENG-630)', () => {
  beforeEach(() => {
    // `clearAllMocks` leaves a queued `mockResolvedValueOnce` in place; a
    // test that fails before consuming it would hand it to the next one.
    mockMintChargeChange.mockReset();
  });

  const owedStore = () =>
    JSON.parse(mockStore[OWED_CHANGE_KEY] ?? '{"v":1,"entries":[]}').entries as {
      id: string;
      amount: number;
      nonce: string;
      status: string;
      slot?: number;
      attempts: number;
      lastError?: string;
    }[];

  it('records the minted change durably BEFORE the first LOAD_PROOF', async () => {
    const card = fakeCard({slots: [{amount: 16, status: 0x01}], pin: '1234'});
    const nonces = ['77'.repeat(32), '88'.repeat(32)];
    mockMintChargeChange.mockResolvedValue({
      change: [changeProof(4, nonces[0]), changeProof(2, nonces[1])],
      till: [],
    });
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
    const recorded = JSON.parse(storeAtFirstLoad as unknown as string).entries;
    expect(recorded.map((e: {nonce: string}) => e.nonce)).toEqual(nonces);
    expect(recorded.every((e: {status: string}) => e.status === 'owed')).toBe(
      true,
    );
    // Both loads answered: both pieces are written, with their slots.
    expect(owedStore().map(e => [e.status, e.slot])).toEqual([
      ['written', 1],
      ['written', 2],
    ]);
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual(
      [],
    );
  });

  it('a 6A84 on the second piece leaves the piece owed on disk, the burn settled, and the next tap writes it first', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      // The card reported room at read time; the second LOAD is refused
      // anyway (the pre-flight cannot see a slot the card loses between the
      // read tap and the PIN tap).
      refuseLoad: i => i === 1,
    });
    const nonces = ['77'.repeat(32), '88'.repeat(32)];
    mockMintChargeChange.mockResolvedValueOnce({
      change: [changeProof(4, nonces[0]), changeProof(2, nonces[1])],
      till: [],
    });

    const failure = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expect(failure.message).toMatch(/^\[writing change to card\] LOAD_PROOF failed: card is full/);
    expectCardFull(failure);
    // The burn settled at the mint: the merchant's money is accounted for.
    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'settled')).toHaveLength(1);
    // One piece on the card, one still owed — with the refusal recorded.
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'owed', undefined],
    ]);
    const owed = await outstandingChangeForCard(CARD_PUBKEY_HEX);
    expect(owed.map(e => e.amount)).toEqual([2]);

    // The next tap, same card: it now holds the 4-sat piece (unspent) and
    // the burned slot. A 4-sat bill is exact; the owed 2 sat goes on first.
    const before = card.sent.length;
    mockMintChargeChange.mockResolvedValueOnce({change: [], till: []});
    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 4,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    const session = card.sent.slice(before).map(insOf);
    const verifyIdx = session.indexOf(0x40);
    const loadIdx = session.indexOf(0x30);
    const burnIdx = session.indexOf(0x20);
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(verifyIdx);
    expect(burnIdx).toBeGreaterThan(loadIdx);
    expect(card.loads.map(l => l.nonce)).toEqual(nonces);
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'written', 2],
    ]);
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual(
      [],
    );
  });

  it('a lost LOAD answer is reconciled from the card: the piece is found in its slot and never re-sent', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      loseAnswerOnLoad: i => i === 0,
    });
    const nonce = '99'.repeat(32);
    mockMintChargeChange.mockResolvedValueOnce({
      change: [changeProof(4, nonce)],
      till: [],
    });

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
      expect.objectContaining({amount: 4, status: 'owed', nonce}),
    ]);

    // Next tap: the card holds the piece (the LOAD landed). The read finds
    // the nonce in slot 1, marks it written, and sends no LOAD.
    const loadsBefore = card.sent.filter(a => insOf(a) === 0x30).length;
    const sentBefore = card.sent.length;
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 4,
      now: 2000,
    });

    expect(preRead.owedChange).toEqual([]);
    expect(card.sent.filter(a => insOf(a) === 0x30)).toHaveLength(loadsBefore);
    // The unspent slot was read once for the plan and seeded into the
    // reconcile from memory; only the spent slot cost a second GET_PROOF.
    expect(
      card.sent
        .slice(sentBefore)
        .filter(a => insOf(a) === 0x13)
        .map(a => a[2])
        .sort(),
    ).toEqual([0, 1]);
    expect(owedStore()).toEqual([
      expect.objectContaining({status: 'written', slot: 1}),
    ]);
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual(
      [],
    );
  });

  it('reconcileOwedChange reads nothing when the card is owed nothing', async () => {
    const card = fakeCard({slots: [{amount: 16, status: 0x01}]});

    await expect(
      reconcileOwedChange({
        transceive: card.transceive,
        cardPubkey: CARD_PUBKEY_HEX,
        statuses: ['unspent', 'empty'],
        now: 1000,
      }),
    ).resolves.toEqual([]);
    expect(card.sent).toEqual([]);
  });

  it('reconcileOwedChange reads spent slots too, and leaves another card\'s change alone', async () => {
    const other = '03' + 'cd'.repeat(32);
    await recordOwedChange(
      other,
      [changeProof(4, '71'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(2, seededNonce(0))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    // Slot 0 is SPENT and carries the owed nonce: still readable, still a
    // match (a lost LOAD answer followed by a spend).
    const card = fakeCard({
      slots: [
        {amount: 2, status: 0x02},
        {amount: 16, status: 0x01},
      ],
    });

    const remaining = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: CARD_PUBKEY_HEX,
      statuses: card.statuses,
      now: 2000,
    });

    expect(remaining).toEqual([]);
    expect(card.sent.filter(a => insOf(a) === 0x13).map(a => a[2])).toEqual([
      0, 1,
    ]);
    await expect(outstandingChangeForCard(other)).resolves.toHaveLength(1);
  });

  it('reconcileOwedChange seeds known slots from memory and reads only the rest', async () => {
    await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, seededNonce(1)), changeProof(2, '72'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    const card = fakeCard({
      slots: [
        {amount: 2, status: 0x02},
        {amount: 4, status: 0x01},
        {amount: 16, status: 0x01},
      ],
    });
    const known = [1, 2].map(slot => ({
      slot,
      status: 'unspent' as const,
      keysetId: KEYSET_ID,
      amount: slot === 1 ? 4 : 16,
      nonce: seededNonce(slot),
      C: '02' + 'ab'.repeat(32),
    }));

    const remaining = await reconcileOwedChange({
      transceive: card.transceive,
      cardPubkey: CARD_PUBKEY_HEX,
      statuses: card.statuses,
      known,
      now: 2000,
    });

    // The 4-sat piece was found in the known slot 1 without an APDU; only
    // the spent slot 0 was read.
    expect(card.sent.filter(a => insOf(a) === 0x13).map(a => a[2])).toEqual([
      0,
    ]);
    expect(remaining.map(e => e.amount)).toEqual([2]);
    expect(owedStore().map(e => [e.amount, e.status, e.slot])).toEqual([
      [4, 'written', 1],
      [2, 'owed', undefined],
    ]);
  });

  it('writeOwedChange marks each piece as the card answers and records a refusal', async () => {
    const [a, b] = await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32)), changeProof(2, '72'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    const card = fakeCard({slots: [], maxSlots: 1});
    const phases: string[] = [];

    const failure = await writeOwedChange({
      transceive: card.transceive,
      owed: [a, b],
      now: 2000,
      onPhase: p => phases.push(p),
    }).catch(e => e);

    expect(failure).toBeInstanceOf(PhaseError);
    expectCardFull(failure);
    expect(failure.message).toBe(
      `[${owedChangePhase(2)}] LOAD_PROOF failed: card is full — no free slot (0x6A84)`,
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

  it('executeCharge writes the owed change after the PIN and before any burn, and a refusal there burns nothing', async () => {
    const [owed] = await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      refuseLoad: () => true,
    });
    const preRead = await readAndPlan({
      transceive: card.transceive,
      amountSat: 16,
    });
    expect(preRead.owedChange).toEqual([owed]);

    const failure = await executeCharge({
      ...preRead,
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    }).catch(e => e);

    expectCardFull(failure);
    expect(card.sent.find(a => insOf(a) === 0x20)).toBeUndefined();
    await expect(listSettlements()).resolves.toEqual([]);
    expect(mockMintChargeChange).not.toHaveBeenCalled();
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual([
      expect.objectContaining({id: owed.id, status: 'owed', attempts: 1}),
    ]);
  });

  it('a record that will not land is logged and the change still goes onto the card', async () => {
    const card = fakeCard({slots: [{amount: 16, status: 0x01}], pin: '1234'});
    mockMintChargeChange.mockResolvedValue({
      change: [changeProof(4, '77'.repeat(32)), changeProof(2, '88'.repeat(32))],
      till: [],
    });
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

  it('a change write that fails with NO record landed is reported under the unrecorded phase', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
      refuseLoad: i => i === 1,
    });
    mockMintChargeChange.mockResolvedValue({
      change: [
        changeProof(4, '77'.repeat(32)),
        changeProof(2, '88'.repeat(32)),
      ],
      till: [],
    });
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
      expect(failure.message).toBe(
        `[${PHASE_WRITING_CHANGE_UNRECORDED}] LOAD_PROOF failed: card is full — no free slot (0x6A84)`,
      );
      expectCardFull(failure);
      // The stage still saw the ordinary change-write phase, once per piece.
      expect(phases.filter(p => p === 'writing change to card')).toHaveLength(
        2,
      );
      expect(phases).not.toContain(PHASE_WRITING_CHANGE_UNRECORDED);
      expect(mockStore[OWED_CHANGE_KEY]).toBeUndefined();
    } finally {
      storage.setSecure.mockImplementation(realSet);
      warn.mockRestore();
    }
  });

  it('one unparseable element in the owed store does not refuse the charge: the good piece is still written', async () => {
    const [owed] = await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
    // A downgraded build meeting a status it does not know, say.
    const envelope = JSON.parse(mockStore[OWED_CHANGE_KEY]);
    envelope.entries.push({...owed, id: 'future', status: 'future-status'});
    mockStore[OWED_CHANGE_KEY] = JSON.stringify(envelope);
    const card = fakeCard({slots: [{amount: 16, status: 0x01}], pin: '1234'});
    mockMintChargeChange.mockResolvedValueOnce({change: [], till: []});

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 16,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 2000,
    });

    expect(result.changeSat).toBe(0);
    expect(card.loads.map(l => l.nonce)).toEqual([owed.nonce]);
    expect(owedStore().map(e => [e.id, e.status, e.slot])).toEqual([
      [owed.id, 'written', 1],
    ]);
    await expect(outstandingChangeForCard(CARD_PUBKEY_HEX)).resolves.toEqual(
      [],
    );
  });

  it('listOwedChange enumerates the store', async () => {
    await recordOwedChange(
      CARD_PUBKEY_HEX,
      [changeProof(4, '71'.repeat(32))],
      {mintUrl: MINT_URL, unit: 'sat'},
      1000,
    );
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
