/**
 * cashuSpend — tap-to-pay on a 2.0 card: one SIG_ALL signature per payment.
 *
 * Runs against the 2.0 card model (`__tests__/support/cardProtocol2.ts`: the
 * applet's payment commands with a real BIP-340 signature over a SIG_ALL
 * message it builds itself) and the REAL settlement queue over a mocked
 * keychain, so the ordering guarantees the design rests on are exercised end
 * to end: the payment burns on the card, ONE entry lands in the queue holding
 * everything the card signed, and only then does anything say "paid". The
 * mint adapter is the unit seam — its wire behaviour is cashuMint.test.ts's.
 */
import {schnorrSignDigest} from '@cashu/cashu-ts';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';

import {
  CardAuthError,
  CardError,
  CardProtocolError,
  proveCardKey,
  type ProvenCardKey,
  type Transceiver,
} from '../../src/services/cashuCard';
import {
  prepareChargeOutputs,
  sigAllMessage,
  verifyCardSignature,
} from '../../src/services/cashuMint';
import {
  recoverNeedsCard,
  settlePending,
  spendAll,
  tellTheClock,
} from '../../src/services/cashuSpend';
import {
  clearQueue,
  hasUnsettledForCard,
  listSettlements,
  type SettlementInput,
} from '../../src/services/cashuSettlement';
import {setSecure} from '../../src/services/secureStorage';
import {
  FakeCard2,
  KEYSET_ID,
  MINT_URL,
  TestMint,
  cardWithPieces,
  headerVectors,
  resetTestMint,
} from '../support/cardProtocol2';

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

let mint: TestMint;

beforeEach(async () => {
  jest.clearAllMocks();
  mockAdapter.swap.mockResolvedValue(undefined);
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  mint = resetTestMint();
  await clearQueue();
});

/** The card's own key, proven by AUTH over its transceiver. */
const proven = (card: FakeCard2) => proveCardKey(card.transceive, card.pubkey);

/** The inputs a charge builds for `slots` of `card` (as executeCharge does). */
function inputsOf(card: FakeCard2, slots: number[]): SettlementInput[] {
  return slots.map(slot => {
    const s = card.slots[slot]!;
    return {
      slot,
      nonce: s.nonce,
      secret: mint.mintPiece(card.pubkey, s.amount, {nonce: s.nonce}).secret,
      C: s.C,
      amount: s.amount,
      keysetId: KEYSET_ID,
    };
  });
}

/** A payment of `amountSat` from the slots, with the rest as the card's change. */
function paymentArgs(
  card: FakeCard2,
  slots: number[],
  amountSat: number,
  extra: Partial<Parameters<typeof spendAll>[0]> = {},
) {
  const inputs = inputsOf(card, slots);
  const total = inputs.reduce((t, i) => t + i.amount, 0);
  return {
    transceive: card.transceive,
    inputs,
    merchant: prepareChargeOutputs({
      keysetId: KEYSET_ID,
      merchantSat: amountSat,
    }),
    changeSat: total - amountSat,
    changeKeysetId: KEYSET_ID,
    cardPubkey: card.pubkey,
    mintUrl: MINT_URL,
    now: 1_790_000_000_000,
    ...extra,
  };
}

describe('spendAll', () => {
  it('persists the exact merchant recovery intent before SIGN can consume any input', async () => {
    const card = cardWithPieces([8, 4]);
    const args = paymentArgs(card, [0, 1], 10);
    const tx = args.transceive;
    args.transceive = async apdu => {
      if (apdu[1] === 0x24) {
        const [saved] = await listSettlements();
        expect(saved).toMatchObject({
          status: 'prepared',
          inputs: args.inputs,
          merchantBlinding: args.merchant.blinding,
        });
        expect(saved.outputs).toHaveLength(3);
        expect(saved.message).toBe(
          bytesToHex(sigAllMessage(saved.inputs, saved.outputs)),
        );
        expect(saved.witness).toBeUndefined();
      }
      return tx(apdu);
    };
    const result = await spendAll(args);
    expect(result.entry.status).toBe('pending');
    await expect(listSettlements()).resolves.toHaveLength(1);
  });

  it('a refused intent write prevents SIGN and leaves every card input unspent', async () => {
    const card = cardWithPieces([8]);
    jest
      .mocked(setSecure)
      .mockRejectedValueOnce(new Error('intent write denied'));
    await expect(spendAll(paymentArgs(card, [0], 8))).rejects.toThrow(
      'intent write denied',
    );
    expect(card.insSent).not.toContain(0x24);
    expect(card.burnCount).toBe(0);
  });

  it('keeps a preparation after consumption if saving the witness fails, then recovers the same payment', async () => {
    const card = cardWithPieces([8]);
    const args = paymentArgs(card, [0], 8);
    args.onSign = () => {
      jest
        .mocked(setSecure)
        .mockRejectedValueOnce(new Error('witness write denied'));
    };
    await expect(spendAll(args)).rejects.toThrow('witness write denied');
    expect(card.burnCount).toBe(1);
    const [prepared] = await listSettlements();
    expect(prepared.status).toBe('prepared');
    expect(prepared.merchantBlinding).toEqual(args.merchant.blinding);
    await expect(hasUnsettledForCard(card.pubkey)).resolves.toBe(true);
    const recovered = await recoverNeedsCard({
      transceive: card.transceive,
      cardKey: await proven(card),
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: prepared.id,
      status: 'pending',
      outputs: prepared.outputs,
    });
    expect(card.burnCount).toBe(1);
  });

  it('reconciles an unchanged unspent preparation after stopping before SIGN', async () => {
    const card = cardWithPieces([8]);
    await expect(
      spendAll({
        ...paymentArgs(card, [0], 8),
        onSign: () => {
          throw new Error('stopped');
        },
      }),
    ).rejects.toThrow('stopped');
    expect((await listSettlements())[0].status).toBe('prepared');
    await recoverNeedsCard({
      transceive: card.transceive,
      cardKey: await proven(card),
    });
    await expect(listSettlements()).resolves.toEqual([]);
    expect(card.insSent).not.toContain(0x24);
    await expect(spendAll(paymentArgs(card, [0], 8))).resolves.toMatchObject({
      entry: {status: 'pending'},
    });
    expect(card.burnCount).toBe(1);
  });

  it('rejects merchant recovery material that cannot open its output before touching the card', async () => {
    const card = cardWithPieces([8]);
    const args = paymentArgs(card, [0], 8);
    args.merchant.blinding[0].secret = 'different secret';
    await expect(spendAll(args)).rejects.toThrow('does not match');
    expect(card.sent).toHaveLength(0);
  });

  it("pays with one signature over every piece, the merchant's outputs and the card's change, and records ONE pending entry", async () => {
    const card = cardWithPieces([8, 16, 4]);
    const args = paymentArgs(card, [0, 1], 19);

    const {entry, signed} = await spendAll(args);

    // Both places burned in the one commit; the third untouched.
    expect(card.slots.map(s => s?.status)).toEqual(
      expect.arrayContaining([2, 2, 1]),
    );
    expect(card.slots[2]?.status).toBe(1);
    expect(entry.status).toBe('pending');
    expect(entry.sigflag).toBe('SIG_ALL');
    expect(entry.inputs.map(i => i.slot)).toEqual([0, 1]);
    expect(entry.amount).toBe(24);
    // The merchant's 19 (16 + 2 + 1), then the card's own 5 (4 + 1).
    expect(entry.outputs.map(o => o.amount)).toEqual([16, 2, 1, 4, 1]);
    expect(entry.cardChangeIndex).toBe(3);
    expect(entry.merchantBlinding).toEqual(args.merchant.blinding);
    // The witness signs exactly the stored payment, under the card's key.
    expect(entry.message).toBe(
      bytesToHex(sigAllMessage(entry.inputs, entry.outputs)),
    );
    expect(
      verifyCardSignature(entry.witness!, entry.message!, card.pubkey),
    ).toBe(true);
    expect(signed).toEqual({
      inputs: entry.inputs,
      witness: entry.witness,
      outputs: entry.outputs,
      merchantBlinding: entry.merchantBlinding,
      cardChangeIndex: 3,
    });
    // And a mint accepts that exact swap.
    expect(() =>
      mint.swap({
        inputs: entry.inputs.map((i, k) => ({
          id: i.keysetId,
          amount: i.amount,
          secret: i.secret,
          C: i.C,
          ...(k === 0
            ? {witness: JSON.stringify({signatures: [entry.witness]})}
            : {}),
        })),
        outputs: entry.outputs.map(o => ({
          amount: o.amount,
          id: o.keysetId,
          B_: o.B_,
        })),
      }),
    ).not.toThrow();
    await expect(hasUnsettledForCard(card.pubkey)).resolves.toBe(true);
    await expect(listSettlements()).resolves.toHaveLength(1);
  });

  it('shows the card the clock BEFORE the payment begins: TELL_TIME, SET_HEADER, then BEGIN', async () => {
    const card = cardWithPieces([8]);
    const header = Array.from(Buffer.from(headerVectors()[11].header, 'hex'));
    await spendAll({...paymentArgs(card, [0], 8), header});

    const order = card.insSent;
    expect(order.slice(0, 3)).toEqual([0x37, 0x36, 0x22]);
    expect(order).toEqual([0x37, 0x36, 0x22, 0x23, 0x24]);
    expect(card.headers).toEqual([header]);
    expect(card.tapTime).toBe(1_790_000_000);
  });

  it('a header the card refuses (6A93) never stops a payment', async () => {
    const card = cardWithPieces([8]);
    const refusing: Transceiver = async apdu =>
      apdu[1] === 0x36 ? [0x6a, 0x93] : card.transceive(apdu);
    const {entry} = await spendAll({
      ...paymentArgs(card, [0], 8),
      transceive: refusing,
      header: new Array(80).fill(1),
    });
    expect(entry.status).toBe('pending');
  });

  it('an exact bill has no change output', async () => {
    const card = cardWithPieces([8]);
    const {entry} = await spendAll(paymentArgs(card, [0], 8));
    expect(entry.outputs.map(o => o.amount)).toEqual([8]);
    expect(entry.cardChangeIndex).toBeUndefined();
    expect(card.insSent).not.toContain(0x26);
  });

  it('calls onSign once, just before SPEND_ALL_SIGN', async () => {
    const card = cardWithPieces([8]);
    let sentAtSign: number[] = [];
    await spendAll({
      ...paymentArgs(card, [0], 8),
      onSign: () => {
        sentAtSign = [...card.insSent];
      },
    });
    expect(sentAtSign).not.toContain(0x24);
    expect(sentAtSign[sentAtSign.length - 1]).toBe(0x23);
  });

  it('a card that asks for its PIN at SIGN (6A94) has burned nothing, and nothing is recorded', async () => {
    const card = cardWithPieces([8], {pin: '1234'});
    const failure = await spendAll(paymentArgs(card, [0], 8)).catch(e => e);
    expect(failure).toBeInstanceOf(CardError);
    expect(failure.sw).toBe(0x6a94);
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
  });

  it('over the daily limit at SIGN (6A8F): nothing burned, nothing recorded', async () => {
    const card = cardWithPieces([8], {dailyLimit: 5});
    await expect(spendAll(paymentArgs(card, [0], 8))).rejects.toMatchObject({
      sw: 0x6a8f,
    });
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
  });

  it('waits out the card\'s "not yet" answers', async () => {
    const card = cardWithPieces([8], {signWaits: 3});
    const {entry} = await spendAll(paymentArgs(card, [0], 8));
    expect(entry.status).toBe('pending');
    expect(card.insSent.filter(i => i === 0x24)).toHaveLength(4);
  });

  it("stops before any output when the card's places are not the plan's", async () => {
    const card = cardWithPieces([8, 16]);
    const args = paymentArgs(card, [0], 8);
    args.inputs[0] = {...args.inputs[0], amount: 4};
    await expect(spendAll(args)).rejects.toThrow(/worth 8 sat, the plan 4/);
    expect(card.insSent).not.toContain(0x23);
    expect(card.burnCount).toBe(0);
  });

  describe('a lost SIGN answer', () => {
    it('with the places unspent: the error surfaces, nothing is recorded', async () => {
      const card = cardWithPieces([8], {dropBeforeSign: () => true});
      await expect(spendAll(paymentArgs(card, [0], 8))).rejects.toThrow(
        'Tag was lost.',
      );
      expect(card.burnCount).toBe(0);
      await expect(listSettlements()).resolves.toEqual([]);
    });

    it('with the places spent and SPEND_ALL_AGAIN verifying: the payment is pending', async () => {
      const card = cardWithPieces([8, 4], {loseSignAnswer: () => true});
      const {entry, signed} = await spendAll(paymentArgs(card, [0, 1], 10));
      expect(card.insSent).toContain(0x14);
      expect(card.insSent[card.insSent.length - 1]).toBe(0x25);
      expect(entry.status).toBe('pending');
      expect(
        verifyCardSignature(entry.witness!, entry.message!, card.pubkey),
      ).toBe(true);
      expect(signed).not.toBeNull();
    });

    it('with SPEND_ALL_AGAIN failing too: needs-card, with everything it signed kept', async () => {
      const card = cardWithPieces([8, 4], {
        loseSignAnswer: () => true,
        loseAgain: () => true,
      });
      const args = paymentArgs(card, [0, 1], 10);
      const {entry, signed} = await spendAll(args);

      expect(signed).toBeNull();
      expect(entry.status).toBe('needs-card');
      expect(entry.witness).toBeUndefined();
      expect(entry.inputs.map(i => i.slot)).toEqual([0, 1]);
      expect(entry.outputs.map(o => o.amount)).toEqual([8, 2, 2]);
      expect(entry.merchantBlinding).toEqual(args.merchant.blinding);
      expect(entry.message).toBe(
        bytesToHex(sigAllMessage(entry.inputs, entry.outputs)),
      );
      await expect(hasUnsettledForCard(card.pubkey)).resolves.toBe(true);
    });

    it('a signature SPEND_ALL_AGAIN gives for another payment is rejected: needs-card', async () => {
      const holder: {card?: FakeCard2} = {};
      const card = cardWithPieces([8], {
        loseSignAnswer: () => true,
        failBefore: ins => {
          if (ins === 0x25 && holder.card) {
            // The card's last signature is some other payment's.
            holder.card.lastSig = {sig: '11'.repeat(64), noPin: false};
          }
          return false;
        },
      });
      holder.card = card;
      const {entry} = await spendAll(paymentArgs(card, [0], 8));
      expect(entry.status).toBe('needs-card');
      expect(entry.witness).toBeUndefined();
    });

    it('a card that answers SIGN with a signature that does not verify is asked again, and recorded failed (not needs-card) when that fails too', async () => {
      // An HCE emulator replaying pieces read off a real card (GET_PIECES and
      // GET_DLEQ need no PIN) answers SIGN and AGAIN with bytes that are no
      // signature of this payment: there is no lost answer to recover.
      const card = cardWithPieces([8], {badSignature: true});
      const {entry, signed} = await spendAll(paymentArgs(card, [0], 8));
      expect(card.insSent).toContain(0x25);
      expect(signed).toBeNull();
      expect(entry.status).toBe('failed');
      expect(entry.witness).toBeUndefined();
      expect(entry.lastError).toMatch(/does not verify/);
      const [stored] = await listSettlements();
      expect(stored.status).toBe('failed');
      // Never offered to SPEND_ALL_AGAIN again at a later tap.
      await expect(
        recoverNeedsCard({
          transceive: card.transceive,
          cardKey: await proven(card),
        }),
      ).resolves.toEqual([]);
      expect(card.insSent.filter(i => i === 0x25)).toHaveLength(1);
    });

    it('a garbled SIGN answer that AGAIN then gives correctly is pending', async () => {
      // The card's answer to SIGN was corrupted, its kept signature is good:
      // AGAIN's answer verifies, so this is an ordinary payment.
      const card = cardWithPieces([8], {badSignature: true});
      const args = paymentArgs(card, [0], 8);
      const good = schnorrSignDigest(
        sigAllMessage(args.inputs, args.merchant.outputs),
        card.priv,
      );
      args.transceive = async apdu =>
        apdu[1] === 0x25
          ? [...Array.from(hexToBytes(good)), 0x90, 0x00]
          : card.transceive(apdu);
      const {entry, signed} = await spendAll(args);
      expect(entry.status).toBe('pending');
      expect(entry.witness).toBe(good);
      expect(signed).not.toBeNull();
    });
  });
});

describe('spendAll: the change pieces it is told (ENG-701)', () => {
  /** SPEND_ALL_CHANGE's amounts, in the order the card was asked for them. */
  const changeAsked = (card: FakeCard2) =>
    card.sent.filter(a => a[1] === 0x26).map(a => a[8]);

  it('a card holding only 8 that pays 3 makes its change in the pieces the plan names', async () => {
    const card = cardWithPieces([8]);
    const {entry, signed} = await spendAll({
      ...paymentArgs(card, [0], 3),
      changePieces: [2, 2, 1],
    });

    expect(changeAsked(card)).toEqual([2, 2, 1]);
    expect(
      entry.outputs.slice(entry.cardChangeIndex).map(o => o.amount),
    ).toEqual([2, 2, 1]);
    expect(signed).not.toBeNull();
    // The mint takes the swap with those outputs, as the card signed them.
    expect(() =>
      mint.swap({
        inputs: entry.inputs.map((i, k) => ({
          id: i.keysetId,
          amount: i.amount,
          secret: i.secret,
          C: i.C,
          ...(k === 0
            ? {witness: JSON.stringify({signatures: [entry.witness]})}
            : {}),
        })),
        outputs: entry.outputs.map(o => ({
          amount: o.amount,
          id: o.keysetId,
          B_: o.B_,
        })),
      }),
    ).not.toThrow();
  });

  it('names no pieces: the fewest, as before', async () => {
    const card = cardWithPieces([8]);
    await spendAll(paymentArgs(card, [0], 3));
    expect(changeAsked(card)).toEqual([4, 1]);
  });

  it.each([
    ['a list that does not sum to the change', [4, 2], 5],
    ['a piece that is not a power of two', [3, 2], 5],
    ['change pieces on an exact bill', [1], 0],
    ['no pieces for change that is due', [], 5],
  ])('refuses %s before any APDU', async (_label, changePieces, changeSat) => {
    const card = cardWithPieces([8]);
    const failure = await spendAll({
      ...paymentArgs(card, [0], 8 - (changeSat as number)),
      changePieces: changePieces as number[],
    }).catch(e => e);
    expect(failure).toBeInstanceOf(CardProtocolError);
    expect(card.sent).toEqual([]);
    expect(card.burnCount).toBe(0);
    await expect(listSettlements()).resolves.toEqual([]);
  });
});

describe('tellTheClock', () => {
  it('a refusal of either note is ignored; a transport failure is not', async () => {
    const refusing: Transceiver = async () => [0x6d, 0x00];
    await expect(
      tellTheClock(refusing, 0, new Array(80).fill(0)),
    ).resolves.toBeUndefined();
    const gone: Transceiver = async () => {
      throw new Error('Tag was lost.');
    };
    await expect(tellTheClock(gone, 0)).rejects.toThrow('Tag was lost.');
  });
});

describe('recoverNeedsCard', () => {
  /** A payment burned with its signature lost, the card still holding it. */
  async function needsCardPayment(card: FakeCard2) {
    const {entry} = await spendAll(paymentArgs(card, [0], 8));
    expect(entry.status).toBe('needs-card');
    return entry;
  }

  it("attaches the card's last signature when it verifies: the entry is pending", async () => {
    let lose = true;
    const card = cardWithPieces([8], {
      loseSignAnswer: () => true,
      loseAgain: () => lose,
    });
    const entry = await needsCardPayment(card);
    lose = false;

    const recovered = await recoverNeedsCard({
      transceive: card.transceive,
      cardKey: await proven(card),
      now: 5000,
    });

    expect(recovered.map(e => e.id)).toEqual([entry.id]);
    const [stored] = await listSettlements();
    expect(stored.status).toBe('pending');
    expect(
      verifyCardSignature(stored.witness!, stored.message!, card.pubkey),
    ).toBe(true);
  });

  it('a payment the card has signed past is marked failed, never dropped', async () => {
    let lose = true;
    const card = cardWithPieces([8, 4], {
      loseSignAnswer: n => n === 0,
      loseAgain: () => lose,
    });
    const entry = await needsCardPayment(card);
    lose = false;
    // Another payment since: the card's last signature is that one's.
    await spendAll(paymentArgs(card, [1], 4));

    const recovered = await recoverNeedsCard({
      transceive: card.transceive,
      cardKey: await proven(card),
      now: 5000,
    });

    expect(recovered).toEqual([]);
    const stored = (await listSettlements()).find(e => e.id === entry.id)!;
    expect(stored.status).toBe('failed');
    expect(stored.lastError).toMatch(/signed another payment/);
  });

  it('a card that will not give its signature again leaves the entry as it was', async () => {
    const card = cardWithPieces([8], {
      loseSignAnswer: () => true,
      loseAgain: () => true,
    });
    const entry = await needsCardPayment(card);
    await expect(
      recoverNeedsCard({
        transceive: card.transceive,
        cardKey: await proven(card),
      }),
    ).resolves.toEqual([]);
    expect((await listSettlements())[0]).toMatchObject({
      id: entry.id,
      status: 'needs-card',
    });
  });

  it('asks the card nothing past AUTH when this card owes nothing', async () => {
    const card = cardWithPieces([8]);
    const cardKey = await proven(card);
    const before = card.sent.length;
    await recoverNeedsCard({transceive: card.transceive, cardKey});
    expect(card.sent).toHaveLength(before);
  });

  describe('only for a key AUTH proved in this tap (ENG-674)', () => {
    /** card A's needs-card payment, and the APDUs card A has seen since. */
    async function aOwes() {
      const a = cardWithPieces([8], {
        loseSignAnswer: () => true,
        loseAgain: () => true,
      });
      const entry = await needsCardPayment(a);
      return {a, entry, sentBefore: a.sent.length};
    }

    async function untouched(entryId: string) {
      const stored = await listSettlements();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({id: entryId, status: 'needs-card'});
      expect(stored[0].witness).toBeUndefined();
      expect(stored[0].lastError).toBeUndefined();
    }

    it('a card that fails AUTH for the key it claims gets no proof, and the needs-card entries stay as they were', async () => {
      const {a, entry} = await aOwes();
      // Card A's key, claimed by a card whose AUTH signs under another key.
      const impostor = cardWithPieces([4], {
        privateKey: '33'.repeat(32),
        forgeAuth: true,
      });
      await expect(proveCardKey(impostor.transceive, a.pubkey)).rejects.toThrow(
        CardAuthError,
      );
      expect(impostor.insSent).not.toContain(0x25);
      await untouched(entry.id);
    });

    it('a key that is not a proof, or was proven over another tap, is refused before the card is asked anything', async () => {
      const {a, entry, sentBefore} = await aOwes();
      const forged = {pubkey: a.pubkey} as ProvenCardKey;
      await expect(
        recoverNeedsCard({transceive: a.transceive, cardKey: forged}),
      ).rejects.toThrow(CardAuthError);
      // Proven by card A on one tap, offered with whatever is on the next.
      const earlier = await proven(a);
      const sentAfterAuth = a.sent.length;
      const nextTap: Transceiver = apdu => a.transceive(apdu);
      await expect(
        recoverNeedsCard({transceive: nextTap, cardKey: earlier}),
      ).rejects.toThrow(CardAuthError);
      expect(a.sent.length).toBe(sentAfterAuth);
      expect(sentAfterAuth).toBe(sentBefore + 1);
      await untouched(entry.id);
    });
  });
});

describe('settlePending', () => {
  it('drains through the mint adapter and settles the recorded payment', async () => {
    const card = cardWithPieces([8]);
    const {entry} = await spendAll(paymentArgs(card, [0], 8));

    const result = await settlePending(2000);
    expect(result.settled).toBe(1);
    const entries = await listSettlements();
    expect(entries.find(e => e.status === 'settled')).toMatchObject({
      id: entry.id,
      mintUrl: MINT_URL,
      sigflag: 'SIG_ALL',
    });
    expect(mockAdapter.swap).toHaveBeenCalledWith(
      expect.objectContaining({mintUrl: MINT_URL, outputs: entry.outputs}),
    );
  });

  it('settles each payment against the mint that issued it', async () => {
    // Two payments from two mints share one queue; a single drain must route
    // each to its own mint — that is why mintUrl is persisted per entry.
    const first = cardWithPieces([8]);
    await spendAll(paymentArgs(first, [0], 8));
    const second = cardWithPieces([8], {privateKey: '33'.repeat(32)});
    await spendAll({
      ...paymentArgs(second, [0], 8),
      mintUrl: 'https://other-mint.example',
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
    const card = cardWithPieces([8]);
    await spendAll(paymentArgs(card, [0], 8));
    // A 5xx-style rejection: the mint may already hold the payment.
    const ambiguous = Object.assign(new Error('bad gateway'), {status: 502});
    mockAdapter.swap.mockRejectedValueOnce(ambiguous);

    const result = await settlePending(2000);
    expect(result.stillPending).toBe(1);
    const entries = await listSettlements();
    expect(entries.find(e => e.id.startsWith(card.pubkey))?.status).toBe(
      'submitting',
    );
  });

  it('a needs-card payment is not submitted: it has no witness yet', async () => {
    const card = cardWithPieces([8], {
      loseSignAnswer: () => true,
      loseAgain: () => true,
    });
    await spendAll(paymentArgs(card, [0], 8));
    const result = await settlePending(2000);
    expect(result.settled).toBe(0);
    expect(mockAdapter.swap).not.toHaveBeenCalled();
  });
});

it('refuses reused merchant output secrets before a second card can sign', async () => {
  const first = cardWithPieces([8]);
  const args = paymentArgs(first, [0], 8);
  await spendAll(args);
  const second = cardWithPieces([8], {privateKey: '33'.repeat(32)});
  await expect(
    spendAll(paymentArgs(second, [0], 8, {merchant: args.merchant})),
  ).rejects.toThrow('already been used');
  expect(second.burnCount).toBe(0);
  expect(second.insSent).not.toContain(0x24);
});
