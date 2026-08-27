import NfcManager, {NfcError, NfcTech} from 'react-native-nfc-manager';

import {
  cancelCardSession,
  describeCardFailure,
  isUserCancel,
  isCardReadingSupported,
  nfcTransceiver,
  readCardOverNfc,
  withCardSession,
} from '../../src/services/cashuCardNfc';
import {CardError, CardProtocolError} from '../../src/services/cashuCard';

// The bridge is stubbed, but `NfcError` is the *real* class hierarchy: the
// describeCardFailure tests below assert on `instanceof`, so hand-rolled
// look-alikes would pass while a rename upstream shipped a silent regression.
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
  NfcError: jest.requireActual('react-native-nfc-manager/src/NfcError'),
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

    // A stranded session swallows every later tap, app-wide.
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let a teardown failure mask the original error', async () => {
    mockNfc.cancelTechnologyRequest.mockRejectedValue(
      new Error('teardown boom'),
    );

    await expect(
      withCardSession(async () => {
        throw new CardError(0x6982, 'GET_PROOF');
      }),
    ).rejects.toThrow(/PIN required/);
  });

  it('swallows a teardown failure on the happy path', async () => {
    mockNfc.cancelTechnologyRequest.mockRejectedValue(
      new Error('teardown boom'),
    );
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

  // Every nfc-manager error class is constructed with no arguments, so
  // `error.message` is the empty string for all of them. Without a class-based
  // map, "you cancelled", "the radio is off" and "the card moved" all render as
  // the same four words — on the one screen whose entire job is telling
  // hardware failure modes apart.
  describe('NFC transport errors', () => {
    it.each([
      ['UserCancel', () => new NfcError.UserCancel(), 'Read cancelled'],
      [
        'RadioDisabled',
        () => new NfcError.RadioDisabled(),
        'NFC is turned off',
      ],
      [
        'TagConnectionLost',
        () => new NfcError.TagConnectionLost(),
        'Card left the field — hold it still',
      ],
      [
        'TagNotConnected',
        () => new NfcError.TagNotConnected(),
        'Card left the field — hold it still',
      ],
      [
        'RetryExceeded',
        () => new NfcError.RetryExceeded(),
        'Card stopped responding — hold it still',
      ],
      [
        'TagResponseError',
        () => new NfcError.TagResponseError(),
        'The card returned a malformed response',
      ],
      ['Timeout', () => new NfcError.Timeout(), 'Timed out waiting for a tap'],
      [
        'SessionInvalidated',
        () => new NfcError.SessionInvalidated(),
        'NFC session ended — try again',
      ],
      [
        'SystemBusy',
        () => new NfcError.SystemBusy(),
        'NFC is busy — wait a moment and try again',
      ],
      [
        'UnsupportedFeature',
        () => new NfcError.UnsupportedFeature(),
        'This device cannot read ISO 7816 cards',
      ],
    ])('describes %s distinctly', (_name, build, expected) => {
      expect(describeCardFailure(build())).toBe(expected);
    });

    it('gives every mapped class a distinct message where the causes differ', () => {
      const messages = [
        describeCardFailure(new NfcError.UserCancel()),
        describeCardFailure(new NfcError.RadioDisabled()),
        describeCardFailure(new NfcError.TagConnectionLost()),
        describeCardFailure(new NfcError.Timeout()),
        describeCardFailure(new NfcError.SystemBusy()),
      ];
      expect(new Set(messages).size).toBe(messages.length);
      expect(messages).not.toContain('Card read failed');
    });

    // Unmapped but still message-less: naming the class beats a generic
    // sentence, and it points straight at the branch that needs adding.
    it('falls back to the class name for an unmapped NFC error', () => {
      expect(describeCardFailure(new NfcError.SecurityViolation())).toBe(
        'SecurityViolation',
      );
    });

    // The base class is the one that does carry the native error string.
    it('prefers a real message over the class name', () => {
      expect(
        describeCardFailure(new NfcError.NfcErrorBase('ERR_MULTI_REQ')),
      ).toBe('ERR_MULTI_REQ');
    });
  });
});

describe('isUserCancel', () => {
  it('is true for a UserCancel — the iOS system sheet\'s Cancel lands here', () => {
    expect(isUserCancel(new NfcError.UserCancel())).toBe(true);
  });

  it('is false for every other NFC failure', () => {
    expect(isUserCancel(new NfcError.RadioDisabled())).toBe(false);
    expect(isUserCancel(new NfcError.TagConnectionLost())).toBe(false);
    expect(isUserCancel(new NfcError.Timeout())).toBe(false);
  });

  it('is false for plain errors and non-errors', () => {
    expect(isUserCancel(new Error('boom'))).toBe(false);
    expect(isUserCancel('cancel')).toBe(false);
    expect(isUserCancel(null)).toBe(false);
  });
});
