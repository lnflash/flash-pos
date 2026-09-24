/**
 * cashuCharge — Model B: enter amount, tap, exact spend with change from the
 * till. The fake card (cashuSpend.test.ts's harness, extended with VERIFY_PIN
 * and LOAD_PROOF) meets the REAL planning, till staging, and queue recording;
 * the mint adapter is the seam (its wire behaviour is cashuMint.test.ts's).
 */
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils';
import {sha256} from '@noble/hashes/sha256';

import {
  buildApdu,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';
import {buildCardP2PKSecret} from '../../src/services/cashuMint';
import {chargeCard, planPurchase} from '../../src/services/cashuCharge';
import {
  clearQueue,
  hasUnsettledForCard,
  listSettlements,
} from '../../src/services/cashuSettlement';

const mockStore: Record<string, string> = {};

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

function fakeCard(opts: {
  slots: SlotSpec[];
  pin?: string;
  loadsGiven?: {slot: number}[];
}) {
  const sent: number[][] = [];
  const loads: {keysetId: string; amount: number; nonce: string; C: string}[] = [];
  const burned = new Set<number>();
  let burnCount = 0;
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const [, ins] = apdu;
    const p1 = apdu[2];
    switch (ins) {
      case 0xa4:
        // SELECT: v0.2 applet.
        return ok([0, 2]);
      case 0x01:
        return ok([0, 2, opts.slots.length, 0, 0, opts.slots.length, 0x03, 0x01]);
      case 0x10:
        return ok(PUBKEY);
      case 0x11: {
        const bal = opts.slots
          .filter((s, i) => s.status === 0x01 && !burned.has(i))
          .reduce((t, s) => t + s.amount, 0);
        return ok([0, 0, (bal >> 8) & 0xff, bal & 0xff]);
      }
      case 0x40:
        if (opts.pin === undefined) return sw(0x6984);
        const given = apdu.slice(5, 5 + apdu[4]);
        const expected = Array.from(opts.pin).map(c => c.charCodeAt(0));
        return Buffer.from(given).equals(Buffer.from(expected)) ? ok() : sw(0x63c2);
      case 0x14:
        return ok(
          opts.slots.map(s => s.status),
        );
      case 0x13: {
        const s = opts.slots[p1];
        const status = burned.has(p1) ? 0x02 : s.status;
        const nonce = Array.from({length: 32}, (_, i) => (0x40 + p1 * 4 + i) & 0xff);
        const c = [0x02, ...Array.from({length: 32}, (_, i) => (0x80 + p1 * 2 + i) & 0xff)];
        const a = s.amount;
        return ok([
          status,
          ...KEYSET_BYTES,
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
        const body = apdu.slice(5, 5 + apdu[4]);
        const amount = (body[8] << 24) | (body[9] << 16) | (body[10] << 8) | body[11];
        const record = {
          keysetId: toHex(body.slice(0, 8)),
          amount,
          nonce: toHex(body.slice(12, 44)),
          C: toHex(body.slice(44, 77)),
        };
        loads.push(record);
        (opts.loadsGiven ?? (opts.loadsGiven = [])).push({slot: opts.slots.length});
        return ok([opts.slots.length + loads.length - 1]);
      }
      default:
        return sw(0x6d00);
    }
  };
  return {transceive, sent, loads, get burnCount() {return burnCount;}};
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
  JSON.parse(mockStore['@cashu_settled_proofs'] ?? '[]') as {secret: string}[];

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  await clearQueue();
});

describe('planPurchase', () => {
  const slots = [
    {slot: 0, amount: 16, keysetId: KEYSET_ID, nonce: 'aa', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
    {slot: 1, amount: 4, keysetId: KEYSET_ID, nonce: 'bb', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
    {slot: 2, amount: 1, keysetId: KEYSET_ID, nonce: 'cc', C: CARD_PUBKEY_HEX, status: 'unspent' as const},
  ];

  it('prefers an exact subset', () => {
    expect(planPurchase(slots, 4, 0)).toEqual({
      slots: [1],
      burnedSat: 4,
      changeSat: 0,
    });
  });

  it('exact subsets can be multi-slot', () => {
    expect(planPurchase(slots, 5, 0)).toEqual({
      slots: [1, 2],
      burnedSat: 5,
      changeSat: 0,
    });
  });

  it('over-covers when no exact subset exists, bounded by the till', () => {
    expect(planPurchase(slots, 10, 16)).toEqual({
      slots: [0],
      burnedSat: 16,
      changeSat: 6,
    });
  });

  it('refuses an over-cover the till cannot back', () => {
    const r = planPurchase(slots, 10, 5);
    expect('error' in r && r.error).toMatch(/change would be 6 sat/);
  });

  it('refuses when the card cannot cover the bill at all', () => {
    expect('error' in planPurchase(slots, 99, 99)).toBe(true);
  });
});

describe('chargeCard', () => {
  it('exact charge: verifies PIN, burns, records — no change, no till writes', async () => {
    const card = fakeCard({
      slots: [
        {amount: 16, status: 0x01},
        {amount: 4, status: 0x01},
        {amount: 1, status: 0x01},
      ],
      pin: '1234',
    });
    seedTill([{amount: 8, denom: 8}]);

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
    expect(result.burned.every(e => e.status === 'pending')).toBe(true);

    // VERIFY_PIN before any burn (D13): its APDU precedes the SPEND_PROOFs.
    const verifyIdx = card.sent.findIndex(([, ins]) => ins === 0x40);
    const burnIdx = card.sent.findIndex(([, ins]) => ins === 0x20);
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(burnIdx);

    const entries = await listSettlements();
    expect(entries.filter(e => e.status === 'pending')).toHaveLength(2);
    // The till is untouched by an exact purchase.
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

    const result = await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(result.burned).toHaveLength(1);
    expect(result.changeSat).toBe(6);
    // Change = [2, 4] — the till's small denominations, spent small-first.
    expect(result.changeLoaded).toBe(2);
    expect(card.loads).toEqual([
      expect.objectContaining({amount: 2}),
      expect.objectContaining({amount: 4}),
    ]);
    // The till paid out its change: those proofs left the store.
    expect(tillProofs()).toHaveLength(0);
    await expect(hasUnsettledForCard(CARD_PUBKEY_HEX)).resolves.toBe(true);
  });

  it('refuses before burning when the till cannot make exact change', async () => {
    const card = fakeCard({
      slots: [{amount: 16, status: 0x01}],
      pin: '1234',
    });
    seedTill([{amount: 16, denom: 16}]);

    await expect(
      chargeCard({
        transceive: card.transceive,
        amountSat: 10,
        pin: '1234',
        mintUrl: MINT_URL,
      }),
    ).rejects.toThrow(/cannot make 6 sat exact change/);
    // Nothing burned, nothing recorded, till intact.
    expect(card.sent.find(([, ins]) => ins === 0x20)).toBeUndefined();
    await expect(listSettlements()).resolves.toEqual([]);
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

  it('the nonce written back is the one from the till secret', async () => {
    const card = fakeCard({slots: [{amount: 16, status: 0x01}], pin: '1234'});
    seedTill([{amount: 4, denom: 4}, {amount: 2, denom: 2}]);
    const till = JSON.parse(mockStore['@cashu_settled_proofs']) as {
      secret: string;
    }[];

    await chargeCard({
      transceive: card.transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL,
    });

    // Each loaded proof's nonce comes from its till secret's P2PK envelope.
    for (const load of card.loads) {
      const match = till.find(t => load.nonce === JSON.parse(t.secret)[1].nonce);
      expect(match).toBeDefined();
    }
  });
});
