import NfcManager, {NfcTech} from 'react-native-nfc-manager';

import {
  cancelCardSession,
  describeCardFailure,
  isCardReadingSupported,
  nfcTransceiver,
  readCardOverNfc,
  withCardSession,
} from '../../src/services/cashuCardNfc';
import {CardError, CardProtocolError} from '../../src/services/cashuCard';

jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn(() => Promise.resolve(true)),
    isEnabled: jest.fn(() => Promise.resolve(true)),
    requestTechnology: jest.fn(() => Promise.resolve()),
    cancelTechnologyRequest: jest.fn(() => Promise.resolve()),
    isoDepHandler: {transceive: jest.fn()},
  },
  NfcTech: {IsoDep: 'IsoDep'},
}));

const mockNfc = NfcManager as unknown as {
  isSupported: jest.Mock;
  isEnabled: jest.Mock;
  requestTechnology: jest.Mock;
  cancelTechnologyRequest: jest.Mock;
  isoDepHandler: {transceive: jest.Mock};
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNfc.isSupported.mockResolvedValue(true);
  mockNfc.isEnabled.mockResolvedValue(true);
  mockNfc.requestTechnology.mockResolvedValue(undefined);
  mockNfc.cancelTechnologyRequest.mockResolvedValue(undefined);
});

describe('nfcTransceiver', () => {
  it('passes the APDU through and normalises the response to an array', async () => {
    mockNfc.isoDepHandler.transceive.mockResolvedValue([0x01, 0x90, 0x00]);
    const result = await nfcTransceiver([0xb0, 0x01, 0x00, 0x00, 0x00]);

    expect(mockNfc.isoDepHandler.transceive).toHaveBeenCalledWith([
      0xb0, 0x01, 0x00, 0x00, 0x00,
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([0x01, 0x90, 0x00]);
  });
});

describe('withCardSession', () => {
  it('requests IsoDep and tears the session down on success', async () => {
    const value = await withCardSession(async () => 'done');

    expect(mockNfc.requestTechnology).toHaveBeenCalledWith(
      NfcTech.IsoDep,
      expect.objectContaining({alertMessage: expect.any(String)}),
    );
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
    expect(value).toBe('done');
  });

  it('tears the session down even when the read throws', async () => {
    await expect(
      withCardSession(async () => {
        throw new Error('card yanked');
      }),
    ).rejects.toThrow('card yanked');

    // A stranded reader session blocks HCE and every later tap.
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let a teardown failure mask the original error', async () => {
    mockNfc.cancelTechnologyRequest.mockRejectedValue(new Error('teardown boom'));

    await expect(
      withCardSession(async () => {
        throw new CardError(0x6982, 'GET_PROOF');
      }),
    ).rejects.toThrow(/PIN required/);
  });

  it('swallows a teardown failure on the happy path', async () => {
    mockNfc.cancelTechnologyRequest.mockRejectedValue(new Error('teardown boom'));
    await expect(withCardSession(async () => 'ok')).resolves.toBe('ok');
  });

  it('does not cancel a session that was never established', async () => {
    mockNfc.requestTechnology.mockRejectedValue(new Error('no NFC'));
    await expect(withCardSession(async () => 'ok')).rejects.toThrow('no NFC');
    expect(mockNfc.cancelTechnologyRequest).not.toHaveBeenCalled();
  });

  it('honours a custom alert message', async () => {
    await withCardSession(async () => null, {alertMessage: 'Tap to pay'});
    expect(mockNfc.requestTechnology).toHaveBeenCalledWith(NfcTech.IsoDep, {
      alertMessage: 'Tap to pay',
    });
  });
});

describe('cancelCardSession', () => {
  // The escape hatch for a session withCardSession's own `finally` cannot
  // reach: requestTechnology stays pending until a tag arrives, and while it
  // is pending the native module swallows every BoltCard tap app-wide.
  it('cancels an in-flight technology request', async () => {
    await cancelCardSession();
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  });

  it('never throws when there is no session to cancel', async () => {
    mockNfc.cancelTechnologyRequest.mockRejectedValue(
      new Error('ERR_NO_TECH_REQ'),
    );
    await expect(cancelCardSession()).resolves.toBeUndefined();
  });
});

describe('readCardOverNfc', () => {
  it('drives a full read over the mocked card', async () => {
    mockNfc.isoDepHandler.transceive
      .mockResolvedValueOnce([1, 0, 0x90, 0x00]) // SELECT
      .mockResolvedValueOnce([1, 0, 32, 3, 1, 28, 0x03, 0x01, 0x90, 0x00]) // GET_INFO
      .mockResolvedValueOnce([
        0x02,
        ...Array.from({length: 32}, () => 0xab),
        0x90,
        0x00,
      ]) // GET_PUBKEY
      .mockResolvedValueOnce([0, 0, 0x01, 0xf4, 0x90, 0x00]); // GET_BALANCE

    const summary = await readCardOverNfc();

    expect(summary.appletVersion).toBe('1.0');
    expect(summary.info.unspent).toBe(3);
    expect(summary.balance).toBe(500);
    expect(summary.pubkey.startsWith('02')).toBe(true);
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  });

  it('closes the session when the applet is missing', async () => {
    mockNfc.isoDepHandler.transceive.mockResolvedValue([0x6a, 0x82]);
    await expect(readCardOverNfc()).rejects.toThrow(/applet not found/);
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  });
});

describe('isCardReadingSupported', () => {
  it('is true only when NFC is both supported and enabled', async () => {
    expect(await isCardReadingSupported()).toBe(true);

    mockNfc.isEnabled.mockResolvedValue(false);
    expect(await isCardReadingSupported()).toBe(false);
  });

  it('returns false instead of throwing when the bridge errors', async () => {
    mockNfc.isSupported.mockRejectedValue(new Error('no bridge'));
    expect(await isCardReadingSupported()).toBe(false);
  });
});

describe('describeCardFailure', () => {
  it('surfaces the card status word', () => {
    expect(describeCardFailure(new CardError(0x6983, 'SPEND_PROOF'))).toContain(
      'card locked',
    );
  });

  // A framing failure has no status word to report. It must render as its own
  // plain sentence, not "… failed: unexpected status word (0x0000)".
  it('renders a protocol error without inventing a status word', () => {
    const message = describeCardFailure(
      new CardProtocolError('GET_PUBKEY: expected 33 bytes, got 12'),
    );

    expect(message).toBe('GET_PUBKEY: expected 33 bytes, got 12');
    expect(message).not.toMatch(/status word/);
  });

  it('handles plain errors and non-errors', () => {
    expect(describeCardFailure(new Error('boom'))).toBe('boom');
    expect(describeCardFailure('nope')).toBe('Card read failed');
    expect(describeCardFailure(new Error(''))).toBe('Card read failed');
  });
});
