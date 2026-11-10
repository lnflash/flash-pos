/**
 * cashuTopUp (ENG-853): rounding, the room check, the `@cashu_topups` store,
 * the quote poll and the load onto the card. The card is the APDU-level
 * FakeCard2; the mint calls are mocked at cashuMint's top-up seam, with real
 * blind signatures from the shared TestMint so a piece's C is the mint's
 * signature on exactly the secret the card will rebuild.
 */
import {bytesToHex} from '@noble/hashes/utils';

import {
  beginTopUpRefund,
  canTopUp,
  CORRUPT_TOPUP_KEY,
  listTopUps,
  loadTopUp,
  MAX_TOPUP_ENTRIES,
  NULL_EXPIRY_HOLD_MS,
  normalizeRefundDestination,
  pollTopUp,
  PRECHECK_TIMEOUT_MS,
  previewTopUpRefund,
  refreshWaitingTopUps,
  refundTopUp,
  reservedPiecesFor,
  resumeTopUpRefund,
  roundTopUp,
  startTopUp,
  TOPUP_KEY,
  TopUpError,
  topUpErrorCopy,
  topUpQuarantineKeyFor,
  TopUpStoreError,
  waitingTopUpsForCard,
  __resetTopUpStore,
  type TopUpEntry,
  type TopUpRefund,
} from '../../src/services/cashuTopUp';
import {readCard, type CardSummary} from '../../src/services/cashuCard';
import {
  buildCardSigAllSecret,
  MeltBudgetError,
  TopUpMintError,
  type RefundProof,
  type TopUpOutput,
} from '../../src/services/cashuMint';
import {OWED_CHANGE_KEY} from '../../src/services/cashuSettlement';
import {
  FakeCard2,
  KEYSET_ID,
  MINT_URL,
  resetTestMint,
  testMint,
} from '../support/cardProtocol2';

const mockStore: Record<string, string> = {};
const mockStoreFault: {read: unknown; write: unknown} = {
  read: null,
  write: null,
};

jest.mock('../../src/services/secureStorage', () => ({
  getSecureStrict: jest.fn(async (k: string) => {
    if (mockStoreFault.read) {
      throw mockStoreFault.read;
    }
    return mockStore[k] ?? null;
  }),
  getSecure: jest.fn(async (k: string) => mockStore[k] ?? null),
  setSecure: jest.fn(async (k: string, v: string) => {
    if (mockStoreFault.write) {
      throw mockStoreFault.write;
    }
    mockStore[k] = v;
  }),
  removeSecure: jest.fn(async (k: string) => {
    delete mockStore[k];
  }),
}));

jest.mock('../../src/services/cashuMint', () => {
  const actual = jest.requireActual('../../src/services/cashuMint');
  return {
    ...actual,
    createTopUpQuote: jest.fn(),
    checkTopUpQuote: jest.fn(),
    mintTopUp: jest.fn(),
    restoreTopUp: jest.fn(),
    topUpKeyset: jest.fn(),
    createRefundQuote: jest.fn(),
    checkRefundMelt: jest.fn(),
    meltRefund: jest.fn(),
  };
});

const cashu = jest.requireActual('@cashu/cashu-ts');
const mintMocks = jest.requireMock('../../src/services/cashuMint') as {
  createTopUpQuote: jest.Mock;
  checkTopUpQuote: jest.Mock;
  mintTopUp: jest.Mock;
  restoreTopUp: jest.Mock;
  topUpKeyset: jest.Mock;
  createRefundQuote: jest.Mock;
  checkRefundMelt: jest.Mock;
  meltRefund: jest.Mock;
};

/** The TestMint's signatures on `outputs`, unblinded as cashuMint would. */
function signOutputs(outputs: TopUpOutput[]) {
  const m = testMint();
  return outputs.map(o => {
    const sig = m.sign(o.B_, o.amount);
    const C = cashu
      .unblindSignature(
        cashu.pointFromHex(sig.C_),
        BigInt(`0x${o.r}`),
        cashu.pointFromHex(m.keys[String(o.amount)]),
      )
      .toHex(true);
    return {amount: o.amount, C, dleq: sig.dleq};
  });
}

const QUOTE = 'quote-0123456789abcdef';
const BOLT11 = 'lnbc50n1ptopuptest';

function storedEntries(): TopUpEntry[] {
  const raw = mockStore[TOPUP_KEY];
  return raw ? (JSON.parse(raw).entries as TopUpEntry[]) : [];
}

async function summaryOf(card: FakeCard2): Promise<CardSummary> {
  const s = await readCard(card.transceive);
  card.sent.length = 0;
  return s;
}

async function startOn(
  card: FakeCard2,
  sat = 5,
  overrides: Partial<Parameters<typeof startTopUp>[0]> = {},
) {
  mintMocks.createTopUpQuote.mockResolvedValueOnce({
    quoteId: QUOTE,
    request: BOLT11,
    expiry: 2_000_000_000,
    amount: roundTopUp(sat).amountSat,
  });
  return startTopUp({
    summary: await summaryOf(card),
    cardMint: MINT_URL,
    owedPieces: 0,
    sat,
    ...overrides,
  });
}

beforeEach(() => {
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  mockStoreFault.read = null;
  mockStoreFault.write = null;
  __resetTopUpStore();
  jest.clearAllMocks();
  for (const m of [
    mintMocks.createTopUpQuote,
    mintMocks.checkTopUpQuote,
    mintMocks.mintTopUp,
    mintMocks.restoreTopUp,
    mintMocks.topUpKeyset,
    mintMocks.createRefundQuote,
    mintMocks.checkRefundMelt,
    mintMocks.meltRefund,
  ]) {
    m.mockReset();
  }
  resetTestMint();
  mintMocks.checkTopUpQuote.mockResolvedValue('PAID');
  mintMocks.topUpKeyset.mockImplementation(async () =>
    testMint().cachedKeyset(),
  );
  mintMocks.mintTopUp.mockImplementation(
    async (_url: string, _quote: string, outputs: TopUpOutput[]) =>
      signOutputs(outputs),
  );
  mintMocks.restoreTopUp.mockResolvedValue(null);
  mintMocks.createRefundQuote.mockImplementation(
    async (
      _url: string,
      dest: {bolt11?: string; lightningAddress?: string},
      budget: number,
    ) => ({
      meltQuoteId: 'melt-1',
      request: dest.bolt11 ?? `lnbc-for-${dest.lightningAddress}`,
      amountSat: budget - 2,
      feeReserveSat: 2,
      expiry: 2_000_000_000,
    }),
  );
  mintMocks.checkRefundMelt.mockResolvedValue({
    state: 'UNPAID',
    preimage: null,
    expiry: 2_000_000_000,
  });
  mintMocks.meltRefund.mockResolvedValue({
    state: 'PAID',
    preimage: 'preimage-1',
    change: [],
  });
});

describe('roundTopUp', () => {
  it.each([
    [1, 1, [1]],
    [7, 7, [4, 2, 1]],
    [5, 5, [4, 1]],
    [1000, 1024, [1024]],
    // 15 sits between 14 (8+4+2) and 16: a tie goes to the lower one.
    [15, 14, [8, 4, 2]],
    [65537, 65537, [65536, 1]],
    [99999, 99328, [65536, 32768, 1024]],
    [100000, 99328, [65536, 32768, 1024]],
  ])('%i rounds to %i', (sat, amount, pieces) => {
    expect(roundTopUp(sat)).toEqual({amountSat: amount, pieces});
  });

  it('always answers at most three powers of two, at or below the cap', () => {
    for (let sat = 1; sat <= 100000; sat += 37) {
      const {amountSat, pieces} = roundTopUp(sat);
      expect(pieces.length).toBeLessThanOrEqual(3);
      expect(amountSat).toBeLessThanOrEqual(100000);
      expect(pieces.reduce((t, p) => t + p, 0)).toBe(amountSat);
      expect(new Set(pieces).size).toBe(pieces.length);
      for (const p of pieces) {
        expect(Math.log2(p) % 1).toBe(0);
      }
    }
  });

  it.each([0, -5, 1.5, Number.NaN, 100001, Infinity])(
    'refuses %p as bad_amount',
    sat => {
      expect(() => roundTopUp(sat)).toThrow(TopUpError);
      try {
        roundTopUp(sat);
      } catch (error) {
        expect((error as TopUpError).kind).toBe('bad_amount');
      }
    },
  );
});

describe('canTopUp', () => {
  const base = async (opts = {}) =>
    summaryOf(new FakeCard2({slotCount: 4, ...opts}));

  it('lets an open sats card with room through', async () => {
    expect(canTopUp(await base(), 0, {pieces: 3})).toBeNull();
  });

  it('refuses a locked card, a blocked PIN and a card not in sats', async () => {
    expect(canTopUp(await base({locked: true}), 0)).toBe('card_locked');
    expect(canTopUp(await base({pin: '1234', pinBlocked: true}), 0)).toBe(
      'pin_blocked',
    );
    expect(canTopUp(await base(), 0, {unit: 1})).toBe('not_sats');
  });

  it("keeps the owed change's slots: fewer free than pieces is full, never fewer pieces", async () => {
    const s = await base();
    expect(s.info.empty).toBe(4);
    expect(canTopUp(s, 1, {pieces: 3})).toBeNull();
    expect(canTopUp(s, 2, {pieces: 3})).toBe('card_full');
    expect(canTopUp(s, 0, {pieces: 5})).toBe('card_full');
  });
});

describe('topUpErrorCopy', () => {
  it('uses the Fedimint titles', () => {
    expect(topUpErrorCopy('card_full').title).toBe('This card is full');
    expect(topUpErrorCopy('card_moved').title).toBe('The card moved away');
    expect(topUpErrorCopy('not_our_card').title).toBe(
      'Not a card for this till',
    );
    expect(topUpErrorCopy('expired')).toEqual({
      title: 'The invoice expired',
      body: 'Nothing was paid. Make a new invoice to try again.',
    });
    expect(topUpErrorCopy('not_loaded')).toEqual({
      title: 'Not loaded yet',
      body: 'The top-up is paid and waiting. Tap the card to load it.',
    });
    expect(topUpErrorCopy('mint_unreachable').title).toBe(
      "Can't reach the card's mint",
    );
    expect(topUpErrorCopy('mint_timeout').title).toBe('The mint took too long');
    expect(topUpErrorCopy('bad_amount').title).toBe(
      "That amount can't go on a card",
    );
    expect(topUpErrorCopy('failed').title).toBe('The top-up failed');
    expect(topUpErrorCopy('slots_held')).toEqual({
      title: "An unpaid top-up holds this card's room",
      body: "Open it from the card's balance screen, or make a new one after it expires.",
    });
  });

  it('says a paid top-up is waiting, and how many PIN tries are left', () => {
    expect(topUpErrorCopy('card_full', {paid: true}).body).toBe(
      'Spend from it, then tap again. The top-up is paid and waiting.',
    );
    expect(topUpErrorCopy(new TopUpError('wrong_pin', '', 2)).body).toBe(
      '2 tries left. Try again.',
    );
  });
});

describe('startTopUp', () => {
  it("quotes the rounded amount at the card's mint and records it waiting", async () => {
    const card = new FakeCard2();
    const entry = await startOn(card, 100000);

    expect(mintMocks.createTopUpQuote).toHaveBeenCalledWith(MINT_URL, 99328);
    expect(entry).toMatchObject({
      topupId: QUOTE,
      cardPubkey: card.pubkey,
      mintUrl: MINT_URL,
      bolt11: BOLT11,
      amountSat: 99328,
      pieces: [65536, 32768, 1024],
      state: 'waiting',
    });
    expect(storedEntries()).toEqual([entry]);
  });

  it('refuses a full card before any quote', async () => {
    const card = new FakeCard2({slotCount: 2});
    await expect(startOn(card, 7)).rejects.toMatchObject({kind: 'card_full'});
    expect(mintMocks.createTopUpQuote).not.toHaveBeenCalled();
    expect(storedEntries()).toEqual([]);
  });

  it("keeps the slots of this card's paid top-ups: a second one that cannot land is refused before any quote", async () => {
    const card = new FakeCard2({slotCount: 3});
    await startOn(card, 7);
    await pollTopUp(QUOTE);
    expect(storedEntries()[0].state).toBe('paid');
    mintMocks.createTopUpQuote.mockClear();

    await expect(
      startTopUp({
        summary: await summaryOf(card),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).rejects.toMatchObject({kind: 'card_full'});
    expect(mintMocks.createTopUpQuote).not.toHaveBeenCalled();
    expect(storedEntries()).toHaveLength(1);
  });

  it('holds the slots of an unpaid quote: a second one that cannot land beside it is refused before any quote', async () => {
    const card = new FakeCard2({slotCount: 3});
    mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
    await startOn(card, 7);
    expect(await reservedPiecesFor(card.pubkey)).toBe(3);
    // The card has the room; the unpaid quote holds it.
    await expect(
      startTopUp({
        summary: await summaryOf(card),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).rejects.toMatchObject({kind: 'slots_held'});
    expect(mintMocks.createTopUpQuote).toHaveBeenCalledTimes(1);
    expect(storedEntries().map(e => e.state)).toEqual(['waiting']);
  });

  it('asks the mint first: a quote it reports expired frees its slots', async () => {
    const card = new FakeCard2({slotCount: 3});
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: QUOTE,
      request: BOLT11,
      expiry: 1,
      amount: 7,
    });
    await startTopUp({
      summary: await summaryOf(card),
      cardMint: MINT_URL,
      owedPieces: 0,
      sat: 7,
    });
    mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: 'quote-second',
      request: BOLT11,
      expiry: 2_000_000_000,
      amount: 7,
    });
    await expect(
      startTopUp({
        summary: await summaryOf(card),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).resolves.toMatchObject({topupId: 'quote-second'});
    expect(mintMocks.checkTopUpQuote).toHaveBeenCalledWith(
      MINT_URL,
      QUOTE,
      PRECHECK_TIMEOUT_MS,
    );
    expect(storedEntries().map(e => [e.topupId, e.state])).toEqual([
      [QUOTE, 'expired'],
      ['quote-second', 'waiting'],
    ]);
  });

  it('counts the stored states when the mint will not answer the quote check', async () => {
    const card = new FakeCard2({slotCount: 3});
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: QUOTE,
      request: BOLT11,
      expiry: 1,
      amount: 7,
    });
    await startTopUp({
      summary: await summaryOf(card),
      cardMint: MINT_URL,
      owedPieces: 0,
      sat: 7,
    });
    mintMocks.checkTopUpQuote.mockRejectedValue(
      new TopUpMintError('unreachable', 'offline'),
    );
    await expect(
      startTopUp({
        summary: await summaryOf(card),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).rejects.toMatchObject({kind: 'slots_held'});
    expect(mintMocks.createTopUpQuote).toHaveBeenCalledTimes(1);
    expect(storedEntries().map(e => e.state)).toEqual(['waiting']);
  });

  it('says slots_held for two unpaid quotes, card_full for a card full of its own pieces', async () => {
    mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
    // An empty 5-slot card, a 3-piece quote left unpaid, then another 3.
    const roomy = new FakeCard2({slotCount: 5});
    await startOn(roomy, 7);
    mintMocks.createTopUpQuote.mockClear();
    await expect(
      startTopUp({
        summary: await summaryOf(roomy),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).rejects.toMatchObject({kind: 'slots_held'});
    expect(mintMocks.createTopUpQuote).not.toHaveBeenCalled();

    // A 2-slot card has no room for 3 pieces whatever is waiting.
    const small = new FakeCard2({slotCount: 2});
    await expect(
      startTopUp({
        summary: await summaryOf(small),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 7,
      }),
    ).rejects.toMatchObject({kind: 'card_full'});
  });

  it('holds the slots of a quote with no expiry for NULL_EXPIRY_HOLD_MS only, and keeps it waiting', async () => {
    const card = new FakeCard2({slotCount: 5});
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: QUOTE,
      request: BOLT11,
      expiry: null,
      amount: 7,
    });
    const entry = await startTopUp({
      summary: await summaryOf(card),
      cardMint: MINT_URL,
      owedPieces: 0,
      sat: 7,
    });
    const hour = 60 * 60 * 1000;
    expect(NULL_EXPIRY_HOLD_MS).toBe(24 * hour);
    expect(await reservedPiecesFor(card.pubkey, entry.createdAt + hour)).toBe(
      3,
    );
    expect(
      await reservedPiecesFor(card.pubkey, entry.createdAt + 25 * hour),
    ).toBe(0);
    expect(storedEntries().map(e => e.state)).toEqual(['waiting']);
  });

  it('maps a mint that cannot be reached, and keeps no entry', async () => {
    const card = new FakeCard2();
    mintMocks.createTopUpQuote.mockRejectedValueOnce(
      new TopUpMintError('unreachable', 'offline'),
    );
    await expect(
      startTopUp({
        summary: await summaryOf(card),
        cardMint: MINT_URL,
        owedPieces: 0,
        sat: 5,
      }),
    ).rejects.toMatchObject({kind: 'mint_unreachable'});
    expect(storedEntries()).toEqual([]);
  });

  it('fails (no QR) when the record cannot be written', async () => {
    const card = new FakeCard2();
    const summary = await summaryOf(card);
    mockStoreFault.write = new Error('keychain locked');
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: QUOTE,
      request: BOLT11,
      expiry: null,
      amount: 5,
    });
    await expect(
      startTopUp({summary, cardMint: MINT_URL, owedPieces: 0, sat: 5}),
    ).rejects.toMatchObject({kind: 'failed'});
  });
});

describe('the @cashu_topups store', () => {
  it('throws when the store will not read, never reading it as empty', async () => {
    mockStoreFault.read = new Error('device locked');
    await expect(listTopUps()).rejects.toBeInstanceOf(TopUpStoreError);
    // ... and the waiting list, which must not veto a balance read, is empty.
    await expect(waitingTopUpsForCard('02ab')).resolves.toEqual([]);
  });

  it('quarantines unparsable bytes by content before writing over them', async () => {
    mockStore[TOPUP_KEY] = '{not json';
    expect(await listTopUps()).toEqual([]);
    expect(mockStore[topUpQuarantineKeyFor('{not json')]).toBe('{not json');
    expect(mockStore[CORRUPT_TOPUP_KEY]).toBe('{not json');

    await startOn(new FakeCard2());
    expect(storedEntries()).toHaveLength(1);
  });

  it('refuses to overwrite a corrupt store it could not quarantine', async () => {
    mockStore[TOPUP_KEY] = '[1,2]';
    const card = new FakeCard2();
    const summary = await summaryOf(card);
    mockStoreFault.write = new Error('keychain full');
    mintMocks.createTopUpQuote.mockResolvedValueOnce({
      quoteId: QUOTE,
      request: BOLT11,
      expiry: null,
      amount: 5,
    });
    await expect(
      startTopUp({summary, cardMint: MINT_URL, owedPieces: 0, sat: 5}),
    ).rejects.toMatchObject({kind: 'failed'});
    expect(mockStore[TOPUP_KEY]).toBe('[1,2]');
  });

  it('never touches the owed-change store', async () => {
    mockStore[OWED_CHANGE_KEY] = 'sentinel';
    const card = new FakeCard2();
    await startOn(card);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(mockStore[OWED_CHANGE_KEY]).toBe('sentinel');
  });

  it('evicts only loaded or expired entries past the cap', async () => {
    const old = (i: number, state: TopUpEntry['state']): TopUpEntry => ({
      topupId: `q${i}`,
      cardPubkey: '02ab',
      mintUrl: MINT_URL,
      bolt11: BOLT11,
      amountSat: 1,
      pieces: [1],
      expiry: null,
      state,
      attempts: 0,
      createdAt: i,
      updatedAt: i,
    });
    const entries = Array.from({length: MAX_TOPUP_ENTRIES}, (_, i) =>
      old(i, i % 2 ? 'paid' : 'loaded'),
    );
    mockStore[TOPUP_KEY] = JSON.stringify({v: 1, entries});
    await startOn(new FakeCard2());
    const kept = storedEntries();
    expect(kept).toHaveLength(MAX_TOPUP_ENTRIES);
    expect(kept.filter(e => e.state === 'paid')).toHaveLength(
      MAX_TOPUP_ENTRIES / 2,
    );
    expect(kept.some(e => e.topupId === 'q0')).toBe(false);
  });
});

describe('pollTopUp', () => {
  it('ignores a poll that throws', async () => {
    await startOn(new FakeCard2());
    mintMocks.checkTopUpQuote.mockRejectedValueOnce(new Error('offline'));
    expect((await pollTopUp(QUOTE))?.state).toBe('waiting');
  });

  it('expires only an UNPAID quote past its expiry', async () => {
    await startOn(new FakeCard2());
    mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
    expect((await pollTopUp(QUOTE, 1_999_999_999_000))?.state).toBe('waiting');
    expect((await pollTopUp(QUOTE, 2_000_000_000_000))?.state).toBe('expired');
    expect(storedEntries()[0].state).toBe('expired');
  });

  it('honours a payment made after Cancel, even past the expiry', async () => {
    const card = new FakeCard2();
    await startOn(card);
    // Cancel changes nothing on disk; the mint says paid later.
    mintMocks.checkTopUpQuote.mockResolvedValue('PAID');
    expect((await pollTopUp(QUOTE, 2_100_000_000_000))?.state).toBe('paid');
    const waiting = await waitingTopUpsForCard(card.pubkey);
    expect(waiting.map(e => e.state)).toEqual(['paid']);
  });

  it('counts an ISSUED quote as paid', async () => {
    await startOn(new FakeCard2());
    mintMocks.checkTopUpQuote.mockResolvedValue('ISSUED');
    expect((await pollTopUp(QUOTE))?.state).toBe('paid');
  });

  it('checks the waiting quotes at the same time, not one after another', async () => {
    jest.useFakeTimers();
    try {
      const card = new FakeCard2({slotCount: 8});
      mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
      for (const id of ['quote-a', 'quote-b']) {
        mintMocks.createTopUpQuote.mockResolvedValueOnce({
          quoteId: id,
          request: BOLT11,
          expiry: 2_000_000_000,
          amount: 1,
        });
        await startTopUp({
          summary: await summaryOf(card),
          cardMint: MINT_URL,
          owedPieces: 0,
          sat: 1,
        });
      }
      const DELAY = 1000;
      mintMocks.checkTopUpQuote.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve('PAID'), DELAY)),
      );
      let done = false;
      const refresh = refreshWaitingTopUps(card.pubkey).then(r => {
        done = true;
        return r;
      });
      // Let both checks start, then advance one delay only.
      for (let i = 0; i < 20 && !done; i++) {
        await Promise.resolve();
      }
      await jest.advanceTimersByTimeAsync(DELAY);
      for (let i = 0; i < 50 && !done; i++) {
        await Promise.resolve();
      }
      expect(done).toBe(true);
      expect((await refresh).map(e => e.state)).toEqual(['paid', 'paid']);
      // One check of quote-a before quote-b was made, then one each.
      expect(mintMocks.checkTopUpQuote).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('promotes late payments for the balance screen', async () => {
    const card = new FakeCard2();
    await startOn(card);
    mintMocks.checkTopUpQuote.mockResolvedValue('PAID');
    const waiting = await refreshWaitingTopUps(card.pubkey);
    expect(waiting.map(e => e.state)).toEqual(['paid']);
  });
});

describe('loadTopUp', () => {
  const insFrom = (card: FakeCard2) => card.sent.map(a => a[1]);
  const LOAD = 0x30;
  const VERIFY_PIN = 0x40;

  it('loads every piece with its DLEQ and marks the top-up loaded', async () => {
    const card = new FakeCard2();
    await startOn(card, 7);
    const result = await loadTopUp({
      topupId: QUOTE,
      transceive: card.transceive,
    });
    expect(result).toEqual({amountSat: 7, loadId: QUOTE.slice(0, 8)});
    expect(card.loads.map(l => l.amount)).toEqual([4, 2, 1]);
    expect(card.loads.every(l => l.dleq)).toBe(true);
    expect(card.loads.every(l => l.date === 0)).toBe(true);
    expect(card.loads.every(l => l.keysetId === KEYSET_ID)).toBe(true);
    expect(storedEntries()[0].state).toBe('loaded');
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
  });

  it('mints pieces whose secret is byte-equal to buildCardSigAllSecret', async () => {
    const card = new FakeCard2();
    await startOn(card, 5);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    for (const l of card.loads) {
      expect(
        testMint().verifyProof(
          buildCardSigAllSecret(l.nonce, card.pubkey),
          l.C,
          l.amount,
        ),
      ).toBe(true);
    }
    const minted = storedEntries()[0].minted!;
    expect(minted.map(m => m.nonce)).toEqual(card.loads.map(l => l.nonce));
  });

  it('writes nothing to another card, or a card of another mint', async () => {
    const card = new FakeCard2();
    await startOn(card);
    const other = new FakeCard2({privateKey: '22'.repeat(32)});
    await expect(
      loadTopUp({topupId: QUOTE, transceive: other.transceive}),
    ).rejects.toMatchObject({kind: 'not_our_card'});
    expect(other.loads).toEqual([]);

    const elsewhere = new FakeCard2({mint: 'https://other.mint'});
    await expect(
      loadTopUp({topupId: QUOTE, transceive: elsewhere.transceive}),
    ).rejects.toMatchObject({kind: 'not_our_card'});
    expect(elsewhere.loads).toEqual([]);
    expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
    expect(storedEntries()[0].outputs).toBeUndefined();
  });

  it('accepts the same mint with another case or a trailing slash', async () => {
    const card = new FakeCard2({mint: `${MINT_URL.toUpperCase()}/`});
    await startOn(card);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).resolves.toMatchObject({amountSat: 5});
  });

  it('verifies the PIN before the first LOAD, even with the change grant', async () => {
    const card = new FakeCard2({pin: '1234'});
    await startOn(card);
    card.changeDue = true;
    await loadTopUp({topupId: QUOTE, transceive: card.transceive, pin: '1234'});
    const ins = insFrom(card);
    expect(ins).toContain(VERIFY_PIN);
    expect(ins.indexOf(VERIFY_PIN)).toBeLessThan(ins.indexOf(LOAD));
  });

  it('asks for the PIN rather than loading on the change grant alone', async () => {
    const card = new FakeCard2({pin: '1234'});
    await startOn(card);
    card.changeDue = true;
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'pin_needed'});
    expect(card.loads).toEqual([]);
  });

  it('leaves a wrong PIN paid, with the tries left', async () => {
    const card = new FakeCard2({pin: '1234'});
    await startOn(card);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive, pin: '9999'}),
    ).rejects.toMatchObject({kind: 'wrong_pin', triesLeft: 2});
    expect(card.loads).toEqual([]);
    expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
    expect(storedEntries()[0].state).toBe('paid');
  });

  it('keeps the outputs before the mint is asked to sign them', async () => {
    const card = new FakeCard2();
    await startOn(card, 5);
    mintMocks.mintTopUp.mockImplementationOnce(
      async (_u: string, _q: string, outputs: TopUpOutput[]) => {
        const kept = storedEntries()[0];
        expect(kept.state).toBe('loading');
        expect(kept.keysetId).toBe(KEYSET_ID);
        expect(kept.outputs!.map(o => o.B_)).toEqual(outputs.map(o => o.B_));
        expect(kept.minted).toBeUndefined();
        return signOutputs(outputs);
      },
    );
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
  });

  it('restores, never mints again, when the answer is lost after the mint accepted', async () => {
    const card = new FakeCard2();
    await startOn(card, 5);
    let signed: ReturnType<typeof signOutputs> = [];
    mintMocks.mintTopUp.mockImplementationOnce(
      async (_u: string, _q: string, outputs: TopUpOutput[]) => {
        signed = signOutputs(outputs);
        throw new TopUpMintError('timeout', 'the mint took too long');
      },
    );
    mintMocks.restoreTopUp.mockImplementationOnce(async () => signed);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
    expect(mintMocks.restoreTopUp).toHaveBeenCalledTimes(1);
    expect(card.loads.map(l => l.C)).toEqual(signed.map(s => s.C));
  });

  it('restores an ISSUED quote with the kept outputs instead of minting', async () => {
    const card = new FakeCard2();
    await startOn(card, 5);
    // First tap: outputs kept, then the card leaves before the mint answers.
    mintMocks.mintTopUp.mockRejectedValueOnce(
      new TopUpMintError('unreachable', 'offline'),
    );
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'mint_unreachable'});
    const kept = storedEntries()[0];
    expect(kept.state).toBe('loading');
    // The mint did sign them after all.
    mintMocks.checkTopUpQuote.mockResolvedValue('ISSUED');
    const outputs = kept.outputs!.map(o => ({
      amount: o.amount,
      keysetId: KEYSET_ID,
      B_: o.B_,
      r: o.r,
    }));
    mintMocks.restoreTopUp.mockImplementationOnce(
      async (_u: string, asked: TopUpOutput[]) => {
        expect(asked.map(o => o.B_)).toEqual(outputs.map(o => o.B_));
        return signOutputs(asked);
      },
    );
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
    expect(card.loads).toHaveLength(2);
    expect(storedEntries()[0].state).toBe('loaded');
  });

  it("counts LOAD's 6A94 as loaded", async () => {
    const card = new FakeCard2({
      refuseLoad: n => (n === 0 ? 0x6a94 : undefined),
    });
    await startOn(card, 5);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(storedEntries()[0].state).toBe('loaded');
    expect(storedEntries()[0].minted!.every(m => m.loaded)).toBe(true);
  });

  it('stops at 6A84 midway, and the next tap loads only the remainder', async () => {
    const card = new FakeCard2({
      refuseLoad: n => (n === 1 ? 0x6a84 : undefined),
    });
    await startOn(card, 7);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'card_full'});
    const after = storedEntries()[0];
    expect(after.state).toBe('loading');
    expect(after.minted!.map(m => m.loaded)).toEqual([true, false, false]);
    expect(card.loads.map(l => l.amount)).toEqual([4]);

    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(card.loads.map(l => l.amount)).toEqual([4, 2, 1]);
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
    expect(storedEntries()[0].state).toBe('loaded');
  });

  it.each([
    ['full', 0x6a84, 'card_full'],
    ['locked', 0x6986, 'card_locked'],
    ['any other refusal', 0x6a80, 'failed'],
  ])(
    'a piece the card refused (%s) is not sent: it needs its slot again',
    async (_name, sw, kind) => {
      const card = new FakeCard2({
        slotCount: 3,
        refuseLoad: n => (n === 0 ? sw : undefined),
      });
      await startOn(card, 7);
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind});
      const after = storedEntries()[0];
      expect(after.state).toBe('loading');
      expect(after.attempts).toBe(1);
      expect(after.minted!.map(m => [m.loaded, !!m.sent])).toEqual([
        [false, false],
        [false, false],
        [false, false],
      ]);
      expect(await reservedPiecesFor(card.pubkey)).toBe(3);
    },
  );

  it('a lost link keeps the piece sent: it may be on the card', async () => {
    const card = new FakeCard2({
      slotCount: 3,
      failBefore: (ins, n) => ins === LOAD && n === 0,
    });
    await startOn(card, 7);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'not_loaded'});
    expect(storedEntries()[0].minted!.map(m => !!m.sent)).toEqual([
      true,
      false,
      false,
    ]);
    expect(await reservedPiecesFor(card.pubkey)).toBe(2);
  });

  it("still answers the card's refusal when the record will not take it back", async () => {
    const card = new FakeCard2({
      slotCount: 3,
      refuseLoad: n => {
        if (n === 0) {
          mockStoreFault.write = new Error('keychain locked');
          return 0x6a84;
        }
        return undefined;
      },
    });
    await startOn(card, 7);
    const thrown = await loadTopUp({
      topupId: QUOTE,
      transceive: card.transceive,
    }).catch(e => e);
    expect(thrown).toBeInstanceOf(TopUpError);
    expect(thrown).toMatchObject({kind: 'card_full'});
    mockStoreFault.write = null;
  });

  it('a lost link mid-load is "not loaded yet" and resumes', async () => {
    const card = new FakeCard2({
      failBefore: (ins, n) => ins === LOAD && n === 0,
    });
    await startOn(card, 5);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'not_loaded'});
    expect(storedEntries()[0].attempts).toBe(1);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    expect(card.loads.map(l => l.amount)).toEqual([4, 1]);
  });

  it('a piece whose LOAD landed with its answer lost takes no slot in the re-check', async () => {
    const card = new FakeCard2({
      slotCount: 3,
      loseLoadAnswer: n => n === 0,
    });
    await startOn(card, 7);
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'not_loaded'});
    const after = storedEntries()[0];
    expect(after.state).toBe('loading');
    expect(after.minted!.map(m => [m.loaded, !!m.sent])).toEqual([
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect((await summaryOf(card)).info.empty).toBe(2);

    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    // Piece 1's resend answers 6A94 and counts as landed; 2 and 3 fit.
    expect(card.loads.map(l => l.amount)).toEqual([4, 2, 1]);
    expect(storedEntries()[0].state).toBe('loaded');
    expect(storedEntries()[0].minted!.every(m => m.loaded)).toBe(true);
    expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
  });

  it('a loaded top-up answers without touching the card', async () => {
    const card = new FakeCard2();
    await startOn(card, 5);
    await loadTopUp({topupId: QUOTE, transceive: card.transceive});
    card.sent.length = 0;
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).resolves.toEqual({amountSat: 5, loadId: QUOTE.slice(0, 8)});
    expect(card.sent).toEqual([]);
  });

  it('re-checks the room, leaving the top-up paid', async () => {
    const card = new FakeCard2({slotCount: 3});
    await startOn(card, 7);
    card.slots[0] = {...card.slots[0], ...fillerSlot()} as never;
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'card_full'});
    expect(storedEntries()[0].state).toBe('paid');
    expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
  });

  it('refuses an unpaid quote without reading the card', async () => {
    const card = new FakeCard2();
    await startOn(card);
    mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
    await expect(
      loadTopUp({topupId: QUOTE, transceive: card.transceive}),
    ).rejects.toMatchObject({kind: 'not_paid'});
    expect(card.sent).toEqual([]);
  });
});

function fillerSlot() {
  return {
    keysetId: KEYSET_ID,
    amount: 1,
    nonce: bytesToHex(new Uint8Array(32).fill(7)),
    C: '02' + '11'.repeat(32),
    date: 0,
    dleq: null,
    status: 1,
  };
}

describe('refund (ENG-855)', () => {
  const INVOICE = 'lnbc70n1holderinvoice';
  const LOAD = 0x30;

  /** A top-up of `sat` on `card`, paid and waiting to load. */
  async function paidOn(card: FakeCard2, sat = 7) {
    await startOn(card, sat);
    await pollTopUp(QUOTE);
    expect(storedEntries()[0].state).toBe('paid');
    card.sent.length = 0;
    jest.clearAllMocks();
  }

  const refund = (
    card: FakeCard2,
    over: Partial<Parameters<typeof refundTopUp>[0]> = {},
  ) =>
    refundTopUp({
      topupId: QUOTE,
      destination: INVOICE,
      shownNetSat: 5,
      transceive: card.transceive,
      ...over,
    });

  const fakeRefund = (over: Partial<TopUpRefund> = {}): TopUpRefund => ({
    destination: {kind: 'bolt11', value: INVOICE},
    meltQuoteId: 'melt-1',
    request: INVOICE,
    amountSat: 5,
    feeSat: 2,
    inputFeeSat: 0,
    meltExpiry: 2_000_000_000,
    keysetId: KEYSET_ID,
    outputs: [
      {amount: 4, secret: 'aa'.repeat(32), r: '01'.repeat(32), B_: '02'},
    ],
    ...over,
  });

  /** Rewrite the stored entry as if another flow wrote it. */
  const rewrite = (fn: (e: TopUpEntry) => TopUpEntry) => {
    const env = JSON.parse(mockStore[TOPUP_KEY]);
    env.entries = env.entries.map(fn);
    mockStore[TOPUP_KEY] = JSON.stringify(env);
  };

  describe('the destination', () => {
    it.each([
      ['LIGHTNING:LNBC70N1XYZ', {kind: 'bolt11', value: 'lnbc70n1xyz'}],
      ['  lnbcrt70n1xyz ', {kind: 'bolt11', value: 'lnbcrt70n1xyz'}],
      [
        ' Holder@Wallet.Example ',
        {kind: 'address', value: 'holder@wallet.example'},
      ],
    ])('normalises %p', (raw, want) => {
      expect(normalizeRefundDestination(raw)).toEqual(want);
    });

    it.each(['', '   ', 'not an invoice', 'lnurl1dp68gurn'])(
      'refuses %p',
      raw => {
        expect(() => normalizeRefundDestination(raw)).toThrow(TopUpError);
      },
    );
  });

  describe('previewTopUpRefund', () => {
    it('prices the net after the reserve and the input fee, persisting nothing', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      resetTestMint({inputFeePpk: 1000});
      const before = mockStore[TOPUP_KEY];

      const preview = await previewTopUpRefund({
        topupId: QUOTE,
        destination: 'LIGHTNING:LNBC70N1HOLDERINVOICE',
      });

      // 7 sats, three pieces at 1000 ppk: 3 sats input fee, a 4-sat budget,
      // of which the mint reserves 2.
      expect(mintMocks.createRefundQuote).toHaveBeenCalledWith(
        MINT_URL,
        {bolt11: INVOICE},
        4,
      );
      expect(preview).toEqual({
        netSat: 2,
        feeSat: 5,
        destination: {kind: 'bolt11', value: INVOICE},
      });
      expect(mockStore[TOPUP_KEY]).toBe(before);
      expect(card.sent).toEqual([]);
    });

    it('quotes a lightning address for the budget', async () => {
      await paidOn(new FakeCard2(), 7);
      await expect(
        previewTopUpRefund({
          topupId: QUOTE,
          destination: 'holder@wallet.example',
        }),
      ).resolves.toMatchObject({netSat: 5, feeSat: 2});
      expect(mintMocks.createRefundQuote).toHaveBeenCalledWith(
        MINT_URL,
        {lightningAddress: 'holder@wallet.example'},
        7,
      );
    });

    it('refuses an unpaid quote as not_paid', async () => {
      mintMocks.checkTopUpQuote.mockResolvedValue('UNPAID');
      await startOn(new FakeCard2(), 7);
      await expect(
        previewTopUpRefund({topupId: QUOTE, destination: INVOICE}),
      ).rejects.toMatchObject({kind: 'not_paid'});
      expect(mintMocks.createRefundQuote).not.toHaveBeenCalled();
    });

    it('refuses an ISSUED quote: the pieces are the card’s', async () => {
      await paidOn(new FakeCard2(), 7);
      mintMocks.checkTopUpQuote.mockResolvedValue('ISSUED');
      await expect(
        previewTopUpRefund({topupId: QUOTE, destination: INVOICE}),
      ).rejects.toMatchObject({kind: 'refund_unavailable'});
      expect(mintMocks.createRefundQuote).not.toHaveBeenCalled();
    });

    it('refuses a top-up with minted pieces', async () => {
      const card = new FakeCard2({
        refuseLoad: n => (n === 0 ? 0x6a84 : undefined),
      });
      await startOn(card, 7);
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind: 'card_full'});
      expect(storedEntries()[0].minted).toHaveLength(3);
      await expect(
        previewTopUpRefund({topupId: QUOTE, destination: INVOICE}),
      ).rejects.toMatchObject({kind: 'refund_unavailable'});
      await expect(refund(card)).rejects.toMatchObject({
        kind: 'refund_unavailable',
      });
      expect(mintMocks.createRefundQuote).not.toHaveBeenCalled();
    });

    it('refuses an invoice over the budget with the most that fits', async () => {
      await paidOn(new FakeCard2(), 7);
      mintMocks.createRefundQuote.mockRejectedValueOnce(
        new MeltBudgetError('too big', 12, 2, 7),
      );
      const error = await previewTopUpRefund({
        topupId: QUOTE,
        destination: INVOICE,
      }).catch(e => e);
      expect(error).toMatchObject({kind: 'refund_failed'});
      expect(error.detail).toBe(
        'The invoice is too large. Ask for one of at most 5 sats.',
      );
    });
    it('refuses an invoice well under the budget: its change would stay on this phone', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.createRefundQuote.mockImplementation(async () => ({
        meltQuoteId: 'melt-small',
        request: INVOICE,
        amountSat: 1,
        feeReserveSat: 2,
        expiry: 2_000_000_000,
      }));
      const before = mockStore[TOPUP_KEY];
      const error = await previewTopUpRefund({
        topupId: QUOTE,
        destination: INVOICE,
      }).catch(e => e);
      expect(error).toMatchObject({kind: 'refund_failed'});
      expect(error.detail).toBe(
        'The invoice is too small. Ask for one of 5 sats.',
      );
      await expect(
        beginTopUpRefund({
          topupId: QUOTE,
          destination: INVOICE,
          shownNetSat: 1,
          transceive: card.transceive,
        }),
      ).rejects.toMatchObject({kind: 'refund_failed'});
      expect(mockStore[TOPUP_KEY]).toBe(before);
      expect(storedEntries()[0].state).toBe('paid');
      expect(storedEntries()[0].refund).toBeUndefined();
      expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
      expect(mintMocks.meltRefund).not.toHaveBeenCalled();
    });
  });

  describe('the card gate', () => {
    // Blocked and locked happen after payment: a top-up is never quoted for
    // such a card.
    const block = (c: FakeCard2) => {
      c.pinState = 2;
    };
    const lock = (c: FakeCard2) => {
      (c.opts as {locked?: boolean}).locked = true;
    };
    it.each([
      ['a wrong PIN', {pin: '9999'}, null, {kind: 'wrong_pin', triesLeft: 2}],
      ['no PIN', {}, null, {kind: 'pin_needed'}],
      ['a blocked PIN', {pin: '1234'}, block, {kind: 'pin_blocked'}],
      ['a locked card', {pin: '1234'}, lock, {kind: 'card_locked'}],
    ])('stops at %s before any mint call', async (_n, args, after, want) => {
      const card = new FakeCard2({pin: '1234'});
      await paidOn(card, 7);
      after?.(card);
      await expect(refund(card, args)).rejects.toMatchObject(want);
      expect(mintMocks.checkTopUpQuote).not.toHaveBeenCalled();
      expect(mintMocks.createRefundQuote).not.toHaveBeenCalled();
      expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
      expect(mintMocks.meltRefund).not.toHaveBeenCalled();
      expect(storedEntries()[0].state).toBe('paid');
    });

    it('refuses another card before any mint call', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      const other = new FakeCard2({privateKey: '22'.repeat(32)});
      await expect(refund(other)).rejects.toMatchObject({
        kind: 'not_our_card',
      });
      expect(mintMocks.createRefundQuote).not.toHaveBeenCalled();
      expect(storedEntries()[0].state).toBe('paid');
    });

    it('verifies the PIN, and never sends a LOAD', async () => {
      const card = new FakeCard2({pin: '1234'});
      await paidOn(card, 7);
      await refund(card, {pin: '1234'});
      const ins = card.sent.map(a => a[1]);
      expect(ins).toContain(0x40);
      expect(ins).not.toContain(LOAD);
      expect(card.loads).toEqual([]);
    });

    it('stops when the mint would now pay less than the holder confirmed', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      await expect(refund(card, {shownNetSat: 6})).rejects.toMatchObject({
        kind: 'refund_failed',
      });
      expect(storedEntries()[0].state).toBe('paid');
      expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
    });
  });

  describe('refundTopUp', () => {
    it('mints onto kept plain outputs, marks the melt sent, then melts and records refunded', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      let kept: TopUpRefund | undefined;
      mintMocks.mintTopUp.mockImplementationOnce(
        async (_u: string, quote: string, outputs: TopUpOutput[]) => {
          const e = storedEntries()[0];
          expect(e.state).toBe('refunding');
          kept = e.refund!;
          expect(quote).toBe(QUOTE);
          expect(kept.outputs.map(o => o.B_)).toEqual(outputs.map(o => o.B_));
          expect(kept.proofs).toBeUndefined();
          expect(outputs.every(o => o.keysetId === KEYSET_ID)).toBe(true);
          return signOutputs(outputs);
        },
      );
      mintMocks.meltRefund.mockImplementationOnce(
        async (_u: string, meltId: string, proofs: RefundProof[]) => {
          const r = storedEntries()[0].refund!;
          expect(r.meltSent).toBe(true);
          expect(r.proofs).toEqual(proofs);
          expect(meltId).toBe('melt-1');
          return {
            state: 'PAID',
            preimage: 'preimage-1',
            change: [{id: KEYSET_ID, amount: 1, secret: 'chg', C: '02aa'}],
          };
        },
      );

      const done = await refund(card);

      expect(done).toEqual({
        amountSat: 5,
        changeSat: 1,
        preimage: 'preimage-1',
        destination: {kind: 'bolt11', value: INVOICE},
      });
      const e = storedEntries()[0];
      expect(e.state).toBe('refunded');
      expect(e.refund).toMatchObject({
        meltQuoteId: 'melt-1',
        amountSat: 5,
        feeSat: 2,
        preimage: 'preimage-1',
        changeSat: 1,
        change: [{id: KEYSET_ID, amount: 1, secret: 'chg', C: '02aa'}],
      });
      // Plain secrets, signed by the mint: proofs anyone holding them spends.
      for (const p of e.refund!.proofs!) {
        expect(p.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(testMint().verifyProof(p.secret, p.C, p.amount)).toBe(true);
      }
      expect(e.refund!.proofs!.map(p => p.secret)).toEqual(
        kept!.outputs.map(o => o.secret),
      );
      expect(e.minted).toBeUndefined();
      expect(card.loads).toEqual([]);
      // The change stays in the entry: never the settled store.
      expect(Object.keys(mockStore)).toEqual([TOPUP_KEY]);
    });

    it('restores, never mints again, when the mint answer is lost', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      let signed: ReturnType<typeof signOutputs> = [];
      mintMocks.mintTopUp.mockImplementationOnce(
        async (_u: string, _q: string, outputs: TopUpOutput[]) => {
          signed = signOutputs(outputs);
          throw new TopUpMintError('timeout', 'the mint took too long');
        },
      );
      mintMocks.restoreTopUp.mockImplementationOnce(async () => signed);
      await refund(card);
      expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
      expect(mintMocks.restoreTopUp).toHaveBeenCalledTimes(1);
      expect(storedEntries()[0].refund!.proofs!.map(p => p.C)).toEqual(
        signed.map(s => s.C),
      );
      expect(storedEntries()[0].state).toBe('refunded');
    });

    it('a mint that cannot be reached leaves it refunding, and resume mints the same outputs', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.mintTopUp.mockRejectedValueOnce(
        new TopUpMintError('unreachable', 'offline'),
      );
      await expect(refund(card)).rejects.toMatchObject({
        kind: 'mint_unreachable',
      });
      const first = storedEntries()[0];
      expect(first.state).toBe('refunding');
      expect(first.refund!.proofs).toBeUndefined();
      await expect(resumeTopUpRefund(QUOTE)).resolves.toMatchObject({
        amountSat: 5,
      });
      const asked = mintMocks.mintTopUp.mock.calls.map(c =>
        (c[2] as TopUpOutput[]).map(o => o.B_),
      );
      expect(asked[1]).toEqual(asked[0]);
      expect(storedEntries()[0].state).toBe('refunded');
    });

    describe('a melt that throws or times out', () => {
      async function stuck(card: FakeCard2) {
        await paidOn(card, 7);
        mintMocks.meltRefund.mockRejectedValueOnce(
          new TopUpMintError('timeout', 'the mint took too long'),
        );
        await expect(refund(card)).rejects.toMatchObject({
          kind: 'mint_timeout',
        });
        const e = storedEntries()[0];
        expect(e.state).toBe('refunding');
        expect(e.refund!.meltSent).toBe(true);
        expect(e.lastError).toMatch(/too long/);
        return e.refund!.proofs!;
      }

      it('resumes as refunded when the mint paid, with no second melt', async () => {
        await stuck(new FakeCard2());
        mintMocks.checkRefundMelt.mockResolvedValueOnce({
          state: 'PAID',
          preimage: 'preimage-late',
          expiry: 2_000_000_000,
        });
        await expect(resumeTopUpRefund(QUOTE)).resolves.toMatchObject({
          preimage: 'preimage-late',
          changeSat: 0,
        });
        expect(mintMocks.meltRefund).toHaveBeenCalledTimes(1);
        expect(storedEntries()[0].state).toBe('refunded');
      });

      it('melts the same proofs again when the mint did not pay', async () => {
        const proofs = await stuck(new FakeCard2());
        await resumeTopUpRefund(QUOTE);
        expect(mintMocks.meltRefund).toHaveBeenCalledTimes(2);
        expect(mintMocks.meltRefund.mock.calls[1][2]).toEqual(proofs);
        expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
        expect(storedEntries()[0].state).toBe('refunded');
      });

      it('says the refund is on its way while the melt is pending', async () => {
        await stuck(new FakeCard2());
        mintMocks.checkRefundMelt.mockResolvedValueOnce({
          state: 'PENDING',
          preimage: null,
          expiry: 2_000_000_000,
        });
        await expect(resumeTopUpRefund(QUOTE)).rejects.toMatchObject({
          kind: 'refund_pending',
        });
        expect(mintMocks.meltRefund).toHaveBeenCalledTimes(1);
        expect(storedEntries()[0].state).toBe('refunding');
      });
    });

    it('a melt the mint answers PENDING stays refunding', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.meltRefund.mockResolvedValueOnce({
        state: 'PENDING',
        preimage: null,
        change: [],
      });
      await expect(refund(card)).rejects.toMatchObject({
        kind: 'refund_pending',
      });
      expect(storedEntries()[0].state).toBe('refunding');
    });

    it('quotes an expired melt quote again, keeping the new id before the melt', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.createRefundQuote
        .mockResolvedValueOnce({
          meltQuoteId: 'melt-old',
          request: INVOICE,
          amountSat: 5,
          feeReserveSat: 2,
          expiry: 1,
        })
        .mockResolvedValueOnce({
          meltQuoteId: 'melt-new',
          request: INVOICE,
          amountSat: 5,
          feeReserveSat: 2,
          expiry: 2_000_000_000,
        });
      mintMocks.meltRefund.mockImplementationOnce(async (_u, id: string) => {
        expect(storedEntries()[0].refund!.meltQuoteId).toBe('melt-new');
        expect(id).toBe('melt-new');
        return {state: 'PAID', preimage: 'p', change: []};
      });
      await refund(card);
      expect(storedEntries()[0].refund!.meltQuoteId).toBe('melt-new');
    });

    it('an expired melt quote that would now pay less than confirmed stops before the melt', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.createRefundQuote
        .mockResolvedValueOnce({
          meltQuoteId: 'melt-old',
          request: INVOICE,
          amountSat: 5,
          feeReserveSat: 2,
          expiry: 1,
        })
        .mockResolvedValueOnce({
          meltQuoteId: 'melt-new',
          request: INVOICE,
          amountSat: 4,
          feeReserveSat: 3,
          expiry: 2_000_000_000,
        });
      const error = await refund(card).catch(e => e);
      expect(error).toMatchObject({kind: 'refund_failed'});
      expect(error.detail).toMatch(/less than confirmed/);
      expect(mintMocks.meltRefund).not.toHaveBeenCalled();
      const e = storedEntries()[0];
      expect(e.state).toBe('refunding');
      expect(e.refund!.meltQuoteId).toBe('melt-old');
      expect(e.refund!.amountSat).toBe(5);
      expect(e.lastError).toMatch(/less than confirmed/);
    });

    it('an expired invoice that will not quote again asks for a new one, and a new destination takes the card again', async () => {
      const card = new FakeCard2({pin: '1234'});
      await paidOn(card, 7);
      mintMocks.meltRefund.mockRejectedValueOnce(
        new TopUpMintError('timeout', 'slow'),
      );
      await expect(refund(card, {pin: '1234'})).rejects.toMatchObject({
        kind: 'mint_timeout',
      });
      const outputs = storedEntries()[0].refund!.outputs;
      mintMocks.checkRefundMelt.mockResolvedValueOnce({
        state: 'UNPAID',
        preimage: null,
        expiry: 1,
      });
      mintMocks.createRefundQuote.mockRejectedValueOnce(
        new Error('invoice expired'),
      );
      const error = await resumeTopUpRefund(QUOTE).catch(e => e);
      expect(error).toMatchObject({kind: 'refund_failed'});
      expect(error.detail).toMatch(/new one/);
      expect(storedEntries()[0].state).toBe('refunding');

      // No card, no new destination.
      await expect(
        refund(new FakeCard2({privateKey: '22'.repeat(32)}), {
          destination: 'holder@wallet.example',
        }),
      ).rejects.toMatchObject({kind: 'not_our_card'});
      await refund(card, {
        pin: '1234',
        destination: 'holder@wallet.example',
      });
      const e = storedEntries()[0];
      expect(e.state).toBe('refunded');
      expect(e.refund!.destination).toEqual({
        kind: 'address',
        value: 'holder@wallet.example',
      });
      // The plain outputs the mint signed are kept, never made again.
      expect(e.refund!.outputs).toEqual(outputs);
      expect(mintMocks.mintTopUp).toHaveBeenCalledTimes(1);
    });

    it('a load that won the race keeps its pieces: the refund is unavailable', async () => {
      const card = new FakeCard2();
      await startOn(card, 7);
      // A load kept its outputs, then lost the mint's answer.
      mintMocks.mintTopUp.mockRejectedValueOnce(
        new TopUpMintError('unreachable', 'offline'),
      );
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind: 'mint_unreachable'});
      const cardOutputs = storedEntries()[0].outputs!;
      jest.clearAllMocks();
      // The mint signed the card's outputs after all.
      mintMocks.checkTopUpQuote
        .mockResolvedValueOnce('PAID')
        .mockResolvedValue('ISSUED');
      mintMocks.restoreTopUp.mockImplementation(
        async (_u: string, asked: TopUpOutput[]) =>
          asked[0].B_ === cardOutputs[0].B_ ? signOutputs(asked) : null,
      );

      await expect(refund(card)).rejects.toMatchObject({
        kind: 'refund_unavailable',
      });
      const e = storedEntries()[0];
      expect(e.state).toBe('loading');
      expect(e.refund).toBeUndefined();
      expect(e.minted).toHaveLength(3);
      expect(mintMocks.meltRefund).not.toHaveBeenCalled();

      await loadTopUp({topupId: QUOTE, transceive: card.transceive});
      expect(card.loads.map(l => l.amount)).toEqual([4, 2, 1]);
      expect(storedEntries()[0].state).toBe('loaded');
    });

    it('refuses a top-up already refunded', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      await refund(card);
      await expect(refund(card)).rejects.toMatchObject({kind: 'refunded'});
      await expect(resumeTopUpRefund(QUOTE)).resolves.toMatchObject({
        amountSat: 5,
      });
      expect(mintMocks.meltRefund).toHaveBeenCalledTimes(1);
    });

    it('beginTopUpRefund writes the intent and calls neither mint nor melt', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      await beginTopUpRefund({
        topupId: QUOTE,
        destination: INVOICE,
        shownNetSat: 5,
        transceive: card.transceive,
      });
      expect(storedEntries()[0].state).toBe('refunding');
      expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
      expect(mintMocks.meltRefund).not.toHaveBeenCalled();
    });
  });

  describe('the load guards', () => {
    it('never touches the card for a refunding or refunded top-up', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.meltRefund.mockRejectedValueOnce(new Error('lost'));
      await expect(refund(card)).rejects.toMatchObject({
        kind: 'refund_failed',
      });
      card.sent.length = 0;
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind: 'refund_pending'});
      expect(card.sent).toEqual([]);

      await resumeTopUpRefund(QUOTE);
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind: 'refunded'});
      expect(card.sent).toEqual([]);
    });

    it('a refund written between the load read and its outputs stops the load', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      mintMocks.topUpKeyset.mockImplementationOnce(async () => {
        rewrite(e => ({...e, state: 'refunding', refund: fakeRefund()}));
        return testMint().cachedKeyset();
      });
      await expect(
        loadTopUp({topupId: QUOTE, transceive: card.transceive}),
      ).rejects.toMatchObject({kind: 'refund_pending'});
      expect(mintMocks.mintTopUp).not.toHaveBeenCalled();
      expect(card.loads).toEqual([]);
      expect(storedEntries()[0].outputs).toBeUndefined();
    });

    it('a refund written before a piece goes on stops the LOAD', async () => {
      const card = new FakeCard2();
      await paidOn(card, 7);
      const {setSecure} = jest.requireMock(
        '../../src/services/secureStorage',
      ) as {setSecure: jest.Mock};
      // The moment the minted pieces land in the store, a refund record
      // replaces the entry: the first LOAD's write-ahead must see it.
      setSecure.mockImplementation(async (k: string, v: string) => {
        mockStore[k] = v;
        const e = JSON.parse(v).entries?.[0];
        if (e?.minted && !e.minted.some((m: {sent?: boolean}) => m.sent)) {
          rewrite(x => ({...x, state: 'refunded', refund: fakeRefund()}));
        }
      });
      try {
        await expect(
          loadTopUp({topupId: QUOTE, transceive: card.transceive}),
        ).rejects.toMatchObject({kind: 'refunded'});
        expect(card.loads).toEqual([]);
        expect(card.sent.map(x => x[1])).not.toContain(LOAD);
      } finally {
        setSecure.mockImplementation(async (k: string, v: string) => {
          if (mockStoreFault.write) {
            throw mockStoreFault.write;
          }
          mockStore[k] = v;
        });
      }
    });
  });

  describe('the lists and the store', () => {
    const entryIn = (
      state: TopUpEntry['state'],
      i = 0,
      over: Partial<TopUpEntry> = {},
    ): TopUpEntry => ({
      topupId: `r${i}`,
      cardPubkey: '02ab',
      mintUrl: MINT_URL,
      bolt11: BOLT11,
      amountSat: 7,
      pieces: [4, 2, 1],
      expiry: null,
      state,
      attempts: 0,
      createdAt: i,
      updatedAt: i,
      ...(state === 'refunding' || state === 'refunded'
        ? {refund: fakeRefund()}
        : {}),
      ...over,
    });

    it('a refunding or refunded top-up holds no slots; only refunding is waiting', async () => {
      mockStore[TOPUP_KEY] = JSON.stringify({
        v: 1,
        entries: [
          entryIn('refunding', 1),
          entryIn('refunded', 2),
          entryIn('paid', 3),
        ],
      });
      expect(await reservedPiecesFor('02ab')).toBe(3);
      expect((await waitingTopUpsForCard('02ab')).map(e => e.state)).toEqual([
        'refunding',
        'paid',
      ]);
    });

    it('evicts neither refunding nor refunded entries', async () => {
      const entries = Array.from({length: MAX_TOPUP_ENTRIES}, (_, i) =>
        entryIn(i % 2 ? 'refunded' : i % 4 ? 'loaded' : 'refunding', i),
      );
      mockStore[TOPUP_KEY] = JSON.stringify({v: 1, entries});
      await startOn(new FakeCard2());
      const kept = storedEntries();
      expect(kept).toHaveLength(MAX_TOPUP_ENTRIES);
      expect(kept.filter(e => e.state === 'refunded')).toHaveLength(
        MAX_TOPUP_ENTRIES / 2,
      );
      expect(kept.filter(e => e.state === 'refunding')).toHaveLength(
        MAX_TOPUP_ENTRIES / 4,
      );
    });

    it.each([
      [
        'refunding with no refund',
        entryIn('refunding', 1, {refund: undefined}),
      ],
      [
        'a refund with no outputs',
        entryIn('refunding', 1, {refund: fakeRefund({outputs: []})}),
      ],
      [
        'a refund with a bad destination',
        entryIn('refunded', 1, {
          refund: fakeRefund({
            destination: {kind: 'onchain', value: 'x'} as never,
          }),
        }),
      ],
      [
        'a refund with a malformed proof',
        entryIn('refunding', 1, {
          refund: fakeRefund({proofs: [{id: 'k', amount: 1}] as never}),
        }),
      ],
      [
        'a paid entry carrying a refund',
        entryIn('paid', 1, {refund: fakeRefund()}),
      ],
    ])('rejects %s as corrupt', async (_n, bad) => {
      mockStore[TOPUP_KEY] = JSON.stringify({
        v: 1,
        entries: [entryIn('refunding', 0), bad],
      });
      const listed = await listTopUps();
      expect(listed.map(e => e.topupId)).toEqual(['r0']);
      expect(
        Object.keys(mockStore).some(k => k.startsWith(CORRUPT_TOPUP_KEY)),
      ).toBe(true);
    });
  });

  it('has copy for each refund stop', () => {
    expect(topUpErrorCopy('refund_unavailable')).toEqual({
      title: "This top-up can't be refunded",
      body: 'The pieces are locked to this card. Load them.',
    });
    expect(topUpErrorCopy('refund_pending').title).toBe(
      'The refund is on its way',
    );
    expect(topUpErrorCopy('refunded').title).toBe('Already refunded');
    expect(
      topUpErrorCopy(new TopUpError('refund_failed', 'Ask for a new one.')),
    ).toEqual({title: 'The refund failed', body: 'Ask for a new one.'});
    expect(topUpErrorCopy('refund_failed').body).toBe(
      'Nothing was sent. Try again.',
    );
  });
});
