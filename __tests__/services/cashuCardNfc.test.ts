import {Platform} from 'react-native';
import NfcManager, {NfcError, NfcTech} from 'react-native-nfc-manager';

import {
  CARD_TRANSCEIVE_TIMEOUT_MS,
  cancelCardSession,
  describeCardFailure,
  extendCardTimeout,
  isUserCancel,
  isCardReadingSupported,
  nfcTransceiver,
  openCardSession,
  readCardOverNfc,
  setCardSessionMessage,
  usingCardBridge,
  withCardSession,
} from '../../src/services/cashuCardNfc';
import {BRIDGE_TAG, setCardBridge} from '../../src/services/cardBridge';
import {CardError, CardProtocolError} from '../../src/services/cashuCard';
import {recordApdu} from '../../src/services/apduTiming';

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
    setTimeout: jest.fn(() => Promise.resolve()),
    getTag: jest.fn(() => Promise.resolve(null)),
    isoDepHandler: {transceive: jest.fn()},
  },
  NfcTech: {IsoDep: 'IsoDep', Ndef: 'Ndef'},
  NfcError: jest.requireActual('react-native-nfc-manager/src/NfcError'),
}));

const mockNfc = NfcManager as unknown as {
  isSupported: jest.Mock;
  isEnabled: jest.Mock;
  requestTechnology: jest.Mock;
  cancelTechnologyRequest: jest.Mock;
  setTimeout: jest.Mock;
  getTag: jest.Mock;
  isoDepHandler: {transceive: jest.Mock};
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNfc.isSupported.mockResolvedValue(true);
  mockNfc.isEnabled.mockResolvedValue(true);
  mockNfc.requestTechnology.mockResolvedValue(undefined);
  mockNfc.cancelTechnologyRequest.mockResolvedValue(undefined);
  mockNfc.setTimeout.mockResolvedValue(undefined);
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

describe('setCardSessionMessage', () => {
  const onPlatform = (os: 'android' | 'ios') =>
    jest.replaceProperty(Platform, 'OS', os);
  const bridge = NfcManager as unknown as {setAlertMessageIOS?: jest.Mock};

  afterEach(() => {
    delete bridge.setAlertMessageIOS;
  });

  it('mirrors the phase into the CoreNFC sheet on iOS', () => {
    const platform = onPlatform('ios');
    bridge.setAlertMessageIOS = jest.fn(() => Promise.resolve());
    try {
      setCardSessionMessage('Checking the card');
    } finally {
      platform.restore();
    }
    expect(bridge.setAlertMessageIOS).toHaveBeenCalledWith('Checking the card');
  });

  it('swallows a rejected bridge call so a closed session never fails a charge', async () => {
    const platform = onPlatform('ios');
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    bridge.setAlertMessageIOS = jest.fn(() =>
      Promise.reject(new Error('no session')),
    );
    try {
      expect(() => setCardSessionMessage('Paid')).not.toThrow();
      // Let the rejection propagate if nothing caught it.
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      platform.restore();
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('survives a bridge that throws synchronously', () => {
    const platform = onPlatform('ios');
    bridge.setAlertMessageIOS = jest.fn(() => {
      throw new Error('bridge gone');
    });
    try {
      expect(() => setCardSessionMessage('Paid')).not.toThrow();
    } finally {
      platform.restore();
    }
  });

  it('never touches the bridge on Android — there is no sheet', () => {
    const platform = onPlatform('android');
    bridge.setAlertMessageIOS = jest.fn(() => Promise.resolve());
    try {
      setCardSessionMessage('Checking the card');
    } finally {
      platform.restore();
    }
    expect(bridge.setAlertMessageIOS).not.toHaveBeenCalled();
  });
});

describe('extendCardTimeout', () => {
  // The jest preset resolves react-native as iOS; pin the platform either way
  // so the Android path is what is under test, not the preset's default.
  const onPlatform = (os: 'android' | 'ios') =>
    jest.replaceProperty(Platform, 'OS', os);

  it('raises the IsoDep transceive timeout on Android', async () => {
    const platform = onPlatform('android');
    try {
      await extendCardTimeout();
    } finally {
      platform.restore();
    }
    expect(mockNfc.setTimeout).toHaveBeenCalledWith(CARD_TRANSCEIVE_TIMEOUT_MS);
  });

  it('leaves iOS alone — CoreNFC has no such knob', async () => {
    const platform = onPlatform('ios');
    try {
      await extendCardTimeout();
    } finally {
      platform.restore();
    }
    expect(mockNfc.setTimeout).not.toHaveBeenCalled();
  });

  it('never fails the session when the bridge refuses', async () => {
    const platform = onPlatform('android');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockNfc.setTimeout.mockRejectedValue(new Error('ERR_API_NOT_SUPPORT'));
    try {
      await expect(extendCardTimeout()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      platform.restore();
      warn.mockRestore();
    }
  });

  it('runs inside withCardSession after the tag connects and before the read', async () => {
    const platform = onPlatform('android');
    try {
      await withCardSession(async () => {
        // The read itself must already enjoy the longer budget — the whole
        // point is that SPEND_PROOF's signature gets it.
        expect(mockNfc.setTimeout).toHaveBeenCalledWith(
          CARD_TRANSCEIVE_TIMEOUT_MS,
        );
        return 'ok';
      });
    } finally {
      platform.restore();
    }
    const [armed] = mockNfc.requestTechnology.mock.invocationCallOrder;
    const [extended] = mockNfc.setTimeout.mock.invocationCallOrder;
    expect(extended).toBeGreaterThan(armed);
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
      'PIN blocked',
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
        'The card read was garbled at the NFC layer — hold the card steady and try again',
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
  it("is true for a UserCancel — the iOS system sheet's Cancel lands here", () => {
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

describe('withCardSession timing', () => {
  // mockRestore also resets the recorded calls, so each test copies them out
  // before restoring the real console.log.
  async function sessionLogs(run: () => Promise<unknown>): Promise<string[]> {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      return log.mock.calls.map(args => String(args[0]));
    } finally {
      log.mockRestore();
    }
  }
  const timingLine = (texts: string[]) =>
    texts.find(text => text.startsWith('[card-session] timing:'));

  it('logs tap wait, session time and the APDU summary when the session closes', async () => {
    const texts = await sessionLogs(() =>
      withCardSession(async () => {
        recordApdu('SPEND_PROOF', 740);
        return 'ok';
      }),
    );
    expect(timingLine(texts)).toMatch(
      /^\[card-session\] timing: tap wait \d+ms · session \d+ms · SPEND_PROOF 1× 740ms · 1 APDUs, 740ms on the wire$/,
    );
  });

  it('counts only this session: samples from before the arm are discarded', async () => {
    recordApdu('SPEND_PROOF', 9999);
    const texts = await sessionLogs(() => withCardSession(async () => 'ok'));
    expect(timingLine(texts)).toMatch(/· no APDUs sent$/);
  });

  it('still logs the timing line, before "session closed", when the session fn throws', async () => {
    const texts = await sessionLogs(() =>
      expect(
        withCardSession(async () => {
          recordApdu('SELECT', 60);
          throw new Error('card left');
        }),
      ).rejects.toThrow('card left'),
    );
    expect(timingLine(texts)).toContain('SELECT 1× 60ms');
    const timingIdx = texts.findIndex(t =>
      t.startsWith('[card-session] timing:'),
    );
    const closedIdx = texts.indexOf('[card-session] session closed');
    expect(timingIdx).toBeGreaterThan(-1);
    expect(timingIdx).toBeLessThan(closedIdx);
  });
});

describe('openCardSession (ENG-634)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({hex: '01009000', sw: '9000'}),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    setCardBridge(null);
    global.fetch = realFetch;
  });

  describe('on NFC', () => {
    it('requests one IsoDep tech by default, raises the timeout, and hands back the tag and the NFC channel', async () => {
      const platform = jest.replaceProperty(Platform, 'OS', 'android');
      const tag = {id: '04AA', techTypes: ['android.nfc.tech.IsoDep']};
      mockNfc.getTag.mockResolvedValue(tag);
      try {
        const session = await openCardSession({alertMessage: 'Hold it'});
        expect(mockNfc.requestTechnology).toHaveBeenCalledWith(NfcTech.IsoDep, {
          alertMessage: 'Hold it',
        });
        expect(mockNfc.setTimeout).toHaveBeenCalledWith(
          CARD_TRANSCEIVE_TIMEOUT_MS,
        );
        expect(session.transceive).toBe(nfcTransceiver);
        await expect(session.getTag()).resolves.toBe(tag);
        expect(mockNfc.cancelTechnologyRequest).not.toHaveBeenCalled();
        await session.close();
        expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalledTimes(1);
      } finally {
        platform.restore();
      }
    });

    it('passes a multi-tech request through as an array, with no options when there is no alert', async () => {
      await openCardSession({techs: [NfcTech.IsoDep, NfcTech.Ndef]});
      expect(mockNfc.requestTechnology).toHaveBeenCalledWith([
        NfcTech.IsoDep,
        NfcTech.Ndef,
      ]);
      expect(mockNfc.requestTechnology.mock.calls[0]).toHaveLength(1);
    });

    it('issues the request before its first await, so a blur right after the call finds it', () => {
      openCardSession({techs: [NfcTech.IsoDep, NfcTech.Ndef]});
      expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
    });

    it('reports a lost tag as null', async () => {
      mockNfc.getTag.mockResolvedValue(undefined);
      const session = await openCardSession();
      await expect(session.getTag()).resolves.toBeNull();
    });

    it('closes without throwing when there is nothing to cancel', async () => {
      mockNfc.cancelTechnologyRequest.mockRejectedValue(
        new Error('ERR_NO_TECH_REQ'),
      );
      const session = await openCardSession();
      await expect(session.close()).resolves.toBeUndefined();
    });
  });

  describe('on the dev card bridge', () => {
    beforeEach(() => setCardBridge({url: 'http://127.0.0.1:9876/'}));

    it('opens at once and never touches the radio', async () => {
      const platform = jest.replaceProperty(Platform, 'OS', 'android');
      try {
        const session = await openCardSession({
          techs: [NfcTech.IsoDep, NfcTech.Ndef],
          alertMessage: 'Hold it',
        });
        await expect(session.getTag()).resolves.toBe(BRIDGE_TAG);
        await session.close();
      } finally {
        platform.restore();
      }
      expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
      expect(mockNfc.setTimeout).not.toHaveBeenCalled();
      expect(mockNfc.getTag).not.toHaveBeenCalled();
      expect(mockNfc.cancelTechnologyRequest).not.toHaveBeenCalled();
      expect(usingCardBridge()).toBe(true);
    });

    it('sends the APDUs to the bridge, not the IsoDep handler', async () => {
      const session = await openCardSession();
      await expect(
        session.transceive([0x00, 0xa4, 0x04, 0x00]),
      ).resolves.toEqual([0x01, 0x00, 0x90, 0x00]);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:9876/apdu',
        expect.objectContaining({method: 'POST'}),
      );
      expect(mockNfc.isoDepHandler.transceive).not.toHaveBeenCalled();
    });

    it('runs withCardSession over the bridge: a full read with no NFC call at all', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({hex: '01009000'}),
        }) // SELECT
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({hex: '01002003011C03019000'}),
        }) // GET_INFO
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({hex: `02${'AB'.repeat(32)}9000`}),
        }) // GET_PUBKEY
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({hex: '000001F49000'}),
        }); // GET_BALANCE

      const summary = await readCardOverNfc();

      expect(summary.balance).toBe(500);
      expect(summary.pubkey).toBe(`02${'ab'.repeat(32)}`);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
      expect(mockNfc.cancelTechnologyRequest).not.toHaveBeenCalled();
    });

    it('makes card reading "supported" whatever the radio says', async () => {
      mockNfc.isSupported.mockResolvedValue(false);
      expect(await isCardReadingSupported()).toBe(true);
      expect(mockNfc.isSupported).not.toHaveBeenCalled();

      setCardBridge(null);
      expect(usingCardBridge()).toBe(false);
      expect(await isCardReadingSupported()).toBe(false);
    });
  });
});
