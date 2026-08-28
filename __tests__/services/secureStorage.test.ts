import * as Keychain from 'react-native-keychain';

import {
  getSecure,
  getSecureStrict,
  removeSecure,
  setSecure,
} from '../../src/services/secureStorage';

jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn(),
  getGenericPassword: jest.fn(),
  resetGenericPassword: jest.fn(),
}));

const mockedKeychain = Keychain as jest.Mocked<typeof Keychain>;

describe('secureStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores values in a key-scoped keychain service', async () => {
    await setSecure('test-key', 'secret-value');

    expect(mockedKeychain.setGenericPassword).toHaveBeenCalledWith(
      'test-key',
      'secret-value',
      {service: 'test-key'},
    );
  });

  it('returns a stored value from keychain credentials', async () => {
    mockedKeychain.getGenericPassword.mockResolvedValue({
      service: 'test-key',
      username: 'test-key',
      password: 'secret-value',
    } as Keychain.UserCredentials);

    await expect(getSecure('test-key')).resolves.toBe('secret-value');
    expect(mockedKeychain.getGenericPassword).toHaveBeenCalledWith({
      service: 'test-key',
    });
  });

  it('returns null when no keychain value exists', async () => {
    mockedKeychain.getGenericPassword.mockResolvedValue(false);

    await expect(getSecure('missing-key')).resolves.toBeNull();
  });

  it('returns null when keychain read fails', async () => {
    mockedKeychain.getGenericPassword.mockRejectedValue(new Error('locked'));

    await expect(getSecure('test-key')).resolves.toBeNull();
  });

  // Callers holding money need to tell "nothing stored" from "could not read".
  // Flattening a Keychain failure to null is how an outstanding-payment queue
  // gets silently overwritten with an empty one.
  it('getSecureStrict rethrows a keychain failure instead of reporting absence', async () => {
    mockedKeychain.getGenericPassword.mockRejectedValue(new Error('locked'));

    await expect(getSecureStrict('test-key')).rejects.toThrow('locked');
  });

  it('getSecureStrict still returns null for a genuinely absent key', async () => {
    mockedKeychain.getGenericPassword.mockResolvedValue(false);

    await expect(getSecureStrict('missing-key')).resolves.toBeNull();
  });

  it('getSecureStrict returns the stored value', async () => {
    mockedKeychain.getGenericPassword.mockResolvedValue({
      service: 'test-key',
      username: 'test-key',
      password: 'secret-value',
    } as Keychain.UserCredentials);

    await expect(getSecureStrict('test-key')).resolves.toBe('secret-value');
  });

  it('removes values from the key-scoped keychain service', async () => {
    await removeSecure('test-key');

    expect(mockedKeychain.resetGenericPassword).toHaveBeenCalledWith({
      service: 'test-key',
    });
  });
});
