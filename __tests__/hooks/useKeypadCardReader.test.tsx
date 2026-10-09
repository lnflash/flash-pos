import {Platform} from 'react-native';
import {act, renderHook, waitFor} from '@testing-library/react-native';
import NfcManager, {
  Ndef,
  NfcError,
  NfcTech,
  type TagEvent,
} from 'react-native-nfc-manager';

import {
  IOS_BALANCE_SHEET_MESSAGE,
  KEYPAD_CARD_TECHS,
  REARM_AFTER_ERROR_MS,
  useKeypadCardReader,
} from '../../src/hooks/useKeypadCardReader';
import {CardError, type CardSummary} from '../../src/services/cashuCard';

const mockNavigate = jest.fn();
const mockHandleTag = jest.fn();
const mockSetNfcBusy = jest.fn();
const mockReadCard = jest.fn();
const mockGetSlotStatuses = jest.fn();
const mockReconcileOwedChange = jest.fn();
const mockWriteOwedChange = jest.fn();
const mockOutstandingChangeForCard = jest.fn();
const mockToastShow = jest.fn();
const mockIsCardReadingSupported = jest.fn();
const mockExtendCardTimeout = jest.fn();

/**
 * The navigation focus hook, under test control: `focus()` runs the latest
 * callback the hook registered (as the navigator does when the keypad becomes
 * the focused screen) and `blur()` runs the cleanup it returned.
 */
type FocusCallback = () => void | (() => void);
const mockFocus: {callback?: FocusCallback; cleanup?: void | (() => void)} =
  {};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate}),
  useFocusEffect: (callback: FocusCallback) => {
    mockFocus.callback = callback;
  },
}));

// The bridge is stubbed; `NfcError` and the NDEF text codec are the real
// ones, so the lnurlw check runs against bytes a real tag carries and the
// cancel predicate sees the class the native side actually throws.
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    requestTechnology: jest.fn(),
    getTag: jest.fn(),
    cancelTechnologyRequest: jest.fn(),
    setTimeout: jest.fn(() => Promise.resolve()),
    isoDepHandler: {transceive: jest.fn()},
  },
  Ndef: jest.requireActual('react-native-nfc-manager/ndef-lib'),
  NfcTech: {Ndef: 'Ndef', IsoDep: 'IsoDep'},
  NfcError: jest.requireActual('react-native-nfc-manager/src/NfcError'),
}));

jest.mock('../../src/hooks/useFlashcard', () => ({
  useFlashcard: () => ({
    handleTag: (...args: unknown[]) => mockHandleTag(...args),
    setNfcBusy: (...args: unknown[]) => mockSetNfcBusy(...args),
  }),
}));

jest.mock('../../src/services/cashuCard', () => ({
  ...jest.requireActual('../../src/services/cashuCard'),
  readCard: (...args: unknown[]) => mockReadCard(...args),
  getSlotStatuses: (...args: unknown[]) => mockGetSlotStatuses(...args),
}));

jest.mock('../../src/services/cashuCharge', () => ({
  reconcileOwedChange: (...args: unknown[]) =>
    mockReconcileOwedChange(...args),
  writeOwedChange: (...args: unknown[]) => mockWriteOwedChange(...args),
}));

jest.mock('../../src/services/cashuSettlement', () => ({
  outstandingChangeForCard: (...args: unknown[]) =>
    mockOutstandingChangeForCard(...args),
}));

jest.mock('../../src/services/cashuCardNfc', () => ({
  // Real: cancelCardSession (so NfcManager.cancelTechnologyRequest is what we
  // observe), describeCardFailure (its text is asserted) and isUserCancel.
  ...jest.requireActual('../../src/services/cashuCardNfc'),
  extendCardTimeout: () => mockExtendCardTimeout(),
  isCardReadingSupported: () => mockIsCardReadingSupported(),
  nfcTransceiver: jest.fn(),
}));

jest.mock('../../src/utils/toast', () => ({
  toastShow: (...args: unknown[]) => mockToastShow(...args),
}));

const mockNfc = NfcManager as unknown as {
  start: jest.Mock;
  requestTechnology: jest.Mock;
  getTag: jest.Mock;
  cancelTechnologyRequest: jest.Mock;
};

const SUMMARY: CardSummary = {
  appletVersion: '1.0',
  info: {
    version: '1.0',
    maxSlots: 32,
    unspent: 3,
    spent: 1,
    empty: 28,
    secp256k1Native: true,
    schnorr: true,
    pinState: 'set',
  },
  pubkey: '02'.padEnd(66, 'ab'),
  balance: 500,
};

/** A BoltCard as Android reports it: IsoDep + NfcA + Ndef, one text record. */
const LNURLW_TAG: TagEvent = {
  id: '04A1B2C3',
  techTypes: [
    'android.nfc.tech.IsoDep',
    'android.nfc.tech.NfcA',
    'android.nfc.tech.Ndef',
  ],
  ndefMessage: [
    {
      tnf: 1,
      type: 'T',
      // The lib types encodePayload as a record; at runtime it is the byte
      // array a text record's payload holds (ndef-lib/ndef-text.js).
      payload: Ndef.text.encodePayload(
        'lnurlw://btcpay.example.com/boltcard?p=AA&c=BB',
      ) as unknown as number[],
    },
  ],
};

/** A Flashcard v2 (cashu-javacard): IsoDep, no NDEF surface at all. */
const V2_TAG = {
  id: '04D4E5F6',
  techTypes: ['android.nfc.tech.IsoDep', 'android.nfc.tech.NfcA'],
} as unknown as TagEvent;

/** A promise the test settles, standing in for "no card has tapped yet". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v: T) => {
      settled = true;
      res(v);
    };
    reject = (r?: unknown) => {
      settled = true;
      rej(r);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

type Pending = ReturnType<typeof deferred<void>>;
let requests: Pending[] = [];

/** The request still waiting on a tap, if any. */
const pendingRequest = () => requests.find(r => !r.settled);

const flush = () => act(async () => {});

/** A card enters the field: the request resolves and `getTag` reports it. */
const tap = async (tag: TagEvent) => {
  mockNfc.getTag.mockResolvedValue(tag);
  await act(async () => {
    pendingRequest()!.resolve();
  });
};

const focus = () =>
  act(() => {
    mockFocus.cleanup = mockFocus.callback?.();
  });

const blur = () =>
  act(() => {
    if (typeof mockFocus.cleanup === 'function') {
      mockFocus.cleanup();
    }
    mockFocus.cleanup = undefined;
  });

let platform: {restore: () => void} | undefined;
const setPlatform = (os: 'android' | 'ios') => {
  platform = jest.replaceProperty(Platform, 'OS', os);
};

beforeEach(() => {
  jest.clearAllMocks();
  requests = [];
  mockFocus.callback = undefined;
  mockFocus.cleanup = undefined;
  mockIsCardReadingSupported.mockResolvedValue(true);
  mockExtendCardTimeout.mockResolvedValue(undefined);
  mockReadCard.mockResolvedValue(SUMMARY);
  mockOutstandingChangeForCard.mockResolvedValue([]);
  mockGetSlotStatuses.mockResolvedValue(['unspent', 'empty']);
  mockReconcileOwedChange.mockImplementation(async ({owed}) => owed ?? []);
  mockWriteOwedChange.mockResolvedValue(1);
  mockNfc.getTag.mockResolvedValue(null);
  // Each request is a fresh pending promise, like the native techRequest.
  mockNfc.requestTechnology.mockImplementation(() => {
    const request = deferred<void>();
    requests.push(request);
    return request.promise;
  });
  // The native side: cancelling a pending request rejects it with
  // UserCancel; cancelling with nothing pending is a no-op.
  mockNfc.cancelTechnologyRequest.mockImplementation(async () => {
    pendingRequest()?.reject(new NfcError.UserCancel());
  });
});

afterEach(() => {
  platform?.restore();
  platform = undefined;
});

describe('useKeypadCardReader on Android', () => {
  beforeEach(() => setPlatform('android'));

  it('arms one [IsoDep, Ndef] request on focus and marks the context busy', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
    expect(mockNfc.requestTechnology).toHaveBeenCalledWith([
      NfcTech.IsoDep,
      NfcTech.Ndef,
    ]);
    expect(KEYPAD_CARD_TECHS).toEqual([NfcTech.IsoDep, NfcTech.Ndef]);
    expect(mockSetNfcBusy).toHaveBeenCalledWith(true);
  });

  it('never arms when the device cannot read cards', async () => {
    mockIsCardReadingSupported.mockResolvedValue(false);
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
    expect(mockSetNfcBusy).not.toHaveBeenCalledWith(true);
  });

  it('hands an lnurlw NDEF tag to the Flashcard context, reads nothing, then re-arms', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(LNURLW_TAG);
    await flush();

    expect(mockHandleTag).toHaveBeenCalledTimes(1);
    expect(mockHandleTag).toHaveBeenCalledWith(LNURLW_TAG);
    expect(mockReadCard).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The session closes and a fresh one is armed for the next tap.
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2);
    expect(pendingRequest()).toBeDefined();
  });

  it('reads an IsoDep card with no NDEF in the same session and opens CashuCardBalance', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockHandleTag).not.toHaveBeenCalled();
    expect(mockExtendCardTimeout).toHaveBeenCalledTimes(1);
    expect(mockReadCard).toHaveBeenCalledTimes(1);
    expect(mockReadCard).toHaveBeenCalledWith(expect.any(Function));
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: SUMMARY,
    });
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2);
  });

  it('is silent on a user cancel and re-arms', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    await act(async () => {
      pendingRequest()!.reject(new NfcError.UserCancel());
    });
    await flush();

    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2);
  });

  it('toasts any other failure in merchant words and re-arms after a breather', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    await act(async () => {
      pendingRequest()!.reject(new NfcError.TagConnectionLost());
    });
    await flush();

    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'Card left the field — hold it still',
      type: 'error',
    });
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    await waitFor(
      () => expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2),
      {timeout: REARM_AFTER_ERROR_MS * 4},
    );
  });

  it('says quietly that a card without the applet is not a Flash card, and re-arms', async () => {
    mockReadCard.mockRejectedValue(new CardError(0x6a82, 'SELECT'));
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith({
      message: 'Not a Flash card',
      type: 'info',
    });
    await waitFor(
      () => expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2),
      {timeout: REARM_AFTER_ERROR_MS * 4},
    );
  });

  it('cancels the pending request on blur, frees the context and does not re-arm', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);

    blur();
    await flush();

    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
    expect(pendingRequest()).toBeUndefined();
  });

  it('cancels the pending request on unmount', async () => {
    const {unmount} = renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    // The navigator runs the focus cleanup as the screen unmounts.
    blur();
    unmount();
    await flush();

    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
  });

  it('arms again on the next focus after a blur', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    blur();
    await flush();
    focus();
    await flush();

    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(2);
    expect(pendingRequest()).toBeDefined();
  });

  it('never arms twice while one request is pending', async () => {
    const {result} = renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    // A second focus without a blur, and an explicit read while armed: a
    // second requestTechnology would reject with ERR_MULTI_REQ and tear down
    // the first.
    focus();
    await flush();
    await act(async () => {
      await result.current.readOnce();
    });
    await flush();

    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
  });
});

describe('useKeypadCardReader on iOS', () => {
  beforeEach(() => setPlatform('ios'));

  it('does not arm on focus — a pending request would show the system sheet', async () => {
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    expect(mockNfc.requestTechnology).not.toHaveBeenCalled();
    expect(mockSetNfcBusy).not.toHaveBeenCalledWith(true);
  });

  it('readOnce arms once under the sheet, routes a v2 card, and does not re-arm', async () => {
    const {result} = renderHook(() => useKeypadCardReader());
    focus();
    await flush();

    let read!: Promise<void>;
    act(() => {
      read = result.current.readOnce();
    });
    await flush();

    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
    expect(mockNfc.requestTechnology).toHaveBeenCalledWith(
      [NfcTech.IsoDep, NfcTech.Ndef],
      {alertMessage: IOS_BALANCE_SHEET_MESSAGE},
    );
    expect(result.current.reading).toBe(true);
    expect(mockSetNfcBusy).toHaveBeenCalledWith(true);

    await tap(V2_TAG);
    await act(async () => {
      await read;
    });

    expect(mockReadCard).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: SUMMARY,
    });
    expect(mockNfc.cancelTechnologyRequest).toHaveBeenCalled();
    expect(mockSetNfcBusy).toHaveBeenLastCalledWith(false);
    expect(result.current.reading).toBe(false);
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
  });

  it('readOnce hands a v1 card to the Flashcard context', async () => {
    const {result} = renderHook(() => useKeypadCardReader());

    let read!: Promise<void>;
    act(() => {
      read = result.current.readOnce();
    });
    await flush();
    await tap(LNURLW_TAG);
    await act(async () => {
      await read;
    });

    expect(mockHandleTag).toHaveBeenCalledWith(LNURLW_TAG);
    expect(mockReadCard).not.toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
  });

  it('readOnce is silent when the sheet is dismissed and does not re-arm', async () => {
    const {result} = renderHook(() => useKeypadCardReader());

    let read!: Promise<void>;
    act(() => {
      read = result.current.readOnce();
    });
    await flush();
    await act(async () => {
      pendingRequest()!.reject(new NfcError.UserCancel());
      await read;
    });

    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);
    expect(result.current.reading).toBe(false);
  });

  it('readOnce ignores a second press while the sheet is up', async () => {
    const {result} = renderHook(() => useKeypadCardReader());

    act(() => {
      result.current.readOnce();
    });
    await flush();
    await act(async () => {
      await result.current.readOnce();
    });

    expect(mockNfc.requestTechnology).toHaveBeenCalledTimes(1);

    // Settle the abandoned request so it cannot leak into another test.
    await act(async () => {
      pendingRequest()!.reject(new NfcError.UserCancel());
    });
  });
});

describe('useKeypadCardReader: change owed from an earlier charge (ENG-630)', () => {
  beforeEach(() => setPlatform('android'));

  const OWED = [
    {id: `${SUMMARY.pubkey}:aa`, cardPubkey: SUMMARY.pubkey, amount: 4, nonce: 'aa'},
    {id: `${SUMMARY.pubkey}:bb`, cardPubkey: SUMMARY.pubkey, amount: 2, nonce: 'bb'},
  ];
  const NO_PIN: CardSummary = {
    ...SUMMARY,
    info: {...SUMMARY.info, pinState: 'unset'},
  };

  it('writes the owed change onto a PIN-less card in the same session and re-reads the balance', async () => {
    const after: CardSummary = {...NO_PIN, balance: 506};
    mockReadCard.mockResolvedValueOnce(NO_PIN).mockResolvedValueOnce(after);
    mockOutstandingChangeForCard.mockResolvedValue(OWED);
    mockReconcileOwedChange.mockResolvedValue([OWED[1]]);
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockOutstandingChangeForCard).toHaveBeenCalledWith(SUMMARY.pubkey);
    expect(mockGetSlotStatuses).toHaveBeenCalledWith(
      expect.any(Function),
      SUMMARY.info.maxSlots,
    );
    expect(mockReconcileOwedChange).toHaveBeenCalledWith(
      expect.objectContaining({
        cardPubkey: SUMMARY.pubkey,
        statuses: ['unspent', 'empty'],
      }),
    );
    // Only what the card does not already hold is sent.
    expect(mockWriteOwedChange).toHaveBeenCalledWith(
      expect.objectContaining({owed: [OWED[1]]}),
    );
    expect(mockReadCard).toHaveBeenCalledTimes(2);
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: after,
      changeAddedSat: 6,
    });
    // The write happened before the session closed.
    const writeOrder = mockWriteOwedChange.mock.invocationCallOrder[0];
    const cancelOrder = mockNfc.cancelTechnologyRequest.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(cancelOrder);
  });

  it('sends no LOAD when the card already holds every owed piece', async () => {
    mockReadCard.mockResolvedValue(NO_PIN);
    mockOutstandingChangeForCard.mockResolvedValue(OWED);
    mockReconcileOwedChange.mockResolvedValue([]);
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockWriteOwedChange).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: NO_PIN,
      changeAddedSat: 6,
    });
  });

  it('tells a PIN card what is waiting instead of writing — the keypad has no pad', async () => {
    mockOutstandingChangeForCard.mockResolvedValue(OWED);
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockGetSlotStatuses).not.toHaveBeenCalled();
    expect(mockReconcileOwedChange).not.toHaveBeenCalled();
    expect(mockWriteOwedChange).not.toHaveBeenCalled();
    expect(mockReadCard).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: SUMMARY,
      owedChangeSat: 6,
    });
  });

  it('a card owed nothing opens the balance as before, with no slot read', async () => {
    mockReadCard.mockResolvedValue(NO_PIN);
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockGetSlotStatuses).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: NO_PIN,
    });
  });

  it('an unreadable owed-change store does not block the balance read', async () => {
    mockOutstandingChangeForCard.mockRejectedValue(new Error('keychain locked'));
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('CashuCardBalance', {
      summary: SUMMARY,
    });
  });

  it('a write the card refuses is toasted in merchant words and the balance screen is not opened', async () => {
    mockReadCard.mockResolvedValue(NO_PIN);
    mockOutstandingChangeForCard.mockResolvedValue(OWED);
    mockReconcileOwedChange.mockResolvedValue(OWED);
    mockWriteOwedChange.mockRejectedValue(
      new CardError(0x6a84, 'LOAD_PROOF'),
    );
    renderHook(() => useKeypadCardReader());
    focus();
    await flush();
    await tap(V2_TAG);
    await flush();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToastShow).toHaveBeenCalledWith({
      message: expect.stringMatching(/card is full/i),
      type: 'error',
    });
  });
});
