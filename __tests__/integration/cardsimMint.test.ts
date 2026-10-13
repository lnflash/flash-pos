/**
 * The 2.0 card layer against the REAL applet and a REAL mint: cardsim
 * (lnflash/cashu-javacard tools/cardsim, the applet in jCardSim over HTTP)
 * and a Nutshell 0.20.3 on FakeWallet (decision 6). The production
 * readAndPlan → executeCharge path pays with one SIG_ALL signature the
 * applet makes, the swap is the mint's to accept or refuse, and the change
 * is finished from the card's own openings and loaded back.
 *
 * Runs only with both services, like cashu-javacard's own e2e-swap test:
 *
 *   java -jar tools/cardsim/target/cardsim.jar --port 9876
 *   docker run -d -p 127.0.0.1:3338:3338 -e MINT_BACKEND_BOLT11_SAT=FakeWallet \
 *     -e MINT_LISTEN_HOST=0.0.0.0 -e MINT_LISTEN_PORT=3338 -e MINT_PRIVATE_KEY=TEST \
 *     -e MINT_INPUT_FEE_PPK=0 -e FAKEWALLET_BRR=TRUE cashubtc/nutshell:0.20.3 poetry run mint
 *   CARD_E2E_CARDSIM=http://127.0.0.1:9876 CARD_E2E_MINT=http://127.0.0.1:3338 \
 *     yarn jest __tests__/integration/cardsimMint.test.ts
 *
 * Skipped otherwise: nothing here runs in the unit suite.
 */
import {
  blindMessage,
  Mint,
  pointFromHex,
  unblindSignature,
} from '@cashu/cashu-ts';
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils';

import {
  getBalance,
  getCard,
  isPinNeededForPayment,
  readCard,
  type Transceiver,
} from '../../src/services/cashuCard';
import {
  __resetWalletCache,
  buildCardSigAllSecret,
  listSettledProofs,
} from '../../src/services/cashuMint';
import {
  DAILY_LIMIT_REACHED,
  executeCharge,
  isPaidFailure,
  readAndPlan,
  reconcileOwedChange,
  writeOwedChange,
} from '../../src/services/cashuCharge';
import {settlePending} from '../../src/services/cashuSpend';
import {
  clearQueue,
  listOwedChange,
  listSettlements,
} from '../../src/services/cashuSettlement';

const CARDSIM = process.env.CARD_E2E_CARDSIM;
const MINT_URL = process.env.CARD_E2E_MINT;
const run = CARDSIM && MINT_URL ? describe : describe.skip;

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

jest.setTimeout(120_000);

async function bridge(path: string, body?: unknown) {
  const res = await fetch(`${CARDSIM}${path}`, {
    method: body === undefined && path === '/state' ? 'GET' : 'POST',
    headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`cardsim ${path}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/** The card, over cardsim's /apdu: what the dev card bridge does in the app. */
const transceive: Transceiver = async apdu => {
  const {hex} = (await bridge('/apdu', {
    hex: apdu.map(b => b.toString(16).padStart(2, '0')).join(''),
  })) as {hex: string};
  return (hex.match(/../g) ?? []).map(h => parseInt(h, 16));
};

/** Mint format-4 SIG_ALL pieces to the card, each with the mint's DLEQ. */
async function mintToCard(cardKey: string, amounts: number[]) {
  const mint = new Mint(MINT_URL!);
  const {keysets} = await mint.getKeySets();
  const keyset = keysets.find(k => k.active && k.unit === 'sat')!;
  const keys = (await mint.getKeys(keyset.id)).keysets[0].keys as Record<
    string,
    string
  >;
  const total = amounts.reduce((t, a) => t + a, 0);
  const quote = await mint.createMintQuoteBolt11({amount: total, unit: 'sat'});
  for (let i = 0; i < 50; i++) {
    const q = await mint.checkMintQuoteBolt11(quote.quote);
    if (q.state === 'PAID') {
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const blinded = amounts.map(amount => {
    const nonce = bytesToHex(randomBytes(32));
    const secret = buildCardSigAllSecret(nonce, cardKey);
    const {B_, r} = blindMessage(utf8ToBytes(secret));
    return {amount, nonce, secret, B_: B_.toHex(true), r};
  });
  const {signatures} = await mint.mintBolt11({
    quote: quote.quote,
    outputs: blinded.map(b => ({amount: b.amount, id: keyset.id, B_: b.B_})),
  } as never);
  return {
    keyset,
    pieces: signatures.map((sig, i) => {
      const b = blinded[i];
      const C = unblindSignature(
        pointFromHex(sig.C_),
        b.r,
        pointFromHex(keys[String(b.amount)]),
      ).toHex(true);
      return {
        keysetId: keyset.id.slice(0, 16),
        amount: b.amount,
        nonce: b.nonce,
        C,
        dleq: {
          e: sig.dleq!.e,
          s: sig.dleq!.s,
          r: b.r.toString(16).padStart(64, '0'),
        },
      };
    }),
  };
}

run('the 2.0 card layer against cardsim and a Nutshell 0.20.3 mint', () => {
  let cardKey: string;

  beforeEach(async () => {
    for (const k of Object.keys(mockStore)) {
      delete mockStore[k];
    }
    __resetWalletCache();
    await clearQueue();
    cardKey = ((await bridge('/reset', {})) as {pubkey: string}).pubkey;
  });

  it('a PIN card pays 10 from a 16: one SIG_ALL swap the mint accepts, the change back on the card', async () => {
    const {pieces} = await mintToCard(cardKey, [16, 4]);
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: pieces,
    });

    const preRead = await readAndPlan({
      transceive,
      amountSat: 10,
      mintUrl: MINT_URL,
    });
    expect(preRead.pinRequired).toBe(true);
    expect(preRead.plan).toMatchObject({burnedSat: 16, changeSat: 6});
    // Nothing kept yet on a fresh terminal: the mint checks it in the tap.
    expect(preRead.requiresOnline).toBe(true);

    const result = await executeCharge({
      ...preRead,
      transceive,
      amountSat: 10,
      pin: '1234',
      mintUrl: MINT_URL!,
    });

    expect(result.changeLoaded).toBe(2);
    expect(await getBalance(transceive)).toBe(4 + 6);
    const [entry] = await listSettlements();
    expect(entry.status).toBe('settled');
    expect(entry.sigflag).toBe('SIG_ALL');
    // The merchant's take: real proofs the mint holds as unspent.
    const till = await listSettledProofs();
    expect(till.reduce((t, p) => t + p.amount, 0)).toBe(10);
    const states = await new Mint(MINT_URL!).check({
      Ys: till.map(p =>
        bytesToHex(
          (
            jest.requireActual(
              '@cashu/cashu-ts',
            ) as typeof import('@cashu/cashu-ts')
          )
            .hashToCurve(utf8ToBytes(p.secret))
            .toBytes(true),
        ),
      ),
    } as never);
    expect(
      (states as {states: {state: string}[]}).states.every(
        s => s.state === 'UNSPENT',
      ),
    ).toBe(true);
    // The change is on the card, with the mint's proof kept beside it.
    const state = (await bridge('/state')) as {
      slots: {status: string; amount: number; dleq?: unknown}[];
    };
    const unspent = state.slots.filter(s => s.status === 'unspent');
    expect(unspent.map(s => s.amount).sort((a, b) => a - b)).toEqual([2, 4, 4]);
    expect(unspent.every(s => s.dleq)).toBe(true);
    expect((await listOwedChange()).every(e => e.status === 'written')).toBe(
      true,
    );

    // And the change pays: the next charge spends the card's own change.
    const next = await readAndPlan({
      transceive,
      amountSat: 6,
      mintUrl: MINT_URL,
    });
    expect(next.requiresOnline).toBe(false);
    await executeCharge({
      ...next,
      transceive,
      amountSat: 6,
      pin: '1234',
      mintUrl: MINT_URL!,
    });
    expect(await getBalance(transceive)).toBe(4);
  });

  it('a bill under the no-PIN allowance is paid with no PIN, its change loaded under the change grant', async () => {
    const {pieces} = await mintToCard(cardKey, [16]);
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: pieces,
      limits: {day: 0, payment: 0, allowance: 50},
    });

    const preRead = await readAndPlan({
      transceive,
      amountSat: 12,
      mintUrl: MINT_URL,
    });
    expect(preRead.pinRequired).toBe(false);
    const result = await executeCharge({
      ...preRead,
      transceive,
      amountSat: 12,
      mintUrl: MINT_URL!,
    });

    expect(result.changeLoaded).toBe(1);
    expect(await getBalance(transceive)).toBe(4);
  });

  it('an exact bill whose swap never reached the mint is drained later with exactly the outputs the card signed', async () => {
    const {pieces} = await mintToCard(cardKey, [8]);
    await bridge('/fixture', {mint: MINT_URL, owner: true, proofs: pieces});
    const preRead = await readAndPlan({
      transceive,
      amountSat: 8,
      mintUrl: MINT_URL,
    });

    // The swap request never leaves the device (offline at the moment of
    // the swap); everything else reaches the mint.
    const realFetch = global.fetch;
    let swapsRefused = 0;
    global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/swap') && swapsRefused === 0) {
        swapsRefused += 1;
        throw new TypeError('Network request failed');
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const result = await executeCharge({
        ...preRead,
        transceive,
        amountSat: 8,
        mintUrl: MINT_URL!,
      });
      expect(result.changeSat).toBe(0);
    } finally {
      global.fetch = realFetch;
    }
    expect(swapsRefused).toBe(1);
    expect(await getBalance(transceive)).toBe(0);
    const [pending] = await listSettlements();
    expect(pending.status).toBe('pending');

    const drained = await settlePending();
    expect(drained.settled).toBe(1);
    const [after] = await listSettlements();
    expect(after.status).toBe('settled');
    expect((await listSettledProofs()).reduce((t, p) => t + p.amount, 0)).toBe(
      8,
    );
  });

  const headers = (
    require('../fixtures/card-protocol-2.0/headers.json') as {
      headers: {time: number; header: string}[];
    }
  ).headers;
  const headerBytes = (i: number) =>
    Array.from(Buffer.from(headers[i].header, 'hex'));

  it("shows the card a real tip header before the payment: the card's clock moves to it", async () => {
    const {pieces} = await mintToCard(cardKey, [8]);
    await bridge('/fixture', {
      mint: MINT_URL,
      owner: true,
      anchor: headers[0].header,
      proofs: pieces,
    });
    const preRead = await readAndPlan({
      transceive,
      amountSat: 8,
      mintUrl: MINT_URL,
    });
    await executeCharge({
      ...preRead,
      transceive,
      amountSat: 8,
      mintUrl: MINT_URL!,
      header: headerBytes(11),
    });
    const state = (await bridge('/state')) as {now: number};
    expect(state.now).toBe(headers[11].time);
  });

  it("a bill over the card's daily limit is refused before anything burns", async () => {
    const {pieces} = await mintToCard(cardKey, [8]);
    await bridge('/fixture', {
      mint: MINT_URL,
      owner: true,
      anchor: headers[11].header,
      proofs: pieces,
      limits: {day: 5},
    });
    await expect(
      readAndPlan({
        transceive,
        amountSat: 8,
        mintUrl: MINT_URL,
        header: headerBytes(11),
      }),
    ).rejects.toThrow(DAILY_LIMIT_REACHED);
    expect(await getBalance(transceive)).toBe(8);
  });

  it("the card's own refusal at SIGN when its allowance does not cover the bill: nothing burned, the PIN is needed", async () => {
    const {pieces} = await mintToCard(cardKey, [8]);
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: pieces,
      limits: {day: 0, payment: 0, allowance: 5},
    });
    const preRead = await readAndPlan({
      transceive,
      amountSat: 8,
      mintUrl: MINT_URL,
    });
    expect(preRead.pinRequired).toBe(true);
    // As if the till had believed the allowance covered it.
    const failure = await executeCharge({
      ...preRead,
      pinRequired: false,
      transceive,
      amountSat: 8,
      mintUrl: MINT_URL!,
    }).catch(e => e);
    expect(isPinNeededForPayment(failure)).toBe(true);
    expect(isPaidFailure(failure)).toBe(false);
    expect(await getBalance(transceive)).toBe(8);
    expect(await listSettlements()).toEqual([]);
  });

  // The simulator e2e's lost-load-answer flow, card side: the answer to the
  // first change LOAD is lost, then the keypad's balance tap (the tap after
  // a payment) finishes the rest under the change grant, with no PIN.
  it('a lost change LOAD answer, then the balance tap: the 4 once, the 1 under the change grant', async () => {
    const {pieces} = await mintToCard(cardKey, [8]);
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: pieces,
    });
    let loads = 0;
    const dropFirstLoadAnswer: Transceiver = async apdu => {
      const answer = await transceive(apdu);
      if (apdu[1] === 0x30 && ++loads === 1) {
        throw new Error('Tag was lost.');
      }
      return answer;
    };
    const preRead = await readAndPlan({
      transceive,
      amountSat: 3,
      mintUrl: MINT_URL,
    });
    const failure = await executeCharge({
      ...preRead,
      transceive: dropFirstLoadAnswer,
      amountSat: 3,
      pin: '1234',
      mintUrl: MINT_URL!,
    }).catch(e => e);
    expect(isPaidFailure(failure)).toBe(true);
    expect(await getBalance(transceive)).toBe(4);

    // The balance tap: a fresh SELECT, GET_INFO says the change may go on.
    const summary = await readCard(transceive);
    expect(summary.info.changeGrant).toBe(true);
    const record = await getCard(transceive);
    const owed = await reconcileOwedChange({
      transceive,
      cardPubkey: summary.pubkey,
      refundKey: record.refundKey,
      mintUrl: MINT_URL,
      now: Date.now(),
    });
    expect(owed.map(e => e.amount)).toEqual([1]);
    const written = await writeOwedChange({transceive, owed, now: Date.now()});
    expect(written.map(e => e.amount)).toEqual([1]);
    expect(await getBalance(transceive)).toBe(5);
    const state = (await bridge('/state')) as {
      slots: {status: string; nonce?: string}[];
    };
    const nonces = state.slots
      .filter(s => s.status !== 'empty')
      .map(s => s.nonce);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  // The simulator e2e's owed-change-next-tap flow, card side: the change
  // LOAD answers 6A84 on a full card; the card's spent slots are freed and a
  // 4 loaded on top (no reset: the openings stay); the next charge finishes
  // the owed 4 + 1 from the card's openings, then the 4 pays exactly.
  it("change owed on a full card is finished from the card's openings on the next charge", async () => {
    const fillers = Array.from({length: 127}, () => 1);
    const {pieces} = await mintToCard(cardKey, [8, ...fillers]);
    // The read plans on a card with room…
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: [pieces[0]],
    });
    const preRead = await readAndPlan({
      transceive,
      amountSat: 3,
      mintUrl: MINT_URL,
    });
    expect(preRead.plan).toMatchObject({slots: [0], changeSat: 5});
    // …which is full by the time the PIN is entered: same 8, every other
    // slot spent (the flow's FULL stage: /reset, then the fixture).
    await bridge('/reset', {});
    await bridge('/fixture', {
      pin: '1234',
      mint: MINT_URL,
      owner: true,
      proofs: pieces,
      spentSlots: fillers.map((_, i) => i + 1),
    });
    const failure = await executeCharge({
      ...preRead,
      transceive,
      amountSat: 3,
      pin: '1234',
      mintUrl: MINT_URL!,
    }).catch(e => e);
    expect(isPaidFailure(failure)).toBe(true);
    expect(String(failure.message)).toMatch(/card is full/);

    // The same card: SELECT (the tap after a payment), CLEAR_SPENT, then a 4.
    await transceive([
      0x00, 0xa4, 0x04, 0x00, 0x0a, 0xf0, 0x43, 0x41, 0x53, 0x48, 0x55, 0x43,
      0x41, 0x52, 0x44, 0x00,
    ]);
    const cleared = await transceive([0xb0, 0x31, 0x00, 0x00, 0x01]);
    expect(cleared.slice(-2)).toEqual([0x90, 0x00]);
    const four = await mintToCard(cardKey, [4]);
    await bridge('/fixture', {proofs: four.pieces});

    const next = await readAndPlan({
      transceive,
      amountSat: 4,
      mintUrl: MINT_URL,
    });
    expect(next.owedChange.map(e => e.amount)).toEqual([4, 1]);
    await executeCharge({
      ...next,
      transceive,
      amountSat: 4,
      pin: '1234',
      mintUrl: MINT_URL!,
    });
    expect(await getBalance(transceive)).toBe(5);
    expect((await listOwedChange()).every(e => e.status === 'written')).toBe(
      true,
    );
  });
});
