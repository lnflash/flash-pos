import {configureStore} from '@reduxjs/toolkit';
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils';
import pinReducer, {
  authenticatePin,
  loadPinState,
  removePin,
  setPin,
} from '../../src/store/slices/pinSlice';

const mockSecureStore = new Map<string, string>();
const mockPbkdf2Async = jest.fn(
  async (
    _hash: unknown,
    password: Uint8Array,
    salt: Uint8Array,
    opts: {c: number; dkLen?: number; asyncTick?: number},
  ) => {
    const outputLength = opts.dkLen || 32;
    const output = new Uint8Array(outputLength);
    let seed = opts.c;

    for (const byte of password) {
      seed = (seed + byte) % 256;
    }

    for (const byte of salt) {
      seed = (seed + byte) % 256;
    }

    output.fill(seed);
    return output;
  },
);

jest.mock('../../src/services/secureStorage', () => ({
  setSecure: jest.fn((key: string, value: string) => {
    mockSecureStore.set(key, value);
    return Promise.resolve();
  }),
  getSecure: jest.fn((key: string) =>
    Promise.resolve(mockSecureStore.get(key) ?? null),
  ),
  removeSecure: jest.fn((key: string) => {
    mockSecureStore.delete(key);
    return Promise.resolve();
  }),
}));

jest.mock('@noble/hashes/pbkdf2', () => ({
  pbkdf2Async: (
    hash: unknown,
    password: Uint8Array,
    salt: Uint8Array,
    opts: {c: number; dkLen?: number; asyncTick?: number},
  ) => mockPbkdf2Async(hash, password, salt, opts),
}));

const PIN_RECORD_KEY = '@flash-pos-pin-hash';
const PIN_SALT_KEY = '@flash-pos-pin-device-salt';

const createTestStore = () =>
  configureStore({
    reducer: {
      pin: pinReducer,
    },
  });

const createLegacyHash = async (
  pin: string,
  salt: string,
  iterations: number,
) => {
  return bytesToHex(
    await mockPbkdf2Async(null, utf8ToBytes(pin), hexToBytes(salt), {
      c: iterations,
      dkLen: 32,
      asyncTick: 2,
    }),
  );
};

describe('pinSlice', () => {
  beforeEach(() => {
    mockSecureStore.clear();
    mockPbkdf2Async.mockClear();
  });

  it('stores new PIN records with the interactive async hash settings', async () => {
    const store = createTestStore();

    await store.dispatch(setPin('1234'));

    const storedRecord = JSON.parse(mockSecureStore.get(PIN_RECORD_KEY) || '{}');
    expect(storedRecord.algorithm).toBe('pbkdf2-sha256');
    expect(storedRecord.iterations).toBe(10000);
    expect(mockPbkdf2Async).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Uint8Array),
      expect.any(Uint8Array),
      expect.objectContaining({
        c: 10000,
        asyncTick: 2,
        dkLen: 32,
      }),
    );
    expect(store.getState().pin.hasPin).toBe(true);
  });

  it('authenticates and migrates legacy high-iteration PIN records', async () => {
    const store = createTestStore();
    const legacySalt =
      '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
    const legacyHash = await createLegacyHash('1234', legacySalt, 100000);

    mockSecureStore.set(
      PIN_RECORD_KEY,
      JSON.stringify({
        version: 1,
        algorithm: 'pbkdf2-sha256',
        iterations: 100000,
        salt: legacySalt,
        hash: legacyHash,
      }),
    );

    const authenticated = await store.dispatch(authenticatePin('1234')).unwrap();

    expect(authenticated).toBe(true);
    const migratedRecord = JSON.parse(
      mockSecureStore.get(PIN_RECORD_KEY) || '{}',
    );
    expect(migratedRecord.iterations).toBe(10000);
    expect(store.getState().pin.isAuthenticated).toBe(true);
  });

  it('removes PIN records from secure storage', async () => {
    const store = createTestStore();

    await store.dispatch(setPin('1234'));
    await store.dispatch(removePin());
    await store.dispatch(loadPinState());

    expect(mockSecureStore.has(PIN_RECORD_KEY)).toBe(false);
    expect(mockSecureStore.has(PIN_SALT_KEY)).toBe(false);
    expect(store.getState().pin.hasPin).toBe(false);
  });
});
