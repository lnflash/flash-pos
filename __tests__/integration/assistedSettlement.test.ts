import {installLocalFetch} from '../support/localFetch';
/** Optional local FakeWallet test: real SDK, HTTP mint, DLEQ and inventory. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Wallet} from '@cashu/cashu-ts';
import {bytesToHex} from '@noble/hashes/utils';
import {
  createSettlementAdapter,
  listSettledProofs,
  prepareChargeOutputs,
  sigAllMessage,
} from '../../src/services/cashuMint';
import {
  drainQueue,
  recordSpend,
  type SettlementEntry,
} from '../../src/services/cashuSettlement';

const mockStore: Record<string, string> = {};
jest.mock('../../src/services/secureStorage', () => ({
  getSecureStrict: jest.fn(async (key: string) => mockStore[key] ?? null),
  getSecure: jest.fn(async (key: string) => mockStore[key] ?? null),
  setSecure: jest.fn(async (key: string, value: string) => {
    mockStore[key] = value;
  }),
  removeSecure: jest.fn(async (key: string) => {
    delete mockStore[key];
  }),
}));
type Preparation = {
  mintOrigin: string;
  pubkey: string;
  merchantAmount: number;
  feePpk: number;
  inputs: {id: string; amount: number; secret: string; C: string}[];
  outputs: {id: string; amount: number; B_: string}[];
  openings: {secret: string; r: string}[];
};
const directory = process.env.LOCAL_ASSISTED_JOURNAL;
const localTest = directory ? it : it.skip;

localTest(
  'recovers an externally relayed payment after mint restart through the real SDK',
  async () => {
    const preparation: Preparation = JSON.parse(
      readFileSync(join(directory!, 'merchant-prepared.json'), 'utf8'),
    );
    const packet: {kind: string; pubkey: string; inputs: {witness?: string}[]} =
      JSON.parse(readFileSync(join(directory!, 'relay-packet.json'), 'utf8'));
    expect(packet.kind).toBe('local-rehearsal-only');
    expect(packet.pubkey === preparation.pubkey).toBe(true);
    const origin = new URL(preparation.mintOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      !['3338', '3339', '4338', '4339'].includes(origin.port)
    ) {
      throw new Error('local FakeWallet mint required');
    }
    const restoreFetch = installLocalFetch([origin.origin]);
    try {
      const inputs = preparation.inputs.map((p, slot) => ({
        ...p,
        slot,
        keysetId: p.id,
        nonce: (JSON.parse(p.secret) as [string, {nonce: string}])[1].nonce,
      }));
      const outputs = preparation.outputs.map(o => ({...o, keysetId: o.id}));
      const witness = (
        JSON.parse(packet.inputs[0].witness!) as {signatures: string[]}
      ).signatures[0];
      const first = inputs[0];
      const record = {
        cardPubkey: preparation.pubkey,
        slot: 0,
        nonce: first.nonce,
        secret: first.secret,
        keysetId: first.keysetId,
        C: first.C,
        amount: inputs.reduce((sum, p) => sum + p.amount, 0),
        unit: 'sat',
        mintUrl: origin.origin,
        sigflag: 'SIG_ALL' as const,
        inputs,
        outputs,
        merchantBlinding: preparation.openings,
        witness,
        message: bytesToHex(sigAllMessage(inputs, outputs)),
      };
      const entry: SettlementEntry = await recordSpend(record, Date.now());
      const adapter = createSettlementAdapter();
      const result = await drainQueue(adapter.swap, Date.now(), {
        checkState: adapter.checkState,
        recover: adapter.recover,
      });
      expect(result.settled).toBe(1);
      await adapter.recover(entry);
      const funds = await listSettledProofs();
      expect(funds.length).toBe(outputs.length);
      expect(funds.reduce((sum, p) => sum + p.amount, 0)).toBe(
        preparation.merchantAmount,
      );

      // Consume those merchant outputs elsewhere. Restore still returns their
      // valid promises, but this till has no successful payout record for them.
      const wallet = new Wallet(origin.origin, {unit: 'sat'});
      await wallet.loadMint();
      const fee = Math.ceil((funds.length * preparation.feePpk) / 1000);
      const replacement = prepareChargeOutputs({
        keysetId: outputs[0].keysetId,
        merchantSat: preparation.merchantAmount - fee,
      });
      await wallet.mint.swap({
        inputs: funds as never,
        outputs: replacement.outputs.map(o => ({
          id: o.keysetId,
          amount: o.amount,
          B_: o.B_,
        })) as never,
      });
      await expect(adapter.recover(entry)).rejects.toThrow(
        'payout reconciliation',
      );
      expect((await listSettledProofs()).length).toBe(0);
    } finally {
      restoreFetch();
    }
  },
  60000,
);

it('guards local integrations from external origins before network IO', async () => {
  expect(() => installLocalFetch(['https://example.invalid'])).toThrow(
    'local HTTP',
  );
  const restore = installLocalFetch(['http://127.0.0.1:4338']);
  try {
    await expect(fetch('https://example.invalid/v1/restore')).rejects.toThrow(
      'local integration network boundary',
    );
  } finally {
    restore();
  }
});
