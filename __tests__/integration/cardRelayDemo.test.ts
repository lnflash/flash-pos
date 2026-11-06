/**
 * ENG-821: an offline card charge relayed by a phone, then recovered by the
 * till, against the REAL 2.2 applet and a REAL mint.
 *
 * - The card: cashu-card's tools/cardsim (CashuApplet 2.2 in jCardSim over
 *   HTTP), whose SPEND_ALL_SIGN writes the payment's outbox record.
 * - The till: the production readAndPlan → executeCharge path, with the swap
 *   request kept from the mint (the till is offline), so the payment is
 *   queued with its recovery intent; later the production drain
 *   (settlePending: checkState → recover) books its proceeds.
 * - The phone: scripts/card-relay/phone.cjs in its own Node process, given
 *   only its public folder. It reads the packet with GET_OUTBOX and settles
 *   it with cashu-card's tools/assisted-relay/relay.js (capturePacket,
 *   decodePacket, reconcilePayment).
 * - The mint: Nutshell 0.20.3 on FakeWallet with an 8-byte keyset (forge's
 *   shape; a 2.2 packet carries 8-byte keyset ids, see the README below).
 *
 * The card's record holds the logical mint https://cashucard-relay.invalid
 * (a 2.2 card leaves no record for a mint that is not https); the phone maps
 * that exact name to the local mint, as cashu-card's run-local.cjs does, and
 * the till charges against the local mint's origin.
 *
 * Skipped unless all three are given. One command, from the repo root, with
 * Docker, JDK 17 and Maven:
 *
 *   scripts/card-relay/run-local.sh /absolute/path/to/cashucard-checkout
 */
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {writeFileSync} from 'node:fs';

import {
  blindMessage,
  hashToCurve,
  Mint,
  pointFromHex,
  unblindSignature,
} from '@cashu/cashu-ts';
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils';

import {installLocalFetch} from '../support/localFetch';
import {selectApplet, type Transceiver} from '../../src/services/cashuCard';
import {
  __resetWalletCache,
  buildCardSigAllSecret,
  createSettlementAdapter,
  listSettledProofs,
  refreshKeysets,
} from '../../src/services/cashuMint';
import {executeCharge, readAndPlan} from '../../src/services/cashuCharge';
import {settlePending} from '../../src/services/cashuSpend';
import {
  __resetDrainState,
  clearQueue,
  listSettlements,
  type SettlementEntry,
} from '../../src/services/cashuSettlement';

const CARDSIM = process.env.CARD_RELAY_CARDSIM;
const MINT_URL = process.env.CARD_RELAY_MINT;
const CASHU_CARD = process.env.CARD_RELAY_CASHU_CARD;
const run = CARDSIM && MINT_URL && CASHU_CARD ? describe : describe.skip;

const LOGICAL_MINT = 'https://cashucard-relay.invalid';
const PHONE = resolve(__dirname, '../../scripts/card-relay/phone.cjs');

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

jest.setTimeout(180_000);

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
  // A 2.2 packet names every keyset by 8 bytes; the relay engine looks them
  // up in the mint's catalogue as given.
  expect(keyset.id).toHaveLength(16);
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
  return signatures.map((sig, i) => {
    const b = blinded[i];
    return {
      keysetId: keyset.id,
      amount: b.amount,
      nonce: b.nonce,
      C: unblindSignature(
        pointFromHex(sig.C_),
        b.r,
        pointFromHex(keys[String(b.amount)]),
      ).toHex(true),
      dleq: {
        e: sig.dleq!.e,
        s: sig.dleq!.s,
        r: b.r.toString(16).padStart(64, '0'),
      },
    };
  });
}

/** The mint's NUT-07 state of each secret, in order. */
async function mintStates(secrets: string[]): Promise<string[]> {
  const {states} = (await new Mint(MINT_URL!).check({
    Ys: secrets.map(s => bytesToHex(hashToCurve(utf8ToBytes(s)).toBytes(true))),
  } as never)) as {states: {state: string}[]};
  return states.map(s => s.state);
}

const read = (folder: string, name: string) =>
  JSON.parse(readFileSync(join(folder, name), 'utf8'));

/** The phone, in its own process, synchronously. */
function phone(folder: string, mode: 'capture' | 'settle' | 'replay') {
  const r = spawnSync(
    process.execPath,
    [PHONE, CASHU_CARD!, folder, CARDSIM!, MINT_URL!, mode],
    {encoding: 'utf8', timeout: 90_000},
  );
  if (r.status !== 0) {
    throw new Error(`phone ${mode} failed: ${r.stdout}${r.stderr}`);
  }
  return read(folder, `${mode}-result.json`);
}

function phoneFolder(): string {
  // Private (0700): the phone's journal refuses any other directory.
  return mkdtempSync(join(tmpdir(), 'eng821-phone-'));
}

const sum = (proofs: {amount: number}[]) =>
  proofs.reduce((t, p) => t + p.amount, 0);

/**
 * An exact 12-sat bill from two pieces (8 + 4), paid by the till while the
 * swap request cannot leave it: the card signs, its record is written, and
 * the payment waits in the queue with its recovery intent.
 */
async function chargeOffline(): Promise<SettlementEntry> {
  const cardKey = ((await bridge('/reset', {})) as {pubkey: string}).pubkey;
  const pieces = await mintToCard(cardKey, [8, 4]);
  await bridge('/fixture', {mint: LOGICAL_MINT, owner: true, proofs: pieces});
  // The till has seen this mint: an offline charge needs its keys cached.
  expect(await refreshKeysets(MINT_URL!)).toBe(true);
  // ENG-821 change 1: the till takes the 2.2 card's SELECT answer as it
  // takes 2.1's.
  expect(await selectApplet(transceive)).toEqual([2, 2]);

  const preRead = await readAndPlan({
    transceive,
    amountSat: 12,
    mintUrl: MINT_URL,
  });
  expect(preRead.requiresOnline).toBe(false);
  expect(preRead.plan).toMatchObject({changeSat: 0});
  const online = global.fetch;
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/swap')) {
      throw new TypeError('Network request failed');
    }
    return online(url, init);
  }) as typeof fetch;
  try {
    const result = await executeCharge({
      ...preRead,
      transceive,
      amountSat: 12,
      mintUrl: MINT_URL!,
    });
    expect(result.changeSat).toBe(0);
  } finally {
    global.fetch = online;
  }
  const [entry] = await listSettlements();
  expect(entry).toMatchObject({
    status: 'pending',
    sigflag: 'SIG_ALL',
    amount: 12,
    mintUrl: MINT_URL,
  });
  expect(entry.witness).toBeTruthy();
  expect(entry.inputs).toHaveLength(2);
  expect(sum(entry.outputs)).toBe(12);
  expect(await listSettledProofs()).toEqual([]);
  return entry;
}

/** What the phone read off the card is exactly the payment the till queued. */
function expectPacketIsTheTillsPayment(
  captured: Record<string, any>,
  entry: SettlementEntry,
) {
  expect(captured.select).toBe('0202');
  expect(captured.mint).toBe(LOGICAL_MINT);
  expect(captured.cardKey).toBe(entry.cardPubkey);
  expect(captured.witness).toBe(entry.witness);
  expect(captured.paymentMessage).toBe(entry.message!.toLowerCase());
  expect(captured.inputs.map((i: {secret: string}) => i.secret)).toEqual(
    entry.inputs.map(i => i.secret),
  );
  expect(captured.outputs).toEqual(
    entry.outputs.map(o => ({amount: o.amount, id: o.keysetId, B_: o.B_})),
  );
}

/** None of the till's private openings reached the phone's folder. */
function expectPhoneHoldsNoOpenings(folder: string, entry: SettlementEntry) {
  const everything = readdirSync(folder)
    .map(name => readFileSync(join(folder, name), 'utf8'))
    .join('\n');
  expect(entry.merchantBlinding.length).toBe(entry.outputs.length);
  for (const opening of entry.merchantBlinding) {
    expect(everything).not.toContain(opening.secret);
    expect(everything).not.toContain(opening.r);
  }
}

run('a 2.2 card payment relayed by a phone, recovered by the till', () => {
  let restoreFetch: (() => void) | undefined;
  beforeAll(() => {
    restoreFetch = installLocalFetch([CARDSIM!, MINT_URL!]);
  });
  afterAll(() => {
    restoreFetch?.();
  });

  beforeEach(async () => {
    for (const k of Object.keys(mockStore)) {
      delete mockStore[k];
    }
    __resetWalletCache();
    __resetDrainState();
    await clearQueue();
  });

  it('the phone settles from GET_OUTBOX; the till recovers the exact outputs once, and a second drain changes nothing', async () => {
    const entry = await chargeOffline();
    const folder = phoneFolder();

    expectPacketIsTheTillsPayment(phone(folder, 'capture'), entry);
    // The phone's one swap is accepted, its answer lost: it confirms the
    // outputs by restore.
    expect(phone(folder, 'settle')).toMatchObject({
      state: 'outputs-confirmed',
      inputsSpent: true,
      outputs: entry.outputs.length,
      swapCalls: 1,
    });
    expect(await listSettledProofs()).toEqual([]);

    // The till comes online: its drain finds the inputs spent and recovers
    // its own outputs from its recovery intent.
    const first = await settlePending();
    expect(first).toMatchObject({settled: 1, stillPending: 0, failed: 0});
    const [after] = await listSettlements();
    expect(after.status).toBe('settled');
    const till = await listSettledProofs();
    expect(sum(till)).toBe(12);
    expect(till).toHaveLength(entry.outputs.length);
    expect(new Set(till.map(p => p.secret)).size).toBe(till.length);

    // A second drain, and recovery run again (twice at once), credit nothing.
    const second = await settlePending();
    expect(second).toMatchObject({settled: 0, stillPending: 0, failed: 0});
    const adapter = createSettlementAdapter();
    await Promise.all([adapter.recover(after), adapter.recover(after)]);
    expect(await listSettledProofs()).toEqual(till);
    expect((await listSettlements())[0].status).toBe('settled');

    // The phone, asked again, submits nothing.
    expect(phone(folder, 'replay')).toMatchObject({
      state: 'outputs-confirmed',
      swapCalls: 0,
    });

    // At the mint: every input spent, the till's proceeds unspent and its own.
    expect(await mintStates(entry.inputs.map(i => i.secret))).toEqual([
      'SPENT',
      'SPENT',
    ]);
    expect(await mintStates(till.map(p => p.secret))).toEqual(
      till.map(() => 'UNSPENT'),
    );
    expectPhoneHoldsNoOpenings(folder, entry);
  });

  /**
   * The phone and the till both find the inputs unspent and both submit the
   * payment's one swap. `order` says how the till's request meets the
   * phone's: released together (`together`), or held until the mint has
   * answered the phone (`phone-first`: the till's swap arrives with its
   * outputs already signed for the phone).
   */
  async function race(order: 'together' | 'phone-first') {
    const entry = await chargeOffline();
    const folder = phoneFolder();
    expectPacketIsTheTillsPayment(phone(folder, 'capture'), entry);

    const child = spawn(
      process.execPath,
      [PHONE, CASHU_CARD!, folder, CARDSIM!, MINT_URL!, 'race'],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let output = '';
    child.stdout.on('data', v => (output += v));
    child.stderr.on('data', v => (output += v));
    const exited = new Promise<number | null>(done =>
      child.once('exit', code => done(code)),
    );
    const waitFor = async (name: string) => {
      const started = Date.now();
      while (!existsSync(join(folder, name))) {
        if (Date.now() - started > 30_000) {
          throw new Error(`the phone never wrote ${name}`);
        }
        await new Promise(r => setTimeout(r, 10));
      }
    };

    const local = global.fetch;
    let tillSwaps = 0;
    global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/swap')) {
        tillSwaps += 1;
        await waitFor('race-ready.json');
        writeFileSync(join(folder, 'race-go.json'), '{}', {mode: 0o600});
        if (order === 'phone-first') {
          await waitFor('race-done.json');
        }
      }
      return local(url, init);
    }) as typeof fetch;
    let drains;
    try {
      drains = [await settlePending()];
    } finally {
      global.fetch = local;
    }
    const code = await exited;
    if (code !== 0) {
      throw new Error(`phone race failed: ${output}`);
    }
    expect(tillSwaps).toBe(1);
    const raced = read(folder, 'race-result.json');
    expect(raced).toMatchObject({state: 'outputs-confirmed', swapCalls: 1});
    // What the phone rode out while the other swap was in flight (the relay
    // engine's settlement-unresolved: restore had the outputs before
    // checkstate had the inputs spent). Logged for the PR's evidence.
    console.log(
      `[ENG-821] race (${order}): phone retried ${
        raced.unresolved.length
      }: ${JSON.stringify(raced.unresolved)}`,
    );
    return {entry, folder, drains};
  }

  /** After a race: settled once, nothing more on later drains or replays. */
  async function expectConverged(entry: SettlementEntry, folder: string) {
    expect((await listSettlements())[0].status).toBe('settled');
    const till = await listSettledProofs();
    expect(sum(till)).toBe(12);
    expect(till).toHaveLength(entry.outputs.length);
    expect(new Set(till.map(p => p.secret)).size).toBe(till.length);

    expect(await settlePending()).toMatchObject({settled: 0, failed: 0});
    expect(await listSettledProofs()).toEqual(till);
    expect(phone(folder, 'replay')).toMatchObject({swapCalls: 0});
    expect(await mintStates(entry.inputs.map(i => i.secret))).toEqual([
      'SPENT',
      'SPENT',
    ]);
    expect(await mintStates(till.map(p => p.secret))).toEqual(
      till.map(() => 'UNSPENT'),
    );
    expectPhoneHoldsNoOpenings(folder, entry);
  }

  it('the phone and the till submit the same swap at once: both converge, the till credits once', async () => {
    const {entry, folder, drains} = await race('together');
    // Whichever swap the mint took, the till settles: by its own swap's
    // answer, by recovering its outputs after "already spent" (11001), or,
    // when its swap met the phone's still in flight ("proofs are pending",
    // 11002), on the next drain, the entry outstanding until then. Never
    // failed (the defect this case found).
    if (drains[0].settled === 0) {
      expect(drains[0]).toMatchObject({stillPending: 1, failed: 0});
      expect((await listSettlements())[0].status).toBe('submitting');
      drains.push(await settlePending());
    }
    console.log(`[ENG-821] race (together): till drains ${drains.length}`);
    expect(drains.reduce((t, d) => t + d.settled, 0)).toBe(1);
    expect(drains.every(d => d.failed === 0)).toBe(true);
    await expectConverged(entry, folder);
  });

  it("the phone's swap lands while the till's is on its way: the till recovers in the same drain, never failed", async () => {
    const {entry, folder, drains} = await race('phone-first');
    expect(drains[0]).toMatchObject({settled: 1, stillPending: 0, failed: 0});
    await expectConverged(entry, folder);
  });
});
