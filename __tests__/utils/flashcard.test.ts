import {Alert} from 'react-native';
import NfcManager, {NfcError} from 'react-native-nfc-manager';

import {readFlashcard} from '../../src/utils/flashcard';

// The bridge is stubbed; `NfcError` is the real class hierarchy so that
// `isUserCancel` sees a genuine `UserCancel` (the same shape
// useCardPaymentRouter.test.ts relies on).
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    isSupported: jest.fn(() => Promise.resolve(true)),
    isEnabled: jest.fn(() => Promise.resolve(true)),
    requestTechnology: jest.fn(() => Promise.resolve()),
    getTag: jest.fn(() => Promise.resolve(null)),
    cancelTechnologyRequest: jest.fn(() => Promise.resolve()),
  },
  NfcTech: {Ndef: 'Ndef', IsoDep: 'IsoDep'},
  NfcError: jest.requireActual('react-native-nfc-manager/src/NfcError'),
}));

const mockNfc = NfcManager as jest.Mocked<typeof NfcManager>;

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockNfc.isSupported.mockResolvedValue(true);
  mockNfc.isEnabled.mockResolvedValue(true);
  mockNfc.requestTechnology.mockResolvedValue(null);
  mockNfc.getTag.mockResolvedValue(null);
  mockNfc.cancelTechnologyRequest.mockResolvedValue(undefined);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('readFlashcard (Rewards screen)', () => {
  it('returns the tag and closes the session on a good read', async () => {
    const tag = {id: '04A1B2C3D4E5F6', ndefMessage: []};
    mockNfc.getTag.mockResolvedValue(tag as never);

    await expect(readFlashcard()).resolves.toBe(tag);

    expect(mockNfc.requestTechnology).toHaveBeenCalledWith('Ndef');
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a merchant cancelling the tap sheet is not an error: no alert, session closed', async () => {
    mockNfc.requestTechnology.mockRejectedValue(new NfcError.UserCancel());

    await expect(readFlashcard()).resolves.toBeUndefined();

    expect(alertSpy).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
  });

  it('any other read failure still alerts once and closes the session', async () => {
    mockNfc.requestTechnology.mockRejectedValue(new Error('boom'));

    await expect(readFlashcard()).resolves.toBeUndefined();

    expect(alertSpy).toHaveBeenCalledTimes(1);
    // The alert text is interleaved with zero-width spaces in the source.
    expect(String(alertSpy.mock.calls[0][0]).replace(/\u200b/g, '')).toMatch(
      /Error reading NFC tag/,
    );
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
  });

  it('refuses before opening a session when NFC is off', async () => {
    mockNfc.isEnabled.mockResolvedValue(false);

    await expect(readFlashcard()).resolves.toBeUndefined();

    expect(alertSpy).toHaveBeenCalledWith('NFC is not enabled on this device.');
    expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
  });
});
