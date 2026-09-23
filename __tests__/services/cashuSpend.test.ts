/* eslint-disable no-bitwise -- byte-level protocol assertions. */
/**
 * cashuSpend — the tap-to-settle orchestrator.
 *
 * Runs against a fake card (mirroring cashuCard.test.ts's harness) and the
 * REAL settlement queue over a mocked keychain, so the ordering guarantees the
 * design rests on are exercised end to end: the burn lands on the card, the
 * entry lands in the queue, and only then does anything say "paid". The mint
 * adapter is the unit seam — its wire behaviour is cashuMint.test.ts's job.
 */
import {utf8ToBytes} from '@noble/hashes/utils';
import {sha256} from '@noble/hashes/sha256';

import {
  buildApdu,
  toHex,
  type Transceiver,
} from '../../src/services/cashuCard';
import {
  burnAndRecord,
  firstUnspentSlot,
  settlePending,
} from '../../src/services/cashuSpend';
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

const mockAdapter = {swap: jest.fn(), checkState: jest.fn()};

jest.mock('../../src/services/cashuMint', () => ({
  ...jest.requireActual('../../src/services/cashuMint'),
  createSettlementAdapter: jest.fn(() => mockAdapter),
}));

const MINT_URL = 'https://forge.flashapp.me';

// ── fake card ──────────────────────────────────────────────────────────────

const OK = [0x90, 0x00];
const ok = (data: number[] = []) => [...data, ...OK];
const sw = (code: number) => [(code >> 8) & 0xff, code & 0xff];

const PUBKEY = [0x03, ...Array.from({length: 32}, (_, i) => 0xa0 + i)];
const CARD_PUBKEY_HEX = toHex(PUBKEY);
const KEYSET_BYTES = [0x00, 0x59, 0x53, 0x4c, 0xe0, 0xbf, 0xa1, 0x9a];
const KEYSET_ID = toHex(KEYSET_BYTES);
const NONCE = Array.from({length: 32}, (_, i) => 0x40 + i);
const AMOUNT = 500;
const AMOUNT_BYTES = [
  (AMOUNT >>> 24) & 0xff,
  (AMOUNT >>> 16) & 0xff,
  (AMOUNT >>> 8) & 0xff,
  AMOUNT & 0xff,
];
const C_BODY = [0x02, ...Array.from({length: 32}, (_, i) => 0x80 + i)];
const SIGNATURE = Array.from({length: 64}, (_, i) => (i * 3 + 1) & 0xff);



interface FakeCardOptions {
  statuses?: number[];
  spendThrows?: unknown;
  /** Follow-up GET_PROOFs report the slot as spent (burn landed, sig lost). */
  spentAfterSpend?: boolean;
  /** Distinct card identity: pubkey/nonce/C shift by this. Two cards sharing
   *  an id would dedupe in the queue — real cards never share one. */
  seed?: number;
}

function fakeCard(options: FakeCardOptions = {}) {
  const seed = options.seed ?? 0;
  const shift = (b: number, i: number) => (b + seed + i) & 0xff;
  const pubkey = [0x03, ...Array.from({length: 32}, (_, i) => shift(0xa0, i))];
  const nonce = Array.from({length: 32}, (_, i) => shift(0x40, i));
  const c = [0x02, ...Array.from({length: 32}, (_, i) => shift(0x80, i))];
  const sent: number[][] = [];
  // Stateful, like the card: once a burn happens, the slot reads back spent.
  let burned = false;
  const transceive: Transceiver = async apdu => {
    sent.push(apdu);
    const [, ins] = apdu;
    switch (ins) {
      case 0x01:
        // v0.1, 4 slots, 1 unspent / 0 spent / 3 empty, native+schnorr, no PIN.
        return ok([0, 1, 4, 1, 0, 3, 0x03, 0x00]);
      case 0x10:
        return ok(pubkey);
      case 0x11:
        return ok([0, 0, 0x01, 0xf4]);
      case 0x14:
        return ok(options.statuses ?? [0x00, 0x01, 0x00, 0x00]);
      case 0x13: {
        const status = options.spentAfterSpend && burned ? 0x02 : 0x01;
        return ok([status, ...KEYSET_BYTES, ...AMOUNT_BYTES, ...nonce, ...c]);
      }
      case 0x20:
        if (options.spendThrows !== undefined) {
          burned = true;
          throw options.spendThrows;
        }
        burned = true;
        return ok(SIGNATURE);
      default:
        return sw(0x6d00);
    }
  };
  return {transceive, sent, cardPubkeyHex: toHex(pubkey)};
}

// The secret the orchestrator must rebuild from the slot read alone: pinned
// here so the fixture proves nonce + pubkey flow into the exact serialization
// the mint hashed at mint time.
const EXPECTED_SECRET = JSON.stringify([
  'P2PK',
  {
    nonce: toHex(NONCE),
    data: CARD_PUBKEY_HEX,
    tags: [['sigflag', 'SIG_INPUTS']],
  },
]);

beforeEach(async () => {
  jest.clearAllMocks();
  mockAdapter.swap.mockResolvedValue(undefined);
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  await clearQueue();
});

describe('firstUnspentSlot', () => {
  it('skips empty slots and reads the first unspent one in full', async () => {
    const card = fakeCard();
    const proof = await firstUnspentSlot(card.transceive, 4);
    expect(proof).toMatchObject({slot: 1, amount: AMOUNT, keysetId: KEYSET_ID});
    const getProofApdu = card.sent.find(([, ins]) => ins === 0x13);
    expect(getProofApdu?.[2]).toBe(1);
  });

  it('returns null when every slot is spent or empty', async () => {
    const card = fakeCard({statuses: [0x02, 0x00, 0x00, 0x02]});
    await expect(firstUnspentSlot(card.transceive, 4)).resolves.toBeNull();
  });
});

describe('burnAndRecord', () => {
  it('spends the slot and records a pending settlement with the reconstructed secret', async () => {
    const card = fakeCard();
    const entry = await burnAndRecord({
      transceive: card.transceive,
      slot: 1,
      mintUrl: MINT_URL,
      now: 1000,
    });

    expect(entry.status).toBe('pending');
    expect(entry.witness).toBe(toHex(SIGNATURE));
    expect(entry.secret).toBe(EXPECTED_SECRET);
    expect(entry.mintUrl).toBe(MINT_URL);
    expect(entry.unit).toBe('sat');
    expect(entry.amount).toBe(AMOUNT);
    expect(entry.cardPubkey).toBe(CARD_PUBKEY_HEX);

    // The card signs sha256(utf8(secret)) — the NUT-11 message.
    const message = Array.from(sha256(utf8ToBytes(EXPECTED_SECRET)));
    const spendApdu = card.sent.find(([, ins]) => ins === 0x20);
    expect(spendApdu).toEqual(
      buildApdu(0x20, {p1: 1, data: message, le: 0x40}),
    );

    await expect(hasUnsettledForCard(CARD_PUBKEY_HEX)).resolves.toBe(true);
  });

  it('refuses to spend a slot the card reports spent, recording nothing', async () => {
    const card = fakeCard();
    const spentOnly: Transceiver = async apdu => {
      if (apdu[1] === 0x13) {
        return ok([0x02, ...KEYSET_BYTES, ...AMOUNT_BYTES, ...NONCE, ...C_BODY]);
      }
      return card.transceive(apdu);
    };
    await expect(
      burnAndRecord({transceive: spentOnly, slot: 0, mintUrl: MINT_URL}),
    ).rejects.toThrow(/spent/i);
    await expect(listSettlements()).resolves.toEqual([]);
  });

  it('records needs-card when the burn lands but the signature is lost', async () => {
    const card = fakeCard({
      spendThrows: new Error('card left the field'),
      spentAfterSpend: true,
    });
    const entry = await burnAndRecord({
      transceive: card.transceive,
      slot: 1,
      mintUrl: MINT_URL,
      now: 1000,
    });
    expect(entry.status).toBe('needs-card');
    expect(entry.witness).toBeUndefined();
    await expect(hasUnsettledForCard(CARD_PUBKEY_HEX)).resolves.toBe(true);
  });

  it('surfaces the error when the burn never happened', async () => {
    const card = fakeCard({spendThrows: new Error('SW 6a86')});
    await expect(
      burnAndRecord({transceive: card.transceive, slot: 1, mintUrl: MINT_URL}),
    ).rejects.toThrow('SW 6a86');
    await expect(listSettlements()).resolves.toEqual([]);
  });
});

describe('settlePending', () => {
  it('drains through the mint adapter and settles the recorded entry', async () => {
    const card = fakeCard();
    await burnAndRecord({
      transceive: card.transceive,
      slot: 1,
      mintUrl: MINT_URL,
      now: 1000,
    });

    const result = await settlePending(2000);
    expect(result.settled).toBe(1);
    const entries = await listSettlements();
    expect(entries.find(e => e.status === 'settled')).toMatchObject({
      secret: EXPECTED_SECRET,
      mintUrl: MINT_URL,
    });
    expect(mockAdapter.swap).toHaveBeenCalledWith(
      expect.objectContaining({mintUrl: MINT_URL}),
    );
  });

  it('settles each entry against the mint that issued it', async () => {
    // Two burns from two mints share one queue; a single drain must route
    // each to its own mint — that is why mintUrl is persisted per entry.
    const first = fakeCard();
    await burnAndRecord({
      transceive: first.transceive,
      slot: 1,
      mintUrl: MINT_URL,
      now: 1000,
    });
    const second = fakeCard({seed: 1});
    await burnAndRecord({
      transceive: second.transceive,
      slot: 1,
      mintUrl: 'https://other-mint.example',
      now: 1001,
    });

    const result = await settlePending(2000);
    expect(result.settled).toBe(2);
    const settledMints = (await listSettlements())
      .filter(e => e.status === 'settled')
      .map(e => e.mintUrl)
      .sort();
    expect(settledMints).toEqual([
      'https://forge.flashapp.me',
      'https://other-mint.example',
    ]);
  });

  it('keeps an ambiguous failure in submitting rather than failing it', async () => {
    const card = fakeCard();
    await burnAndRecord({
      transceive: card.transceive,
      slot: 1,
      mintUrl: MINT_URL,
      now: 1000,
    });
    // A 5xx-style rejection: the mint may already hold the proof.
    const ambiguous = Object.assign(new Error('bad gateway'), {status: 502});
    mockAdapter.swap.mockRejectedValueOnce(ambiguous);

    const result = await settlePending(2000);
    expect(result.stillPending).toBe(1);
    const entries = await listSettlements();
    expect(entries.find(e => e.id.startsWith(CARD_PUBKEY_HEX))?.status).toBe(
      'submitting',
    );
  });
});
