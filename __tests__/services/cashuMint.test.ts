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
import {
  bytesToHex,
  hexToBytes,
} from '@noble/hashes/utils';

import {
  __resetWalletCache,
  buildCardP2PKSecret,
  makeCanonicalCardOutput,
  createSettlementAdapter,
  listSettledProofs,
  meltSettledProofs,
} from '../../src/services/cashuMint';
import {
  PermanentSettlementError,
  ProofAlreadySpentError,
  TransportSettlementError,
  type SettlementEntry,
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

type WalletMocks = {
  loadMint: jest.Mock
  prepareSwapToSend: jest.Mock
  completeSwap: jest.Mock
  checkProofsStates: jest.Mock
  serializeSwapPreview: jest.Mock
  createMeltQuoteBolt11: jest.Mock
  meltProofsBolt11: jest.Mock
};

jest.mock('@cashu/cashu-ts', () => {
  const actual = jest.requireActual('@cashu/cashu-ts');
  const mocks: WalletMocks = {
    loadMint: jest.fn(),
    prepareSwapToSend: jest.fn(),
    completeSwap: jest.fn(),
    checkProofsStates: jest.fn(),
    serializeSwapPreview: jest.fn(() => 'serialized-preview'),
    createMeltQuoteBolt11: jest.fn(),
    meltProofsBolt11: jest.fn(),
  };
  class MockWallet {
    loadMint = mocks.loadMint;
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
const walletMocks = (jest.requireMock('@cashu/cashu-ts') as {
  __walletMocks: WalletMocks;
}).__walletMocks;

// Real values from the silicon run (see HARDWARE_TEST_REPORT_2026-09-22): the
// fixture pins the secret serialization against a proof the actual toolchain
// minted, so a formatting drift here fails loudly instead of at the mint.
const CARD_PUBKEY =
  '03858498d50d2545aec9233357a69ef6d03c25b885921f47d7504c18161025574d';
const NONCE = '12a121736d3975fd4aefa5fda969e84b2023235d78962c17db23d2ea87d375ef';
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

beforeEach(() => {
  jest.clearAllMocks();
  __resetWalletCache();
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
      '["P2PK",{"nonce":"' + NONCE + '","data":"' + CARD_PUBKEY + '","tags":[["sigflag","SIG_INPUTS"]]}]',
    );
  });

  it('lower-cases whatever the card reports', () => {
    const s = buildCardP2PKSecret(NONCE.toUpperCase(), CARD_PUBKEY.toUpperCase());
    expect(s).toBe(buildCardP2PKSecret(NONCE, CARD_PUBKEY));
  });
});

describe('makeCanonicalCardOutput', () => {
  it('blinds a secret the card-side rebuild reproduces byte for byte', () => {
    const output = makeCanonicalCardOutput(8, KEYSET_ID, CARD_PUBKEY);
    const written = new TextDecoder().decode(
      output.secret instanceof Uint8Array ? output.secret : output.secret,
    );
    const {nonce} = JSON.parse(written)[1];
    expect(written).toBe(buildCardP2PKSecret(nonce, CARD_PUBKEY));
  });
});

describe('swap', () => {
  it('settles: verifies the witness, persists the preview before the call, then the proofs', async () => {
    const adapter = createSettlementAdapter();
    let pendingDuringCall: string | null = null;
    walletMocks.completeSwap.mockImplementation(async () => {
      pendingDuringCall = mockStore[`@cashu_settlement_swap:${entryWith().id}`] ?? null;
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
    expect(mockStore['@cashu_settlement_swap:' + entryWith().id]).toBeUndefined();
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

    await expect(adapter.swap(entryWith())).rejects.toThrow('mint rate-limited');
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

    await expect(adapter.swap(entryWith())).rejects.toThrow('keychain write denied');
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
        {id: KEYSET_ID, amount: 1, secret: 'change-secret', C: TEST_CARD_PUBKEY},
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
    expect(mockStore['@cashu_settled_payout:@q1'.replace('@q1', 'payout-q1')]).toBeUndefined();
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
});
