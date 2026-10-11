import {Alert} from 'react-native';
import {act, renderHook} from '@testing-library/react-native';
import NfcManager, {NfcError, TagEvent} from 'react-native-nfc-manager';

import {useCardPaymentRouter} from '../../src/hooks/useCardPaymentRouter';
import {CardError} from '../../src/services/cashuCard';
import {setCardBridge} from '../../src/services/cardBridge';

const mockHandleTag = jest.fn();
const mockSetNfcBusy = jest.fn();
const mockNavigate = jest.fn();
const mockReadAndPlan = jest.fn();
const mockExtendCardTimeout = jest.fn();
const mockTransceiver = jest.fn();
const mockOpenCardSession = jest.fn();

// The bridge is stubbed; `NfcError` is the real class hierarchy so that
// `isUserCancel` sees a genuine `UserCancel`, and `Ndef.text.decodePayload`
// is the real decoder so the lnurlw check reads the same bytes the Flashcard
// context does.
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    isSupported: jest.fn(() => Promise.resolve(true)),
    isEnabled: jest.fn(() => Promise.resolve(true)),
    requestTechnology: jest.fn(() => Promise.resolve()),
    getTag: jest.fn(() => Promise.resolve(null)),
    cancelTechnologyRequest: jest.fn(() => Promise.resolve()),
    setTimeout: jest.fn(() => Promise.resolve()),
    ndefHandler: {getNdefMessage: jest.fn(() => Promise.resolve(null))},
    isoDepHandler: {transceive: jest.fn()},
  },
  Ndef: {
    text: jest.requireActual('react-native-nfc-manager/ndef-lib/ndef-text'),
  },
  NfcTech: {Ndef: 'Ndef', IsoDep: 'IsoDep'},
  NfcError: jest.requireActual('react-native-nfc-manager/src/NfcError'),
}));

jest.mock('../../src/hooks/useFlashcard', () => ({
  useFlashcard: () => ({
    handleTag: (...args: unknown[]) => mockHandleTag(...args),
    setNfcBusy: (...args: unknown[]) => mockSetNfcBusy(...args),
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
}));

jest.mock('../../src/store/hooks', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({amount: {satAmount: 800}}),
}));

jest.mock('../../src/services/cashuCharge', () => ({
  readAndPlan: (...args: unknown[]) => mockReadAndPlan(...args),
}));

jest.mock('../../src/services/cashuCardNfc', () => {
  const actual = jest.requireActual('../../src/services/cashuCardNfc');
  return {
    openCardSession: (...args: unknown[]) => mockOpenCardSession(...args),
    // Real: the cancel lands on NfcManager.cancelTechnologyRequest (what
    // the teardown assertions observe), and the bridge check reads the
    // real card-bridge module.
    cancelCardSession: actual.cancelCardSession,
    usingCardBridge: actual.usingCardBridge,
    describeCardFailure: actual.describeCardFailure,
    isUserCancel: actual.isUserCancel,
  };
});

const mockNfc = NfcManager as unknown as {
  start: jest.Mock;
  isSupported: jest.Mock;
  isEnabled: jest.Mock;
  requestTechnology: jest.Mock;
  getTag: jest.Mock;
  cancelTechnologyRequest: jest.Mock;
  setTimeout: jest.Mock;
  ndefHandler: {getNdefMessage: jest.Mock};
};

const LNURLW = 'lnurlw://btcpay.flashapp.me/boltcard?p=0A1B&c=2C3D';

const bytes = (text: string) => Array.from(Buffer.from(text, 'utf8'));

/** A BoltCard's NDEF URI record: 0x00 prefix (no abbreviation) + the URL. */
const lnurlwRecord = () => ({
  tnf: 1 as const,
  type: 'U',
  payload: [0x00, ...bytes(LNURLW)],
});

/** An NDEF text record ("en" + text) that is not a withdraw link. */
const textRecord = (text: string) => ({
  tnf: 1 as const,
  type: 'T',
  payload: [0x02, ...bytes('en'), ...bytes(text)],
});

/** What Android's dispatch intent hands over for a Flashcard v1. */
const androidV1Tag = (): TagEvent => ({
  id: '04A1B2C3D4E5F6',
  techTypes: [
    'android.nfc.tech.IsoDep',
    'android.nfc.tech.NfcA',
    'android.nfc.tech.Ndef',
  ],
  ndefMessage: [lnurlwRecord()],
});

/** What Android's dispatch intent hands over for a Cashu javacard (v2). */
const androidV2Tag = () =>
  ({
    id: '04FFEEDDCCBBAA',
    techTypes: ['android.nfc.tech.IsoDep', 'android.nfc.tech.NfcA'],
  } as unknown as TagEvent);

/** What iOS hands over for any ISO7816 tag whose NDEF read did not land. */
const iosIsoDepTag = () =>
  ({id: '04A1B2C3D4E5F6', tech: 'IsoDep'} as unknown as TagEvent);

const PLAN = {
  plan: {slots: [1], burnedSat: 16, changeSat: 0},
  unspent: [{slot: 1, amount: 16}],
  cardPubkey: '02ab',
  pinRequired: false,
};

const appletNotFound = () => new CardError(0x6a82, 'SELECT');

/** How `readAndPlan` actually surfaces it: re-wrapped per phase, the CardError kept as `cause`. */
const wrappedAppletNotFound = () =>
  Object.assign(
    new Error('[reading card] SELECT failed: applet not found (0x6A82)'),
    {cause: appletNotFound()},
  );

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockNfc.isSupported.mockResolvedValue(true);
  mockNfc.isEnabled.mockResolvedValue(true);
  mockNfc.requestTechnology.mockResolvedValue(undefined);
  mockNfc.getTag.mockResolvedValue(null);
  mockNfc.cancelTechnologyRequest.mockResolvedValue(undefined);
  mockNfc.ndefHandler.getNdefMessage.mockResolvedValue(null);
  mockExtendCardTimeout.mockResolvedValue(undefined);
  setCardBridge(null);
  // The seam's NFC branch: request the techs, raise the timeout once the
  // tag connects, hand back the tag the stack reports and its teardown.
  mockOpenCardSession.mockImplementation(async ({techs}: {techs: string[]}) => {
    await mockNfc.requestTechnology(techs);
    await mockExtendCardTimeout();
    return {
      transceive: (...args: unknown[]) => mockTransceiver(...args),
      getTag: () => mockNfc.getTag(),
      close: () => mockNfc.cancelTechnologyRequest(),
    };
  });
  mockReadAndPlan.mockResolvedValue(PLAN);
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function route(): Promise<boolean> {
  const {result} = renderHook(() => useCardPaymentRouter());
  let routed = false;
  await act(async () => {
    routed = await result.current.routeCardPayment();
  });
  return routed;
}

describe('useCardPaymentRouter — routing by evidence (ENG-614)', () => {
  it('Android: an ISO-DEP tag with an lnurlw NDEF record goes to the BoltCard flow, never the Cashu SELECT', async () => {
    const tag = androidV1Tag();
    mockNfc.getTag.mockResolvedValue(tag);

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockHandleTag).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).toHaveBeenCalledWith(tag);
    expect(mockReadAndPlan).not.toHaveBeenCalled();
    expect(mockNfc.ndefHandler.getNdefMessage).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('iOS: an ISO-DEP tag without ndefMessage is read for NDEF in-session first; an lnurlw record routes to the BoltCard flow', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockNfc.ndefHandler.getNdefMessage.mockResolvedValue({
      ndefMessage: [lnurlwRecord()],
    });

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockNfc.ndefHandler.getNdefMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).toHaveBeenCalledWith({
      id: '04A1B2C3D4E5F6',
      tech: 'IsoDep',
      ndefMessage: [lnurlwRecord()],
    });
    expect(mockReadAndPlan).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('iOS: when the in-session NDEF read rejects, the Cashu read runs and the charge screen opens with the plan', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockNfc.ndefHandler.getNdefMessage.mockRejectedValue(
      new Error('No ndef available'),
    );

    const routed = await route();

    expect(routed).toBe(true);
    expect(mockExtendCardTimeout).toHaveBeenCalledTimes(1);
    expect(mockReadAndPlan).toHaveBeenCalledWith(
      expect.objectContaining({amountSat: 800}),
    );
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge', {
      preRead: PLAN,
    });
    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('iOS: when the in-session NDEF read yields nothing, the Cashu read runs (existing behaviour)', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockNfc.ndefHandler.getNdefMessage.mockResolvedValue({ndefMessage: []});

    const routed = await route();

    expect(routed).toBe(true);
    expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge', {
      preRead: PLAN,
    });
    expect(mockHandleTag).not.toHaveBeenCalled();
  });

  it('a non-lnurlw NDEF record is not evidence: the ISO-DEP tag still goes to the Cashu read', async () => {
    mockNfc.getTag.mockResolvedValue({
      ...iosIsoDepTag(),
      ndefMessage: [textRecord('hello')],
    });

    const routed = await route();

    expect(routed).toBe(true);
    expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
    expect(mockNfc.ndefHandler.getNdefMessage).not.toHaveBeenCalled();
    expect(mockHandleTag).not.toHaveBeenCalled();
  });

  it('Android: a javacard without Ndef tech skips the in-session NDEF read and goes straight to the Cashu read', async () => {
    mockNfc.getTag.mockResolvedValue(androidV2Tag());

    const routed = await route();

    expect(routed).toBe(true);
    expect(mockNfc.ndefHandler.getNdefMessage).not.toHaveBeenCalled();
    expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge', {
      preRead: PLAN,
    });
  });

  it('"applet not found" (CardError) is a second chance: the NDEF read then routes to the BoltCard flow with no alert', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockNfc.ndefHandler.getNdefMessage
      .mockRejectedValueOnce(new Error('No ndef available'))
      .mockResolvedValueOnce({ndefMessage: [lnurlwRecord()]});
    mockReadAndPlan.mockRejectedValue(appletNotFound());

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
    expect(mockNfc.ndefHandler.getNdefMessage).toHaveBeenCalledTimes(2);
    expect(mockHandleTag).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).toHaveBeenCalledWith(
      expect.objectContaining({ndefMessage: [lnurlwRecord()]}),
    );
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('"applet not found" as readAndPlan really throws it (re-wrapped per phase, CardError as cause) is recognised too', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockNfc.ndefHandler.getNdefMessage
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ndefMessage: [lnurlwRecord()]});
    mockReadAndPlan.mockRejectedValue(wrappedAppletNotFound());

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockHandleTag).toHaveBeenCalledTimes(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('"applet not found" with no NDEF surface either still surfaces the card error', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockReadAndPlan.mockRejectedValue(appletNotFound());

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockNfc.ndefHandler.getNdefMessage).toHaveBeenCalledTimes(2);
    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'SELECT failed: applet not found (0x6A82)',
    );
  });

  it('any other Cashu read failure is shown, not retried as NDEF', async () => {
    mockNfc.getTag.mockResolvedValue(iosIsoDepTag());
    mockReadAndPlan.mockRejectedValue(new CardError(0x6983, 'VERIFY'));

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockNfc.ndefHandler.getNdefMessage).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      'VERIFY failed: PIN blocked (0x6983)',
    );
  });

  it('a plain NDEF tag (no IsoDep) goes to the BoltCard flow as before', async () => {
    const tag: TagEvent = {
      id: '0411223344',
      techTypes: ['android.nfc.tech.Ndef', 'android.nfc.tech.NfcA'],
      ndefMessage: [textRecord('hello')],
    };
    mockNfc.getTag.mockResolvedValue(tag);

    const routed = await route();

    expect(routed).toBe(false);
    expect(mockHandleTag).toHaveBeenCalledWith(tag);
    expect(mockReadAndPlan).not.toHaveBeenCalled();
  });

  it('always releases the session and the Flashcard context, whichever way it routed', async () => {
    mockNfc.getTag.mockResolvedValue(androidV1Tag());

    await route();

    expect(mockSetNfcBusy).toHaveBeenNthCalledWith(1, true);
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
  });
});

describe('useCardPaymentRouter — cancelling the tap', () => {
  it('Cancel on the tap sheet is not an error: no alert, returns false, session and context released', async () => {
    mockNfc.requestTechnology.mockRejectedValue(new NfcError.UserCancel());

    const routed = await route();

    expect(routed).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(mockReadAndPlan).not.toHaveBeenCalled();
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
  });

  it('a real session failure still alerts', async () => {
    mockNfc.requestTechnology.mockRejectedValue(new Error('boom'));

    const routed = await route();

    expect(routed).toBe(false);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
  });
});

describe('useCardPaymentRouter — the dev card bridge (ENG-634)', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    mockOpenCardSession.mockImplementation(
      jest.requireActual('../../src/services/cashuCardNfc').openCardSession,
    );
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({hex: '9000', sw: '9000'}),
    })) as unknown as typeof fetch;
    setCardBridge({url: 'http://127.0.0.1:9876'});
  });

  afterEach(() => {
    setCardBridge(null);
    global.fetch = realFetch;
  });

  it('never touches the radio: no support check, no start, no request; the bridge tag goes to the Cashu read', async () => {
    // The simulator has no NFC: these would refuse the charge if consulted.
    mockNfc.isSupported.mockResolvedValue(false);
    mockNfc.isEnabled.mockResolvedValue(false);
    mockReadAndPlan.mockImplementation(async ({transceive}) => {
      await transceive([0x00, 0xa4, 0x04, 0x00]);
      return PLAN;
    });

    const routed = await route();

    expect(routed).toBe(true);
    expect(mockNfc.isSupported).not.toHaveBeenCalled();
    expect(mockNfc.start).not.toHaveBeenCalled();
    expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
    expect(mockNfc.getTag).not.toHaveBeenCalled();
    // BRIDGE_TAG carries no NDEF surface: no in-session NDEF read, no
    // BoltCard handler.
    expect(mockNfc.ndefHandler.getNdefMessage).not.toHaveBeenCalled();
    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9876/apdu',
      expect.objectContaining({body: JSON.stringify({hex: '00A40400'})}),
    );
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardCharge', {
      preRead: PLAN,
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('once the bridge is cleared, a device without NFC is refused as before', async () => {
    setCardBridge(null);
    mockNfc.isSupported.mockResolvedValue(false);

    const routed = await route();

    expect(routed).toBe(false);
    expect(alertSpy).toHaveBeenCalledWith(
      'NFC is not supported on this device',
    );
    expect(mockOpenCardSession).not.toHaveBeenCalled();
  });
});
