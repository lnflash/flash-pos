import {readTill, updateTill} from '../../src/services/cashuTillStore';
import {getSecureStrict, setSecure} from '../../src/services/secureStorage';
import type {SettledProof} from '../../src/services/cashuMint';
const mockStore: Record<string, string> = {};
jest.mock('../../src/services/secureStorage', () => ({
  getSecureStrict: jest.fn(async (k: string) => mockStore[k] ?? null),
  setSecure: jest.fn(async (k: string, v: string) => {
    mockStore[k] = v;
  }),
}));
const KEY = '@cashu_settled_proofs';
const p: SettledProof = {
  id: 'keyset',
  secret: 'output-secret',
  C: 'point',
  amount: 8,
  mintUrl: 'https://mint.example',
};
beforeEach(() => {
  for (const key of Object.keys(mockStore)) {
    delete mockStore[key];
  }
  jest.clearAllMocks();
});

test('legacy inventory migrates, repeated insertion and simultaneous writers credit once', async () => {
  const legacy = {...p};
  delete legacy.mintUrl;
  mockStore[KEY] = JSON.stringify([legacy, legacy]);
  await Promise.all([
    updateTill({add: [p]}),
    updateTill({add: [p, {...p, secret: 'other'}]}),
  ]);
  expect(await readTill()).toEqual([p, {...p, secret: 'other'}]);
});
test('payout/reconcile retirement prevents restored proofs returning after restart', async () => {
  await updateTill({add: [p]});
  await updateTill({retire: [p], add: [{...p, secret: 'change', amount: 2}]});
  // No process-local credit cache is involved; every operation rereads storage.
  await updateTill({add: [p]});
  expect(await readTill()).toEqual([{...p, secret: 'change', amount: 2}]);
  expect(JSON.parse(mockStore[KEY]).retired.length).toBeGreaterThan(0);
  expect(mockStore[KEY]).not.toContain('output-secret');
});
test('a failed atomic retirement retains old inventory and can be retried', async () => {
  await updateTill({add: [p]});
  jest.mocked(setSecure).mockRejectedValueOnce(new Error('locked'));
  await expect(updateTill({retire: [p]})).rejects.toThrow('locked');
  expect(await readTill()).toEqual([p]);
  await updateTill({retire: [p]});
  expect(await readTill()).toEqual([]);
});
test('conflicting identity, corruption and read failure preserve the stored evidence', async () => {
  await updateTill({add: [p]});
  const before = mockStore[KEY];
  await expect(updateTill({add: [{...p, amount: 16}]})).rejects.toThrow(
    'conflicting',
  );
  expect(mockStore[KEY]).toBe(before);
  jest.mocked(getSecureStrict).mockRejectedValueOnce(new Error('locked'));
  await expect(updateTill({add: [p]})).rejects.toThrow('locked');
  mockStore[KEY] = '{broken';
  await expect(updateTill({add: [p]})).rejects.toThrow();
  expect(mockStore[KEY]).toBe('{broken');
});

test('new secrets are checked across keysets and retired history, scoped by mint', async () => {
  const {assertFreshTillSecrets} = jest.requireActual(
    '../../src/services/cashuTillStore',
  );
  await updateTill({add: [p]});
  await expect(assertFreshTillSecrets([p])).rejects.toThrow(
    'already been used',
  );
  await updateTill({retire: [p], disposition: 'paid'});
  await expect(assertFreshTillSecrets([p])).rejects.toThrow(
    'already been used',
  );
  const other = {...p, mintUrl: 'https://other.example'};
  await expect(assertFreshTillSecrets([other])).resolves.toBeUndefined();
  await updateTill({add: [other]});
  expect(await readTill()).toEqual([other]);
});
