/**
 * cashuMint — the settlement adapter's contract with drainQueue.
 *
 * cashu-ts is mocked at the Wallet class boundary (it ships its own test
 * suite); everything this module adds is exercised for real: the byte-exact
 * P2PK secret serialization, a witness signed the way the card signs
 * (sha256(utf8(secret)), via cashu-ts's own schnorr wrapper), the
 * isP2PKSpendAuthorised verdict, the error mapping onto drainQueue's three
 * classes, and the persistence ordering around the swap call — the pending
 * preview must be on disk *before* completeSwap fires, because after the mint
 * accepts, that preview's blinding data is the only way to unblind the
 * response.
 */
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';

import {sha256} from '@noble/hashes/sha256';
import {utf8ToBytes} from '@noble/hashes/utils';

import {
  __resetReconcileThrottle,
  __resetWalletCache,
  buildCardP2PKSecret,
  buildCardSigAllSecret,
  cachedKeysets,
  createSettlementAdapter,
  expandKeysetId,
  finishCardChange,
  inputFee,
  isRateLimited,
  keysetFor,
  listSettledProofs,
  meltSettledProofs,
  mintReachable,
  prepareChargeOutputs,
  RECONCILE_MIN_INTERVAL_MS,
  reconcileTill,
  refreshKeysets,
  saveKeysets,
  sigAllMessage,
  swapSigned,
  sweepSettledProofs,
  UnknownKeysetError,
  verifyCardSignature,
  verifyPieceDleq,
} from '../../src/services/cashuMint';
import * as mintModule from '../../src/services/cashuMint';
import {
  listOwedChange,
  OWED_CHANGE_KEY,
  PermanentSettlementError,
  ProofAlreadySpentError,
  TransportSettlementError,
  type SettlementEntry,
} from '../../src/services/cashuSettlement';
import {
  FakeCard2,
  REFUND_KEY,
  TestMint,
  cardSecretText,
  pieceNonce,
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

type WalletMocks = {
  loadMint: jest.Mock;
  mintSwap: jest.Mock;
  getKeysets: jest.Mock;
  ensureKeysetKeys: jest.Mock;
  prepareSwapToSend: jest.Mock;
  completeSwap: jest.Mock;
  checkProofsStates: jest.Mock;
  serializeSwapPreview: jest.Mock;
  createMeltQuoteBolt11: jest.Mock;
  meltProofsBolt11: jest.Mock;
};

jest.mock('@cashu/cashu-ts', () => {
  const actual = jest.requireActual('@cashu/cashu-ts');
  const mocks: WalletMocks = {
    loadMint: jest.fn(),
    mintSwap: jest.fn(),
    getKeysets: jest.fn(() => []),
    ensureKeysetKeys: jest.fn(async () => undefined),
    prepareSwapToSend: jest.fn(),
    completeSwap: jest.fn(),
    checkProofsStates: jest.fn(),
    serializeSwapPreview: jest.fn(() => 'serialized-preview'),
    createMeltQuoteBolt11: jest.fn(),
    meltProofsBolt11: jest.fn(),
  };
  class MockWallet {
    loadMint = mocks.loadMint;
    mint = {swap: mocks.mintSwap};
    keyChain = {
      getKeysets: mocks.getKeysets,
      ensureKeysetKeys: mocks.ensureKeysetKeys,
    };
    prepareSwapToSend = mocks.prepareSwapToSend;
    completeSwap = mocks.completeSwap;
    checkProofsStates = mocks.checkProofsStates;
    createMeltQuoteBolt11 = mocks.createMeltQuoteBolt11;
    meltProofsBolt11 = mocks.meltProofsBolt11;
  }
  return {
    ...actual,
    Wallet: MockWallet,
    __walletMocks: mocks,
    // The real serializer walks the whole SwapPreview (Amounts, keysets); the
    // tests only need a stable, observable pending record.
    serializeSwapPreview: mocks.serializeSwapPreview,
  };
});

const cashu = jest.requireActual('@cashu/cashu-ts');
const walletMocks = (
  jest.requireMock('@cashu/cashu-ts') as {
    __walletMocks: WalletMocks;
  }
).__walletMocks;

// Real values from the silicon run (see HARDWARE_TEST_REPORT_2026-09-22): the
// fixture pins the secret serialization against a proof the actual toolchain
// minted, so a formatting drift here fails loudly instead of at the mint.
const CARD_PUBKEY =
  '03858498d50d2545aec9233357a69ef6d03c25b885921f47d7504c18161025574d';
const NONCE =
  '12a121736d3975fd4aefa5fda969e84b2023235d78962c17db23d2ea87d375ef';
const KEYSET_ID = '0059534ce0bfa19a';
const MINT_URL = 'https://forge.flashapp.me';

// The real card's key lives on the card — a test cannot sign for it. The
// spend fixtures therefore use a synthetic card key whose private half we
// hold, so the witness is a genuinely verifiable signature rather than a
// decoration the authorization check would wave through.
const TEST_CARD_PRIV = hexToBytes('11'.repeat(32));
const TEST_CARD_PUBKEY = bytesToHex(
  (cashu as typeof import('@cashu/cashu-ts')).getPubKeyFromPrivKey(
    TEST_CARD_PRIV,
  ),
);

const SECRET = buildCardP2PKSecret(NONCE, TEST_CARD_PUBKEY);

/** A throwaway signer, the way the card would: schnorr over sha256(utf8(secret)). */
function signSecret(signerPriv: Uint8Array): string {
  return (cashu as typeof import('@cashu/cashu-ts')).schnorrSignMessage(
    SECRET,
    signerPriv,
  );
}

function entryWith(overrides: Partial<SettlementEntry> = {}): SettlementEntry {
  return {
    id: `${TEST_CARD_PUBKEY}:0:${NONCE}`,
    cardPubkey: TEST_CARD_PUBKEY,
    slot: 0,
    keysetId: KEYSET_ID,
    mintUrl: MINT_URL,
    unit: 'sat',
    amount: 16,
    nonce: NONCE,
    secret: SECRET,
    // C must be a valid point; the card key itself is one.
    C: TEST_CARD_PUBKEY,
    witness: signSecret(TEST_CARD_PRIV),
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    attempts: 0,
    sigflag: 'SIG_INPUTS',
    inputs: [
      {
        slot: 0,
        nonce: NONCE,
        secret: SECRET,
        C: TEST_CARD_PUBKEY,
        amount: 16,
        keysetId: KEYSET_ID,
      },
    ],
    outputs: [],
    merchantBlinding: [],
    ...overrides,
  };
}

const PREVIEW = {fees: 0, keepOutputs: [], sendOutputs: [], inputs: []};
const SETTLED = [
  {
    id: KEYSET_ID,
    amount: 16,
    secret: 'new-secret',
    C: TEST_CARD_PUBKEY,
    mintUrl: MINT_URL,
  },
];

// Leave the microtask machinery real: faking it stalls promise chains
// under Node 22 (the CI runtime).
const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetWalletCache();
  __resetReconcileThrottle();
  for (const k of Object.keys(mockStore)) {
    delete mockStore[k];
  }
  walletMocks.loadMint.mockResolvedValue(undefined);
  walletMocks.prepareSwapToSend.mockResolvedValue(PREVIEW);
  walletMocks.completeSwap.mockResolvedValue({keep: SETTLED, send: []});
  walletMocks.checkProofsStates.mockResolvedValue([
    {state: cashu.CheckStateEnum.UNSPENT},
  ]);
});

describe('buildCardP2PKSecret', () => {
  it('reproduces the mint-time serialization byte for byte', () => {
    // NONCE + CARD_PUBKEY are the values the real toolchain minted on silicon.
    expect(buildCardP2PKSecret(NONCE, CARD_PUBKEY)).toBe(
      '["P2PK",{"nonce":"' +
        NONCE +
        '","data":"' +
        CARD_PUBKEY +
        '","tags":[["sigflag","SIG_INPUTS"]]}]',
    );
  });

  it('lower-cases whatever the card reports', () => {
    const s = buildCardP2PKSecret(
      NONCE.toUpperCase(),
      CARD_PUBKEY.toUpperCase(),
    );
    expect(s).toBe(buildCardP2PKSecret(NONCE, CARD_PUBKEY));
  });
});

// Decision 13: only the card's own change path remains for new charges. A
// terminal-made change output (0.x's SIG_INPUTS piece) on a 2.0 card would be
// a piece the card can never spend — it rebuilds every secret as format 4.
describe('terminal-made card change is gone (decision 13)', () => {
  it('exports no makeCanonicalCardOutput, makeChangeOnTill or mintChargeChange', () => {
    const mod = mintModule as Record<string, unknown>;
    expect(mod.makeCanonicalCardOutput).toBeUndefined();
    expect(mod.makeChangeOnTill).toBeUndefined();
    expect(mod.mintChargeChange).toBeUndefined();
  });

  // ENG-696: in 2.0 the card makes its own change, so the till keeps no
  // float and nothing maintains one.
  it('exports no till change-maker or float maintainer', () => {
    const mod = mintModule as Record<string, unknown>;
    expect(mod.selectChangeFromTill).toBeUndefined();
    expect(mod.rebalanceTill).toBeUndefined();
  });
});

describe('swap', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('settles: verifies the witness, persists the preview before the call, then the proofs', async () => {
    const adapter = createSettlementAdapter();
    let pendingDuringCall: string | null = null;
    walletMocks.completeSwap.mockImplementation(async () => {
      pendingDuringCall =
        mockStore[`@cashu_settlement_swap:${entryWith().id}`] ?? null;
      // Exact-cover shape: send carries the full amount, keep is empty —
      // the shape a real mint returns for this swap (regression: the
      // adapter used to persist only `keep` and book the payment as nothing).
      return {keep: [], send: SETTLED};
    });

    await adapter.swap(entryWith());

    expect(walletMocks.prepareSwapToSend).toHaveBeenCalledWith(
      16,
      [expect.objectContaining({secret: SECRET, witness: expect.any(String)})],
      {includeFees: true},
    );
    expect(pendingDuringCall).toBe(JSON.stringify('serialized-preview'));
    expect(
      mockStore['@cashu_settlement_swap:' + entryWith().id],
    ).toBeUndefined();
    await expect(listSettledProofs()).resolves.toEqual(SETTLED);
  });

  it('refuses an unauthorised witness before any network call', async () => {
    const adapter = createSettlementAdapter();
    const wrongSigner = entryWith({
      witness: signSecret(hexToBytes('22'.repeat(32))),
    });

    await expect(adapter.swap(wrongSigner)).rejects.toBeInstanceOf(
      PermanentSettlementError,
    );
    expect(walletMocks.prepareSwapToSend).not.toHaveBeenCalled();
    await expect(listSettledProofs()).resolves.toEqual([]);
  });

  it('maps the mint 11001 to ProofAlreadySpentError', async () => {
    const adapter = createSettlementAdapter();
    walletMocks.prepareSwapToSend.mockResolvedValue(PREVIEW);
    walletMocks.completeSwap.mockRejectedValue(
      new (cashu as typeof import('@cashu/cashu-ts')).MintOperationError(
        11001,
        'Token already spent',
      ),
    );

    await expect(adapter.swap(entryWith())).rejects.toBeInstanceOf(
      ProofAlreadySpentError,
    );
  });

  it('maps other mint operation errors to PermanentSettlementError', async () => {
    const adapter = createSettlementAdapter();
    walletMocks.completeSwap.mockRejectedValue(
      new (cashu as typeof import('@cashu/cashu-ts')).MintOperationError(
        11002,
        'Token pending',
      ),
    );

    await expect(adapter.swap(entryWith())).rejects.toBeInstanceOf(
      PermanentSettlementError,
    );
    await expect(adapter.swap(entryWith())).rejects.not.toBeInstanceOf(
      ProofAlreadySpentError,
    );
  });

  it('retries the swap once after retryAfterMs when the mint answers 429', async () => {
    // The settlement path goes through withRateLimitRetry: a throttle
    // mid-burst is re-sent after the mint's own retryAfterMs, not parked as
    // a permanent failure.
    jest.useFakeTimers(FAKE_TIMERS);
    const adapter = createSettlementAdapter();
    walletMocks.completeSwap
      .mockRejectedValueOnce(
        new cashu.RateLimitError('429 Too Many Requests', 2500),
      )
      .mockResolvedValueOnce({keep: [], send: SETTLED});

    const pending = adapter.swap(entryWith());
    await jest.advanceTimersByTimeAsync(2499);
    expect(walletMocks.completeSwap).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeUndefined();
    expect(walletMocks.completeSwap).toHaveBeenCalledTimes(2);
    // The settled proofs landed and the pending preview was cleared.
    expect(
      mockStore['@cashu_settlement_swap:' + entryWith().id],
    ).toBeUndefined();
    await expect(listSettledProofs()).resolves.toEqual(SETTLED);
  });

  it('does not retry a mint operation error — that is the verdict, not a throttle', async () => {
    // Moved here from the retired rebalanceTill (ENG-696): the settlement
    // swap is withRateLimitRetry's caller now.
    const adapter = createSettlementAdapter();
    walletMocks.completeSwap.mockRejectedValue(
      new cashu.MintOperationError(11001, 'Token already spent'),
    );

    await expect(adapter.swap(entryWith())).rejects.toBeInstanceOf(
      ProofAlreadySpentError,
    );
    expect(walletMocks.completeSwap).toHaveBeenCalledTimes(1);
  });

  it('passes a 5xx through unchanged — the outcome is unknown, not failed', async () => {
    const adapter = createSettlementAdapter();
    const boom = Object.assign(new Error('bad gateway'), {status: 502});
    walletMocks.completeSwap.mockRejectedValue(boom);

    await expect(adapter.swap(entryWith())).rejects.toBe(boom);
  });

  it('maps a fetch-level network failure to TransportSettlementError', async () => {
    const adapter = createSettlementAdapter();
    walletMocks.completeSwap.mockRejectedValue(
      new TypeError('Network request failed'),
    );

    await expect(adapter.swap(entryWith())).rejects.toBeInstanceOf(
      TransportSettlementError,
    );
  });

  it('a failed loadMint is retried on the next swap, not cached forever', async () => {
    // Regression: the wallet promise used to be cached even when rejected, so
    // one rate-limited loadMint poisoned every later drain — the entry sat
    // "pending" across retries while the adapter never reached the network.
    const adapter = createSettlementAdapter();
    walletMocks.loadMint.mockRejectedValueOnce(new Error('mint rate-limited'));

    await expect(adapter.swap(entryWith())).rejects.toThrow(
      'mint rate-limited',
    );
    await adapter.swap(entryWith());

    expect(walletMocks.loadMint).toHaveBeenCalledTimes(2);
    expect(walletMocks.prepareSwapToSend).toHaveBeenCalledTimes(1);
  });

  it('a post-swap persistence failure leaves the pending preview recoverable', async () => {
    const adapter = createSettlementAdapter();
    // Simulate the keychain failing on the settled-proofs write: the settled
    // append is the call after completeSwap, so fail every subsequent write.
    const secureStorage = jest.requireMock('../../src/services/secureStorage');
    walletMocks.completeSwap.mockImplementationOnce(async () => ({
      keep: SETTLED,
      send: [],
    }));
    // The first write in the flow is the pending preview (must succeed); the
    // second is the settled proofs — fail that one.
    let secureWrites = 0;
    secureStorage.setSecure.mockImplementation(async (k: string, v: string) => {
      secureWrites += 1;
      if (secureWrites === 2) {
        throw new Error('keychain write denied');
      }
      mockStore[k] = v;
    });

    await expect(adapter.swap(entryWith())).rejects.toThrow(
      'keychain write denied',
    );
    expect(mockStore[`@cashu_settlement_swap:${entryWith().id}`]).toBeDefined();
    await expect(listSettledProofs()).resolves.toEqual([]);
  });
});

describe('checkState', () => {
  it.each([
    ['SPENT', 'spent'],
    ['UNSPENT', 'unspent'],
    ['PENDING', 'unknown'],
  ])('maps %s to %s', async (mintState, expected) => {
    const adapter = createSettlementAdapter();
    walletMocks.checkProofsStates.mockResolvedValue([{state: mintState}]);
    await expect(adapter.checkState(entryWith())).resolves.toBe(expected);
  });

  it('asks the mint about the secret on the entry', async () => {
    const adapter = createSettlementAdapter();
    await adapter.checkState(entryWith());
    expect(walletMocks.checkProofsStates).toHaveBeenCalledWith([
      {id: KEYSET_ID, secret: SECRET},
    ]);
  });
});

describe('listSettledProofs', () => {
  it('an empty store is empty, not an error', async () => {
    await expect(listSettledProofs()).resolves.toEqual([]);
  });
});

describe('meltSettledProofs', () => {
  const settled = [
    {
      id: KEYSET_ID,
      amount: 16,
      secret: 'settled-secret',
      C: TEST_CARD_PUBKEY,
      mintUrl: MINT_URL,
    },
  ];
  const meltQuote = {
    quote: 'payout-q1',
    amount: 16,
    fee_reserve: 0,
    unit: 'sat',
    state: 'UNPAID',
    request: 'lnbc-invoice',
    payment_preimage: null,
  };

  beforeEach(() => {
    mockStore['@cashu_settled_proofs'] = JSON.stringify(settled);
    walletMocks.createMeltQuoteBolt11.mockResolvedValue(meltQuote);
    walletMocks.meltProofsBolt11.mockImplementation(async () => ({
      quote: {...meltQuote, state: 'PAID', payment_preimage: 'preimage-1'},
      change: [
        {
          id: KEYSET_ID,
          amount: 1,
          secret: 'change-secret',
          C: TEST_CARD_PUBKEY,
        },
      ],
    }));
  });

  it('resolves a lightning address and pays it out', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag: 'payRequest',
          minSendable: '1000',
          maxSendable: '100000000',
          callback: 'https://wallet.example/lnurlp/scan',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({pr: 'lnbc160n1invoice'}),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await meltSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
    });

    // address → lnurl meta → callback invoice → quote
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://wallet.example/.well-known/lnurlp/merchant',
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://wallet.example/lnurlp/scan?amount=16000',
    );
    expect(walletMocks.createMeltQuoteBolt11).toHaveBeenCalledWith(
      expect.stringContaining('invoice'),
    );
    expect(result).toMatchObject({
      paidSat: 16,
      feeReserveSat: 0,
      preimage: 'preimage-1',
    });

    // the melted proofs left the store, the change entered it
    const store = JSON.parse(mockStore['@cashu_settled_proofs']);
    expect(store).toHaveLength(1);
    expect(store[0].secret).toBe('change-secret');
    expect(
      mockStore['@cashu_settled_payout:@q1'.replace('@q1', 'payout-q1')],
    ).toBeUndefined();
  });

  it('rejects a pasted invoice whose reserve overruns the balance', async () => {
    walletMocks.createMeltQuoteBolt11.mockResolvedValue({
      ...meltQuote,
      fee_reserve: 2,
    });

    await expect(
      meltSettledProofs({mintUrl: MINT_URL, bolt11: 'lnbc-invoice'}),
    ).rejects.toThrow(/fee reserve.*16 sat/);
    const store = JSON.parse(mockStore['@cashu_settled_proofs']);
    expect(store).toHaveLength(1);
  });

  it('re-requests a smaller invoice when an address would overrun', async () => {
    // First quote: 16 sat invoice + 2 sat reserve = 18 > 16. The address
    // path re-asks for 14 sat; 14 + 2 = 16 fits exactly.
    walletMocks.createMeltQuoteBolt11
      .mockResolvedValueOnce({...meltQuote, fee_reserve: 2})
      .mockResolvedValueOnce({...meltQuote, amount: 14, fee_reserve: 2});
    global.fetch = jest.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('.well-known/lnurlp')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag: 'payRequest',
            minSendable: '1000',
            maxSendable: '100000000',
            callback: 'https://wallet.example/lnurlp/scan',
          }),
        };
      }
      const amount = new URL(u).searchParams.get('amount');
      return {
        ok: true,
        status: 200,
        json: async () => ({pr: `lnbc-${amount}-invoice`}),
      };
    }) as unknown as typeof fetch;

    const result = await meltSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
    });
    expect(result.paidSat).toBe(14);
    expect(walletMocks.createMeltQuoteBolt11).toHaveBeenLastCalledWith(
      expect.stringContaining('14000'),
    );
  });

  it('keeps the proofs and the melt intent when the quote does not settle', async () => {
    walletMocks.meltProofsBolt11.mockImplementation(async () => ({
      quote: {...meltQuote, state: 'PENDING'},
      change: [],
    }));

    await expect(
      meltSettledProofs({mintUrl: MINT_URL, bolt11: 'lnbc-invoice'}),
    ).rejects.toThrow('did not settle');
    const store = JSON.parse(mockStore['@cashu_settled_proofs']);
    expect(store[0].secret).toBe('settled-secret');
    expect(
      Object.keys(mockStore).some(k => k.startsWith('@cashu_settled_payout')),
    ).toBe(true);
  });

  it('an explicit proofs subset melts only that subset (ENG-696)', async () => {
    const a = {...settled[0], secret: 'subset-a'};
    const b = {...settled[0], secret: 'subset-b'};
    mockStore['@cashu_settled_proofs'] = JSON.stringify([a, b]);

    const result = await meltSettledProofs({
      mintUrl: MINT_URL,
      bolt11: 'lnbc-invoice',
      proofs: [a],
    });

    expect(result.paidSat).toBe(16);
    expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
    expect(walletMocks.meltProofsBolt11.mock.calls[0][1]).toEqual([a]);
    // The proof outside the subset stays; the melted one leaves; the change
    // joins.
    const store = JSON.parse(mockStore['@cashu_settled_proofs']) as {
      secret: string;
    }[];
    expect(store.map(p => p.secret)).toEqual(['subset-b', 'change-secret']);
  });
});

// ENG-626: a till under the sweep reserve asked the mint checkstate every
// 20 s (one 146-byte POST, one 429 each) for as long as the app was in the
// foreground, because sweepSettledProofs reconciled before it looked at the
// total and reconcileTill swallowed the 429 — so the run read as clean and
// the scheduler never backed off.
describe('isRateLimited', () => {
  it('recognises what cashu-ts throws for a 429', () => {
    expect(
      isRateLimited(new cashu.RateLimitError('Too Many Requests', 2500)),
    ).toBe(true);
    expect(isRateLimited(new cashu.HttpResponseError('throttled', 429))).toBe(
      true,
    );
  });

  it('recognises a bare status or a message naming the throttle', () => {
    expect(isRateLimited({status: 429})).toBe(true);
    expect(isRateLimited(new Error('HTTP 429'))).toBe(true);
    expect(
      isRateLimited(
        new Error('lightning address m@w: lookup failed (HTTP 429)'),
      ),
    ).toBe(true);
    expect(isRateLimited(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimited(new Error('Too Many Requests'))).toBe(true);
  });

  it('is not every other failure', () => {
    expect(isRateLimited(new cashu.HttpResponseError('boom', 500))).toBe(false);
    expect(
      isRateLimited(new cashu.MintOperationError(11001, 'Token already spent')),
    ).toBe(false);
    expect(isRateLimited(new TypeError('Network request failed'))).toBe(false);
    expect(isRateLimited(new Error('amount 14290 too large'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });

  it('a 429 that is an amount is a payout failure, not a throttle', () => {
    // The sweep's own errors carry sat amounts in free text; a till of 429
    // sat must not read as "the mint said slow down" (toast suppressed,
    // banner blaming the mint, scheduler backing off with nobody told).
    expect(
      isRateLimited(
        new Error('payout needs 429 sat but the settled balance is 400 sat'),
      ),
    ).toBe(false);
    expect(
      isRateLimited(
        new Error(
          'lightning address m@w accepts 1–429 sat; the settled balance is 429 sat',
        ),
      ),
    ).toBe(false);
    expect(isRateLimited('429')).toBe(false);
  });
});

describe('sweepSettledProofs', () => {
  const tillProof = (amount: number, secret: string) => ({
    id: KEYSET_ID,
    amount,
    secret,
    C: TEST_CARD_PUBKEY,
    mintUrl: MINT_URL,
  });

  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it('a till under the minimum sweep makes no mint call at all (ENG-626)', async () => {
    // 9 sat against the production minimum of 10, with no reserve: the run
    // answers from the store alone, as ENG-626 requires.
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'small-a'),
      tillProof(1, 'small-b'),
    ]);

    const result = await sweepSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
      keepReserveSat: 0,
      minSweepSat: 10,
    });

    expect(result).toEqual({
      paidSat: 0,
      feeReserveSat: 0,
      preimage: null,
      change: [],
    });
    expect(walletMocks.checkProofsStates).not.toHaveBeenCalled();
    expect(walletMocks.createMeltQuoteBolt11).not.toHaveBeenCalled();
    expect(walletMocks.meltProofsBolt11).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // The till is untouched.
    await expect(listSettledProofs()).resolves.toHaveLength(2);
  });

  it('a till that reaches the minimum sweeps all of it (ENG-696)', async () => {
    // The boundary pair: 9 sat stays put, one more sat sweeps all 10.
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'min-a'),
      tillProof(1, 'min-b'),
    ]);
    const quote = {
      quote: 'min-q1',
      amount: 10,
      fee_reserve: 0,
      unit: 'sat',
      state: 'UNPAID',
      request: 'lnbc-invoice',
      payment_preimage: null,
    };
    walletMocks.createMeltQuoteBolt11.mockResolvedValue(quote);
    walletMocks.meltProofsBolt11.mockImplementation(async q => ({
      quote: {...q, state: 'PAID', payment_preimage: 'preimage-1'},
      change: [],
    }));
    walletMocks.checkProofsStates.mockResolvedValue([
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
    ]);
    const args = {
      mintUrl: MINT_URL,
      bolt11: 'lnbc-invoice',
      keepReserveSat: 0,
      minSweepSat: 10,
    };

    await expect(sweepSettledProofs(args)).resolves.toMatchObject({
      paidSat: 0,
    });
    expect(walletMocks.meltProofsBolt11).not.toHaveBeenCalled();

    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'min-a'),
      tillProof(1, 'min-b'),
      tillProof(1, 'min-c'),
    ]);
    const result = await sweepSettledProofs(args);

    expect(result.paidSat).toBe(10);
    expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
    expect(
      (walletMocks.meltProofsBolt11.mock.calls[0][1] as {secret: string}[])
        .map(p => p.secret)
        .sort(),
    ).toEqual(['min-a', 'min-b', 'min-c']);
    await expect(listSettledProofs()).resolves.toEqual([]);
  });

  it('melts exactly the selected set and leaves no spent proof in the store (ENG-696)', async () => {
    // A reserve of 16 against a 20-sat till: the target is 4, so the
    // largest-first selection is one 8, not the whole till.
    const p8 = tillProof(8, 'p8');
    const p8b = tillProof(8, 'p8b');
    const p4 = tillProof(4, 'p4');
    mockStore['@cashu_settled_proofs'] = JSON.stringify([p8, p8b, p4]);
    walletMocks.checkProofsStates.mockResolvedValue([
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
    ]);
    walletMocks.createMeltQuoteBolt11.mockResolvedValue({
      quote: 'sel-q1',
      amount: 8,
      fee_reserve: 0,
      unit: 'sat',
      state: 'UNPAID',
      request: 'lnbc-invoice',
      payment_preimage: null,
    });
    walletMocks.meltProofsBolt11.mockImplementation(async q => ({
      quote: {...q, state: 'PAID', payment_preimage: 'preimage-1'},
      change: [],
    }));

    const result = await sweepSettledProofs({
      mintUrl: MINT_URL,
      bolt11: 'lnbc-invoice',
      keepReserveSat: 16,
    });

    expect(result.paidSat).toBe(8);
    expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
    const melted = walletMocks.meltProofsBolt11.mock.calls[0][1] as {
      secret: string;
    }[];
    expect(melted).toEqual([p8]);
    const store = await listSettledProofs();
    expect(store).toEqual([p8b, p4]);
    // Nothing the mint consumed is still listed as money in the till.
    const storeSecrets = new Set(store.map(p => p.secret));
    expect(melted.filter(p => storeSecrets.has(p.secret))).toEqual([]);
  });

  it('the lightning-address invoice is sized from what is melted (ENG-696)', async () => {
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'p8'),
      tillProof(8, 'p8b'),
      tillProof(4, 'p4'),
    ]);
    walletMocks.checkProofsStates.mockResolvedValue([
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
    ]);
    walletMocks.createMeltQuoteBolt11.mockResolvedValue({
      quote: 'sel-q2',
      amount: 8,
      fee_reserve: 0,
      unit: 'sat',
      state: 'UNPAID',
      request: 'lnbc-invoice',
      payment_preimage: null,
    });
    walletMocks.meltProofsBolt11.mockImplementation(async q => ({
      quote: {...q, state: 'PAID', payment_preimage: 'preimage-1'},
      change: [],
    }));
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          tag: 'payRequest',
          minSendable: '1000',
          maxSendable: '100000000',
          callback: 'https://wallet.example/lnurlp/scan',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({pr: 'lnbc80n1invoice'}),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    await sweepSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
      keepReserveSat: 16,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://wallet.example/lnurlp/scan?amount=8000',
    );
  });

  it('a lightning-address sweep keeps exactly the fee-reserve change in the till (ENG-696)', async () => {
    // Production config. A 10-sat till against a 2-sat minimum reserve: the
    // invoice is sized at 10 - 2 = 8, the route costs nothing, and the mint
    // hands the unused 2 back as change. That change is the whole till
    // afterwards: nothing melted stays listed, nothing else appears.
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'ln-a'),
      tillProof(2, 'ln-b'),
    ]);
    walletMocks.checkProofsStates.mockResolvedValue([
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.UNSPENT},
    ]);
    const quoteFor = (amount: number) => ({
      quote: `ln-q${amount}`,
      amount,
      fee_reserve: 2,
      unit: 'sat',
      state: 'UNPAID',
      request: `lnbc-${amount}`,
      payment_preimage: null,
    });
    walletMocks.createMeltQuoteBolt11.mockImplementation(async (req: string) =>
      quoteFor(Number(req.replace('lnbc-', ''))),
    );
    const changeProof = {
      id: KEYSET_ID,
      amount: 2,
      secret: 'fee-change',
      C: TEST_CARD_PUBKEY,
    };
    walletMocks.meltProofsBolt11.mockImplementation(async q => ({
      quote: {...q, state: 'PAID', payment_preimage: 'preimage-1'},
      change: [changeProof],
    }));
    const fetchMock = jest.fn(async (url: string) => {
      if (url.includes('/.well-known/lnurlp/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag: 'payRequest',
            minSendable: '1000',
            maxSendable: '100000000',
            callback: 'https://wallet.example/lnurlp/cb',
          }),
        };
      }
      const msat = Number(new URL(url).searchParams.get('amount'));
      return {
        ok: true,
        status: 200,
        json: async () => ({pr: `lnbc-${msat / 1000}`}),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await sweepSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
      keepReserveSat: 0,
      minSweepSat: 10,
    });

    expect(result.paidSat).toBe(8);
    expect(result.feeReserveSat).toBe(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://wallet.example/lnurlp/cb?amount=8000',
    );
    expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
    await expect(listSettledProofs()).resolves.toEqual([
      {...changeProof, mintUrl: MINT_URL},
    ]);
  });

  it('a till at or under the reserve parameter makes no mint call either', async () => {
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(8, 'float-a'),
      tillProof(4, 'float-b'),
    ]);

    const result = await sweepSettledProofs({
      mintUrl: MINT_URL,
      lightningAddress: 'merchant@wallet.example',
      keepReserveSat: 16,
    });

    expect(result).toEqual({
      paidSat: 0,
      feeReserveSat: 0,
      preimage: null,
      change: [],
    });
    expect(walletMocks.checkProofsStates).not.toHaveBeenCalled();
    expect(walletMocks.createMeltQuoteBolt11).not.toHaveBeenCalled();
    expect(walletMocks.meltProofsBolt11).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(listSettledProofs()).resolves.toHaveLength(2);
  });

  it('a 429 from the reconcile propagates instead of reading as a clean run', async () => {
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(16, 'big-a'),
      tillProof(16, 'big-b'),
    ]);
    walletMocks.checkProofsStates.mockRejectedValue(
      new cashu.RateLimitError('Too Many Requests', 2500),
    );

    await expect(
      sweepSettledProofs({
        mintUrl: MINT_URL,
        lightningAddress: 'merchant@wallet.example',
        keepReserveSat: 16,
      }),
    ).rejects.toBeInstanceOf(cashu.RateLimitError);

    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);
    expect(walletMocks.createMeltQuoteBolt11).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // Nothing left the till on a throttle.
    await expect(listSettledProofs()).resolves.toHaveLength(2);
  });

  describe('a listing that went stale inside the reconcile window', () => {
    const T0 = 1_700_000_000_000;
    const meltQuote = {
      quote: 'sweep-q1',
      amount: 16,
      fee_reserve: 0,
      unit: 'sat',
      state: 'UNPAID',
      request: 'lnbc-invoice',
      payment_preimage: null,
    };
    const alreadySpent = () =>
      new cashu.MintOperationError(11001, 'Token already spent');

    beforeEach(async () => {
      // A clean reconcile stamps the window, then a melt response is lost:
      // the mint has consumed `gone`, the store still lists it.
      mockStore['@cashu_settled_proofs'] = JSON.stringify([
        tillProof(16, 'live-a'),
        tillProof(16, 'live-b'),
      ]);
      walletMocks.checkProofsStates.mockResolvedValue([
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);
      await reconcileTill(MINT_URL, {now: T0});
      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);
      // The stale listing sorts first among equals, so the first selection
      // (32 of the 48 listed, a 16-sat reserve kept) includes it.
      mockStore['@cashu_settled_proofs'] = JSON.stringify([
        tillProof(16, 'gone'),
        tillProof(16, 'live-a'),
        tillProof(16, 'live-b'),
      ]);
      walletMocks.createMeltQuoteBolt11.mockResolvedValue({
        ...meltQuote,
        amount: 32,
      });
      walletMocks.meltProofsBolt11.mockImplementation(async quote => ({
        quote: {...quote, state: 'PAID', payment_preimage: 'preimage-1'},
        change: [],
      }));
    });

    it('is healed by a forced reconcile and one silent retry, not left to the window (ENG-626)', async () => {
      walletMocks.meltProofsBolt11.mockRejectedValueOnce(alreadySpent());
      walletMocks.checkProofsStates.mockResolvedValueOnce([
        {state: cashu.CheckStateEnum.SPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);
      // The retry re-selects from the healed 32-sat store: 16 melts.
      walletMocks.createMeltQuoteBolt11
        .mockResolvedValueOnce({...meltQuote, amount: 32})
        .mockResolvedValueOnce({...meltQuote, amount: 16});

      const result = await sweepSettledProofs({
        mintUrl: MINT_URL,
        bolt11: 'lnbc-invoice',
        keepReserveSat: 16,
        now: T0 + 10_000,
      });

      // The mint was asked again despite the window, the stale listing left,
      // and the melt went through on the second try.
      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(2);
      expect(result.paidSat).toBe(16);
      expect(
        (
          walletMocks.meltProofsBolt11.mock.calls[1][1] as {secret: string}[]
        ).map(p => p.secret),
      ).toEqual(['live-a']);
      const store = JSON.parse(mockStore['@cashu_settled_proofs']) as {
        secret: string;
      }[];
      expect(store.map(p => p.secret)).not.toContain('gone');
      // The reserve the caller asked for stayed in the till.
      expect(store.map(p => p.secret)).toEqual(['live-b']);
    });

    it('heals under the production config and the retry melts the whole healed till (ENG-696)', async () => {
      // No reserve, minimum 10: the first melt takes all three listings, the
      // mint answers 11001 for the stale one, the forced reconcile drops it,
      // and the retry melts both survivors so the till ends empty.
      walletMocks.meltProofsBolt11.mockRejectedValueOnce(alreadySpent());
      walletMocks.checkProofsStates.mockResolvedValueOnce([
        {state: cashu.CheckStateEnum.SPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);
      walletMocks.createMeltQuoteBolt11
        .mockResolvedValueOnce({...meltQuote, amount: 48})
        .mockResolvedValueOnce({...meltQuote, amount: 32});

      const result = await sweepSettledProofs({
        mintUrl: MINT_URL,
        bolt11: 'lnbc-invoice',
        keepReserveSat: 0,
        minSweepSat: 10,
        now: T0 + 10_000,
      });

      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(2);
      expect(
        (
          walletMocks.meltProofsBolt11.mock.calls[0][1] as {secret: string}[]
        ).map(p => p.secret),
      ).toEqual(['gone', 'live-a', 'live-b']);
      expect(
        (
          walletMocks.meltProofsBolt11.mock.calls[1][1] as {secret: string}[]
        ).map(p => p.secret),
      ).toEqual(['live-a', 'live-b']);
      expect(result.paidSat).toBe(32);
      await expect(listSettledProofs()).resolves.toEqual([]);
    });

    it('gives up after one retry when the mint keeps saying spent', async () => {
      walletMocks.meltProofsBolt11.mockRejectedValue(alreadySpent());
      walletMocks.checkProofsStates.mockResolvedValue([
        {state: cashu.CheckStateEnum.SPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);
      // The second quote fits the healed selection, so the retry melts.
      walletMocks.createMeltQuoteBolt11
        .mockResolvedValueOnce({...meltQuote, amount: 32})
        .mockResolvedValueOnce({...meltQuote, amount: 16});

      await expect(
        sweepSettledProofs({
          mintUrl: MINT_URL,
          bolt11: 'lnbc-invoice',
          keepReserveSat: 16,
          now: T0 + 10_000,
        }),
      ).rejects.toBeInstanceOf(cashu.MintOperationError);

      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the reconcile finds nothing to drop', async () => {
      // 11001 with every listing reported unspent is not a stale store;
      // re-sending the same melt would only repeat the verdict.
      walletMocks.meltProofsBolt11.mockRejectedValue(alreadySpent());
      walletMocks.checkProofsStates.mockResolvedValue([
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);

      await expect(
        sweepSettledProofs({
          mintUrl: MINT_URL,
          bolt11: 'lnbc-invoice',
          keepReserveSat: 16,
          now: T0 + 10_000,
        }),
      ).rejects.toBeInstanceOf(cashu.MintOperationError);

      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
      await expect(listSettledProofs()).resolves.toHaveLength(3);
    });

    it('leaves every other melt failure alone', async () => {
      walletMocks.meltProofsBolt11.mockRejectedValue(
        new Error('payout quote sweep-q1 did not settle: PENDING'),
      );

      await expect(
        sweepSettledProofs({
          mintUrl: MINT_URL,
          bolt11: 'lnbc-invoice',
          keepReserveSat: 16,
          now: T0 + 10_000,
        }),
      ).rejects.toThrow('did not settle');

      expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
    });

    it('stops quietly when the healed till falls under the minimum (ENG-696)', async () => {
      mockStore['@cashu_settled_proofs'] = JSON.stringify([
        tillProof(16, 'gone'),
        tillProof(8, 'live-small'),
      ]);
      walletMocks.createMeltQuoteBolt11.mockResolvedValue({
        ...meltQuote,
        amount: 24,
      });
      walletMocks.meltProofsBolt11.mockRejectedValueOnce(alreadySpent());
      walletMocks.checkProofsStates.mockResolvedValueOnce([
        {state: cashu.CheckStateEnum.SPENT},
        {state: cashu.CheckStateEnum.UNSPENT},
      ]);

      const result = await sweepSettledProofs({
        mintUrl: MINT_URL,
        bolt11: 'lnbc-invoice',
        keepReserveSat: 0,
        minSweepSat: 10,
        now: T0 + 10_000,
      });

      expect(result.paidSat).toBe(0);
      expect(walletMocks.meltProofsBolt11).toHaveBeenCalledTimes(1);
      expect(walletMocks.createMeltQuoteBolt11).toHaveBeenCalledTimes(1);
      await expect(listSettledProofs()).resolves.toEqual([
        tillProof(8, 'live-small'),
      ]);
    });
  });
});

describe('reconcileTill', () => {
  const tillProof = (amount: number, secret: string) => ({
    id: KEYSET_ID,
    amount,
    secret,
    C: TEST_CARD_PUBKEY,
    mintUrl: MINT_URL,
  });
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    mockStore['@cashu_settled_proofs'] = JSON.stringify([
      tillProof(16, 'live'),
      tillProof(16, 'gone'),
    ]);
    walletMocks.checkProofsStates.mockResolvedValue([
      {state: cashu.CheckStateEnum.UNSPENT},
      {state: cashu.CheckStateEnum.SPENT},
    ]);
  });

  it('drops the listings the mint reports spent', async () => {
    await expect(reconcileTill(MINT_URL, {now: T0})).resolves.toBe(1);
    await expect(listSettledProofs()).resolves.toEqual([tillProof(16, 'live')]);
  });

  it('asks the mint at most once per window', async () => {
    await reconcileTill(MINT_URL, {now: T0});
    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);

    await expect(
      reconcileTill(MINT_URL, {now: T0 + RECONCILE_MIN_INTERVAL_MS - 1}),
    ).resolves.toBe(0);
    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);

    await reconcileTill(MINT_URL, {now: T0 + RECONCILE_MIN_INTERVAL_MS});
    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
  });

  it('the test seam reopens the window', async () => {
    await reconcileTill(MINT_URL, {now: T0});
    __resetReconcileThrottle();
    await reconcileTill(MINT_URL, {now: T0 + 1});
    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(2);
  });

  it("a throttled attempt counts as the window's one ask, and rethrows", async () => {
    walletMocks.checkProofsStates.mockRejectedValue(
      new cashu.RateLimitError('Too Many Requests', 2500),
    );
    await expect(reconcileTill(MINT_URL, {now: T0})).rejects.toBeInstanceOf(
      cashu.RateLimitError,
    );
    await expect(reconcileTill(MINT_URL, {now: T0 + 20_000})).resolves.toBe(0);
    expect(walletMocks.checkProofsStates).toHaveBeenCalledTimes(1);
    // The store is not flipped to all-clear by a throttle.
    await expect(listSettledProofs()).resolves.toHaveLength(2);
  });

  it('every other failure keeps the last known state, quietly', async () => {
    walletMocks.checkProofsStates.mockRejectedValue(
      new TypeError('Network request failed'),
    );
    await expect(reconcileTill(MINT_URL, {now: T0})).resolves.toBe(0);
    await expect(listSettledProofs()).resolves.toHaveLength(2);
  });
});

// ── protocol 2.0: the card's secrets, the SIG_ALL message, DLEQ, the swap ──

const vectors = require('../fixtures/card-protocol-2.0/secret.json') as {
  cardKey: string;
  refundKey: string;
  pieces: {
    amount: number;
    nonce: string;
    C: string;
    date: number;
    secret: string;
    message: string;
    signature: string;
  }[];
};

describe('buildCardSigAllSecret (spec/vectors/secret.json)', () => {
  it.each(vectors.pieces.map(p => [p.amount, p.date, p]))(
    'rebuilds the %i-sat piece dated %i byte for byte',
    (_amount, _date, piece) => {
      const p = piece as (typeof vectors.pieces)[number];
      expect(
        buildCardSigAllSecret(
          p.nonce,
          vectors.cardKey,
          p.date,
          vectors.refundKey,
        ),
      ).toBe(p.secret);
    },
  );

  it('lower-cases what the card reports', () => {
    const p = vectors.pieces[2];
    expect(
      buildCardSigAllSecret(
        p.nonce.toUpperCase(),
        vectors.cardKey.toUpperCase(),
        p.date,
        vectors.refundKey.toUpperCase(),
      ),
    ).toBe(p.secret);
  });

  it('refuses a dated piece with no refund key rather than guess its secret', () => {
    expect(() =>
      buildCardSigAllSecret(vectors.pieces[1].nonce, vectors.cardKey, 1),
    ).toThrow(/refund key/);
  });

  it('is the format-4 text, never the 0.x SIG_INPUTS one', () => {
    const secret = buildCardSigAllSecret(NONCE, TEST_CARD_PUBKEY);
    expect(secret).toContain('["sigflag","SIG_ALL"]');
    expect(secret).not.toBe(buildCardP2PKSecret(NONCE, TEST_CARD_PUBKEY));
  });
});

describe('sigAllMessage', () => {
  it("is the applet's message for each vector piece, and its signature verifies", () => {
    for (const p of vectors.pieces) {
      const message = sigAllMessage([{secret: p.secret, C: p.C}], []);
      expect(bytesToHex(message)).toBe(p.message);
      expect(verifyCardSignature(p.signature, message, vectors.cardKey)).toBe(
        true,
      );
    }
  });

  it('hashes inputs (secret ‖ C) then outputs (decimal amount ‖ B_), in order', () => {
    const inputs = [
      {secret: 'A', C: '02AB'},
      {secret: 'B', C: '03cd'},
    ];
    const outputs = [
      {amount: 16, B_: '02EF'},
      {amount: 1, B_: '0301'},
    ];
    expect(bytesToHex(sigAllMessage(inputs, outputs))).toBe(
      bytesToHex(sha256(utf8ToBytes('A02abB03cd1602ef10301'))),
    );
  });

  it('a signature over another payment does not verify', () => {
    const p = vectors.pieces[0];
    const other = sigAllMessage(
      [{secret: p.secret, C: p.C}],
      [{amount: 1, B_: TEST_CARD_PUBKEY}],
    );
    expect(verifyCardSignature(p.signature, other, vectors.cardKey)).toBe(
      false,
    );
    expect(verifyCardSignature('zz', other, vectors.cardKey)).toBe(false);
  });
});

describe('verifyPieceDleq', () => {
  const mint = new TestMint();
  const card = new FakeCard2();
  const piece = mint.mintPiece(card.pubkey, 8, {nonce: pieceNonce(1)});

  it('a piece the mint signed, with its kept proof, verifies', () => {
    expect(verifyPieceDleq(piece, piece.dleq, mint.keys)).toBe(true);
  });

  it('a dated piece verifies with its own secret', () => {
    const dated = mint.mintPiece(card.pubkey, 4, {
      nonce: pieceNonce(2),
      date: 1700000000,
      refundKey: REFUND_KEY,
    });
    expect(dated.secret).toBe(
      buildCardSigAllSecret(dated.nonce, card.pubkey, 1700000000, REFUND_KEY),
    );
    expect(verifyPieceDleq(dated, dated.dleq, mint.keys)).toBe(true);
  });

  it('a made-up C does not', () => {
    expect(
      verifyPieceDleq({...piece, C: card.pubkey}, piece.dleq, mint.keys),
    ).toBe(false);
  });

  it("another mint's keys do not", () => {
    const other = new TestMint({label: 'another-mint'});
    expect(verifyPieceDleq(piece, piece.dleq, other.keys)).toBe(false);
  });

  it('a missing proof, missing keys, or a tampered proof is not verified', () => {
    expect(verifyPieceDleq(piece, null, mint.keys)).toBe(false);
    expect(verifyPieceDleq(piece, piece.dleq, undefined)).toBe(false);
    expect(
      verifyPieceDleq(piece, {...piece.dleq!, e: '00'.repeat(32)}, mint.keys),
    ).toBe(false);
    expect(verifyPieceDleq({...piece, amount: 3}, piece.dleq, mint.keys)).toBe(
      false,
    );
  });
});

describe('the kept keysets', () => {
  const mint = new TestMint();

  it("expandKeysetId finds the one keyset a card's 8 bytes name", () => {
    const v2 = {...mint.cachedKeyset(), id: `01${'ab'.repeat(32)}`};
    const keysets = [mint.cachedKeyset(), v2];
    expect(expandKeysetId(KEYSET_ID, keysets).id).toBe(KEYSET_ID);
    expect(expandKeysetId(`01${'ab'.repeat(7)}`, keysets).id).toBe(v2.id);
  });

  it('refuses an unknown or ambiguous prefix rather than guess', () => {
    const twin = {...mint.cachedKeyset(), id: `${KEYSET_ID}ff`};
    expect(() =>
      expandKeysetId('00ffffffffffffff', [mint.cachedKeyset()]),
    ).toThrow(UnknownKeysetError);
    expect(() =>
      expandKeysetId(KEYSET_ID, [mint.cachedKeyset(), twin]),
    ).toThrow(/names 2 keysets/);
  });

  it('keysetFor answers from what is kept, with no network', async () => {
    await saveKeysets(MINT_URL, [mint.cachedKeyset()]);
    const keyset = await keysetFor(MINT_URL, KEYSET_ID, {online: false});
    expect(keyset.keys['8']).toBe(mint.keys['8']);
    expect(walletMocks.loadMint).not.toHaveBeenCalled();
  });

  it('keysetFor offline with nothing kept is UnknownKeysetError', async () => {
    await expect(
      keysetFor(MINT_URL, KEYSET_ID, {online: false}),
    ).rejects.toBeInstanceOf(UnknownKeysetError);
  });

  it('keysetFor online asks the mint and keeps what it learns', async () => {
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    const keyset = await keysetFor(MINT_URL, KEYSET_ID);
    expect(keyset.id).toBe(KEYSET_ID);
    await expect(cachedKeysets(MINT_URL)).resolves.toEqual([
      mint.cachedKeyset(),
    ]);
  });

  it('a mint that lists a keyset without keys keeps the ones learned earlier', async () => {
    await saveKeysets(MINT_URL, [mint.cachedKeyset()]);
    walletMocks.getKeysets.mockReturnValue([
      {...mint.keyChainKeyset(), isActive: false, hasKeys: false, keys: {}},
    ]);
    await keysetFor(MINT_URL, '00ffffffffffffff').catch(() => null);
    const kept = await cachedKeysets(MINT_URL);
    expect(kept[0].active).toBe(false);
    expect(kept[0].keys['8']).toBe(mint.keys['8']);
  });

  it('inputFee is NUT-02: per input, in parts per thousand, rounded up', () => {
    expect(inputFee({...mint.cachedKeyset(), inputFeePpk: 0}, 3)).toBe(0);
    expect(inputFee({...mint.cachedKeyset(), inputFeePpk: 100}, 2)).toBe(1);
    expect(inputFee({...mint.cachedKeyset(), inputFeePpk: 100}, 11)).toBe(2);
  });

  describe('refreshKeysets (ENG-674 should-fix)', () => {
    it('overwrites a stale cache with what the mint lists now', async () => {
      await saveKeysets(MINT_URL, [{...mint.cachedKeyset(), active: false}]);
      walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);

      await expect(refreshKeysets(MINT_URL)).resolves.toBe(true);

      expect(walletMocks.loadMint).toHaveBeenCalledWith(true);
      const kept = await cachedKeysets(MINT_URL);
      expect(kept.find(k => k.id === KEYSET_ID)?.active).toBe(true);
    });

    it('is best effort: a mint that will not answer leaves the cache untouched', async () => {
      await saveKeysets(MINT_URL, [mint.cachedKeyset()]);
      walletMocks.loadMint.mockRejectedValue(new TypeError('offline'));

      await expect(refreshKeysets(MINT_URL)).resolves.toBe(false);

      await expect(cachedKeysets(MINT_URL)).resolves.toEqual([
        mint.cachedKeyset(),
      ]);
    });
  });
});

describe('prepareChargeOutputs', () => {
  it('one blinded output per power-of-two piece, each with its opening kept', () => {
    const {outputs, blinding} = prepareChargeOutputs({
      keysetId: KEYSET_ID,
      merchantSat: 13,
    });
    expect(outputs.map(o => o.amount)).toEqual([8, 4, 1]);
    expect(outputs.every(o => o.keysetId === KEYSET_ID)).toBe(true);
    expect(blinding).toHaveLength(3);
    // Each B_ is the blinding of its own secret with its own r.
    outputs.forEach((o, i) => {
      const {B_} = cashu.blindMessage(
        utf8ToBytes(blinding[i].secret),
        BigInt(`0x${blinding[i].r}`),
      );
      expect(B_.toHex(true)).toBe(o.B_);
    });
    // Fresh secrets every time.
    expect(new Set(blinding.map(b => b.secret)).size).toBe(3);
  });

  it('refuses outputs worth nothing', () => {
    expect(() =>
      prepareChargeOutputs({keysetId: KEYSET_ID, merchantSat: 0}),
    ).toThrow();
  });
});

/** A 2.0 payment the fake card signs: two pieces, merchant outputs, its own change. */
async function signedPayment(mint: TestMint, changeSat = 4) {
  const probe = new FakeCard2();
  const pieces = [8, 16].map((amount, i) =>
    mint.mintPiece(probe.pubkey, amount, {nonce: pieceNonce(10 + i)}),
  );
  const card = new FakeCard2({pieces});
  const inputs = pieces.map((p, i) => ({
    slot: i,
    nonce: p.nonce,
    secret: p.secret,
    C: p.C,
    amount: p.amount,
    keysetId: KEYSET_ID,
  }));
  const merchant = prepareChargeOutputs({
    keysetId: KEYSET_ID,
    merchantSat: 24 - changeSat,
  });
  // Drive the card by hand: BEGIN, OUTPUTS, CHANGE, SIGN.
  const card_ = jest.requireActual('../../src/services/cashuCard');
  await card_.selectApplet(card.transceive);
  await card_.spendAllBegin(card.transceive, [0, 1]);
  await card_.spendAllOutputs(card.transceive, merchant.outputs);
  const outputs = [...merchant.outputs];
  for (const amount of changeSat ? [changeSat] : []) {
    outputs.push({
      amount,
      B_: await card_.spendAllChange(card.transceive, amount),
      keysetId: KEYSET_ID,
    });
  }
  const witness = card_.toHex(await card_.spendAllSign(card.transceive));
  return {
    card,
    signed: {
      inputs,
      witness,
      outputs,
      merchantBlinding: merchant.blinding,
      ...(changeSat ? {cardChangeIndex: merchant.outputs.length} : {}),
    },
  };
}

describe('swapSigned', () => {
  it('submits the stored payment exactly, the witness on the first input only', async () => {
    const mint = new TestMint();
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    walletMocks.mintSwap.mockImplementation(async req => mint.swap(req));
    const {signed} = await signedPayment(mint);

    const result = await swapSigned(MINT_URL, signed);

    const [req] = walletMocks.mintSwap.mock.calls[0];
    expect(req.inputs.map((i: {secret: string}) => i.secret)).toEqual(
      signed.inputs.map(i => i.secret),
    );
    expect(req.inputs[0].witness).toBe(
      JSON.stringify({signatures: [signed.witness]}),
    );
    expect(req.inputs[1].witness).toBeUndefined();
    expect(req.outputs).toEqual(
      signed.outputs.map(o => ({amount: o.amount, id: KEYSET_ID, B_: o.B_})),
    );
    // The merchant's outputs are unblinded into real proofs of the mint.
    expect(result.till.map(p => p.amount)).toEqual([16, 4]);
    for (const p of result.till) {
      expect(mint.verifyProof(p.secret, p.C, p.amount)).toBe(true);
    }
    // The card's change comes back as the mint's half, with its DLEQ.
    expect(result.cardChange).toEqual([
      expect.objectContaining({
        amount: 4,
        B_: signed.outputs[2].B_,
        keysetId: KEYSET_ID,
        dleq: expect.objectContaining({e: expect.any(String)}),
      }),
    ]);
  });

  it('the mint refuses a witness that does not sign these outputs', async () => {
    const mint = new TestMint();
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    walletMocks.mintSwap.mockImplementation(async req => mint.swap(req));
    const {signed} = await signedPayment(mint);
    const swapped = {
      ...signed,
      outputs: [...signed.outputs].reverse(),
    };
    await expect(swapSigned(MINT_URL, swapped)).rejects.toMatchObject({
      code: 20008,
    });
  });

  it("finishCardChange unblinds the change with the card's r", () => {
    const mint = new TestMint();
    const secret = cardSecretText(pieceNonce(5), new FakeCard2().pubkey);
    const r = 12345n;
    const {B_} = cashu.blindMessage(utf8ToBytes(secret), r);
    const {C_} = mint.sign(B_.toHex(true), 4);
    const C = finishCardChange(
      C_,
      r.toString(16).padStart(64, '0'),
      4,
      mint.keys,
    );
    expect(mint.verifyProof(secret, C, 4)).toBe(true);
    expect(() =>
      finishCardChange(C_, r.toString(16).padStart(64, '0'), 3, mint.keys),
    ).toThrow(UnknownKeysetError);
  });
});

describe('swap — a 2.0 payment (SIG_ALL)', () => {
  async function sigAllEntry(mint: TestMint) {
    const {signed, card} = await signedPayment(mint);
    const message = bytesToHex(sigAllMessage(signed.inputs, signed.outputs));
    const first = signed.inputs[0];
    const entry: SettlementEntry = {
      id: `${card.pubkey}:${first.slot}:${first.nonce}`,
      cardPubkey: card.pubkey,
      slot: first.slot,
      keysetId: KEYSET_ID,
      mintUrl: MINT_URL,
      unit: 'sat',
      amount: 24,
      nonce: first.nonce,
      secret: first.secret,
      C: first.C,
      witness: signed.witness,
      status: 'pending',
      createdAt: 0,
      updatedAt: 0,
      attempts: 0,
      sigflag: 'SIG_ALL',
      inputs: signed.inputs,
      outputs: signed.outputs,
      merchantBlinding: signed.merchantBlinding,
      cardChangeIndex: signed.cardChangeIndex,
      message,
    };
    return entry;
  }

  it("resubmits the stored outputs, keeps the till and records the card's change owed", async () => {
    const mint = new TestMint();
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    walletMocks.mintSwap.mockImplementation(async req => mint.swap(req));
    const entry = await sigAllEntry(mint);

    await createSettlementAdapter().swap(entry);

    const [req] = walletMocks.mintSwap.mock.calls[0];
    expect(req.outputs.map((o: {B_: string}) => o.B_)).toEqual(
      entry.outputs.map(o => o.B_),
    );
    expect(walletMocks.prepareSwapToSend).not.toHaveBeenCalled();
    expect((await listSettledProofs()).map(p => p.amount)).toEqual([16, 4]);
    const owed = await listOwedChange();
    expect(owed).toEqual([
      expect.objectContaining({
        cardPubkey: entry.cardPubkey,
        amount: 4,
        B_: entry.outputs[2].B_,
        status: 'owed',
      }),
    ]);
  });

  it('refuses before any network call a witness that does not sign the stored payment', async () => {
    const mint = new TestMint();
    const entry = await sigAllEntry(mint);
    const tampered = {
      ...entry,
      outputs: entry.outputs.map((o, i) =>
        i === 0 ? {...o, amount: o.amount + 1} : o,
      ),
    };
    await expect(
      createSettlementAdapter().swap(tampered),
    ).rejects.toBeInstanceOf(PermanentSettlementError);
    await expect(
      createSettlementAdapter().swap({...entry, message: '00'.repeat(32)}),
    ).rejects.toBeInstanceOf(PermanentSettlementError);
    expect(walletMocks.mintSwap).not.toHaveBeenCalled();
  });

  it("maps the mint's 11001 to ProofAlreadySpentError", async () => {
    const mint = new TestMint();
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    walletMocks.mintSwap.mockImplementation(async req => mint.swap(req));
    const entry = await sigAllEntry(mint);
    await createSettlementAdapter().swap(entry);
    await expect(createSettlementAdapter().swap(entry)).rejects.toBeInstanceOf(
      ProofAlreadySpentError,
    );
  });

  it('a fetch-level failure is TransportSettlementError (provably unsent)', async () => {
    const mint = new TestMint();
    walletMocks.mintSwap.mockRejectedValue(
      new TypeError('Network request failed'),
    );
    const entry = await sigAllEntry(mint);
    await expect(createSettlementAdapter().swap(entry)).rejects.toBeInstanceOf(
      TransportSettlementError,
    );
  });

  it("still records the till when the owed-change write fails, and never drops the other's write (ENG-674 should-fix, allAttempted)", async () => {
    const mint = new TestMint();
    walletMocks.getKeysets.mockReturnValue([mint.keyChainKeyset()]);
    walletMocks.mintSwap.mockImplementation(async req => mint.swap(req));
    const entry = await sigAllEntry(mint);
    const {setSecure} = jest.requireMock(
      '../../src/services/secureStorage',
    ) as {setSecure: jest.Mock};
    setSecure.mockImplementation(async (k: string, v: string) => {
      if (k === OWED_CHANGE_KEY) {
        throw new Error('keychain refused');
      }
      mockStore[k] = v;
    });

    // The mint accepted the swap before either write ran: rethrowing the
    // owed-change failure must never cost the merchant's take the write it
    // would otherwise have kept (ENG-642's `allAttempted` pattern — before
    // this fix, the till write never ran at all once the change write
    // threw).
    await expect(createSettlementAdapter().swap(entry)).rejects.toThrow(
      'keychain refused',
    );
    expect((await listSettledProofs()).map(p => p.amount)).toEqual([16, 4]);
  });
});

describe('mintReachable', () => {
  it('true when the mint answers its keysets, false on any failure', async () => {
    const fetchOk = jest.fn(async () => ({ok: true} as Response));
    const fetchDown = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const fetch500 = jest.fn(async () => ({ok: false} as Response));
    await expect(mintReachable(`${MINT_URL}/`, 100, fetchOk)).resolves.toBe(
      true,
    );
    expect(fetchOk).toHaveBeenCalledWith(
      `${MINT_URL}/v1/keysets`,
      expect.anything(),
    );
    await expect(mintReachable(MINT_URL, 100, fetchDown)).resolves.toBe(false);
    await expect(mintReachable(MINT_URL, 100, fetch500)).resolves.toBe(false);
  });
});
