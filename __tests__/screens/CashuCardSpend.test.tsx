/**
 * CashuCardSpend's needs-card recovery (dev screen, production settlement
 * queue). SPEND_ALL_AGAIN's answer decides the fate of every `needs-card`
 * entry of the key it is asked for: one that does not verify marks them
 * `failed`. GET_PUBKEY is a claim any card (or an HCE emulator) can make, so
 * the screen must have the card prove the key with AUTH before anything of
 * that key's is touched (ENG-674).
 *
 * The queue is the real one over a mocked keychain; the cards are the 2.0
 * card model (`__tests__/support/cardProtocol2.ts`).
 */
import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import {randomBytes} from '@noble/hashes/utils';

import CashuCardSpend from '../../src/screens/CashuCardSpend';
import {type Transceiver} from '../../src/services/cashuCard';
import {prepareChargeOutputs} from '../../src/services/cashuMint';
import {spendAll} from '../../src/services/cashuSpend';
import {clearQueue, listSettlements} from '../../src/services/cashuSettlement';
import {
  FakeCard2,
  KEYSET_ID,
  MINT_URL,
  cardWithPieces,
  resetTestMint,
  type TestMint,
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

/** Whatever is on the antenna when the screen opens its NFC session. */
const mockAntenna: {transceive: Transceiver | null} = {transceive: null};

jest.mock('../../src/services/cashuCardNfc', () => ({
  cancelCardSession: jest.fn(),
  isCardReadingSupported: jest.fn(async () => true),
  withCardSession: (fn: (t: Transceiver) => Promise<unknown>) =>
    fn(mockAntenna.transceive!),
  describeCardFailure: jest.requireActual('../../src/services/cashuCardNfc')
    .describeCardFailure,
  isUserCancel: jest.requireActual('../../src/services/cashuCardNfc')
    .isUserCancel,
}));

jest.mock('../../src/store/hooks', () => ({
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({user: {username: ''}}),
}));

const mockToastShow = jest.fn();
jest.mock('../../src/utils/toast', () => ({
  toastShow: (...args: unknown[]) => mockToastShow(...args),
}));

jest.mock('../../src/services/cashuAutoSettle', () => ({
  runAutoSettlement: jest.fn(),
}));

const RECOVER = 'Recover needs-card settlements (this card)';

let mint: TestMint;

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  mint = resetTestMint();
  mockAntenna.transceive = null;
  await clearQueue();
});

/**
 * A payment `card` burned whose signature was lost, SIGN's answer and the
 * AGAIN that followed it both: a `needs-card` entry in the queue.
 */
async function needsCardPayment(card: FakeCard2) {
  const s = card.slots[0]!;
  const {entry} = await spendAll({
    transceive: card.transceive,
    inputs: [
      {
        slot: 0,
        nonce: s.nonce,
        secret: mint.mintPiece(card.pubkey, s.amount, {nonce: s.nonce}).secret,
        C: s.C,
        amount: s.amount,
        keysetId: KEYSET_ID,
      },
    ],
    merchant: prepareChargeOutputs({keysetId: KEYSET_ID, merchantSat: 8}),
    changeSat: 0,
    changeKeysetId: KEYSET_ID,
    cardPubkey: card.pubkey,
    mintUrl: MINT_URL,
    now: 1_790_000_000_000,
  });
  expect(entry.status).toBe('needs-card');
  return entry;
}

async function pressRecover() {
  const utils = render(<CashuCardSpend />);
  await act(async () => {});
  await act(async () => {
    fireEvent.press(utils.getByText(RECOVER));
  });
  await act(async () => {});
  return utils;
}

describe('CashuCardSpend needs-card recovery', () => {
  it("a card that claims another card's key and fails AUTH leaves that card's needs-card entries untouched, and is never asked SPEND_ALL_AGAIN", async () => {
    const victim = cardWithPieces([8], {
      loseSignAnswer: () => true,
      loseAgain: () => true,
    });
    const entry = await needsCardPayment(victim);

    // An emulator: GET_PUBKEY answers the victim's key (any card can), AGAIN
    // answers 64 bytes of its choosing, everything else is a card of its own
    // (whose AUTH signs under its own key, not the victim's).
    const own = cardWithPieces([4], {privateKey: '33'.repeat(32)});
    expect(own.pubkey).not.toBe(victim.pubkey);
    const insSent: number[] = [];
    mockAntenna.transceive = async apdu => {
      insSent.push(apdu[1]);
      if (apdu[1] === 0x10) {
        return [...Array.from(Buffer.from(victim.pubkey, 'hex')), 0x90, 0x00];
      }
      if (apdu[1] === 0x25) {
        return [...Array.from(randomBytes(64)), 0x90, 0x00];
      }
      return own.transceive(apdu);
    };

    const {findByText} = await pressRecover();

    const stored = await listSettlements();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({id: entry.id, status: 'needs-card'});
    expect(stored[0].witness).toBeUndefined();
    expect(stored[0].lastError).toBeUndefined();
    expect(insSent).toContain(0x15);
    expect(insSent).not.toContain(0x25);
    expect(await findByText(/could not prove it holds its key/)).toBeTruthy();
  });

  it('the card itself proves its key and recovers its lost signature: the entry is pending', async () => {
    let lose = true;
    const card = cardWithPieces([8], {
      loseSignAnswer: () => true,
      loseAgain: () => lose,
    });
    const entry = await needsCardPayment(card);
    lose = false;
    mockAntenna.transceive = card.transceive;

    await pressRecover();

    expect(card.insSent).toContain(0x15);
    const [stored] = await listSettlements();
    expect(stored).toMatchObject({id: entry.id, status: 'pending'});
    expect(mockToastShow).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'eCash: recovered 1 of 1 settlement(s)',
      }),
    );
  });
});
