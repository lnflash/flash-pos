/**
 * cashuTopUp (ENG-853): rounding, the room check, the `@cashu_topups` store,
 * the quote poll and the load onto the card. The card is the APDU-level
 * FakeCard2; the mint calls are mocked at cashuMint's top-up seam, with real
 * blind signatures from the shared TestMint so a piece's C is the mint's
 * signature on exactly the secret the card will rebuild.
 */
import {bytesToHex} from '@noble/hashes/utils';

import {
  canTopUp,
  CORRUPT_TOPUP_KEY,
  listTopUps,
  loadTopUp,
  MAX_TOPUP_ENTRIES,
  pollTopUp,
  refreshWaitingTopUps,
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
} from '../../src/services/cashuTopUp';
import {readCard, type CardSummary} from '../../src/services/cashuCard';
import {
  buildCardSigAllSecret,
  TopUpMintError,
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
  };
});

const cashu = jest.requireActual('@cashu/cashu-ts');
const mintMocks = jest.requireMock('../../src/services/cashuMint') as {
  createTopUpQuote: jest.Mock;
  checkTopUpQuote: jest.Mock;
  mintTopUp: jest.Mock;
  restoreTopUp: jest.Mock;
  topUpKeyset: jest.Mock;
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

  it('does not hold slots for a quote that is not paid yet', async () => {
    const card = new FakeCard2({slotCount: 3});
    await startOn(card, 7);
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
