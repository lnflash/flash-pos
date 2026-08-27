import React from 'react';
import {TouchableOpacity} from 'react-native';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';
import {NfcError} from 'react-native-nfc-manager';

import CashuCardDebug from '../../src/screens/CashuCardDebug';
import {CardError, type CardSummary} from '../../src/services/cashuCard';

const mockCancelCardSession = jest.fn();
const mockIsCardReadingSupported = jest.fn();
const mockReadCardOverNfc = jest.fn();

jest.mock('../../src/services/cashuCardNfc', () => ({
  cancelCardSession: (...args: unknown[]) => mockCancelCardSession(...args),
  isCardReadingSupported: () => mockIsCardReadingSupported(),
  readCardOverNfc: (...args: unknown[]) => mockReadCardOverNfc(...args),
  // Not mocked away: the merchant-facing text is part of what we assert.
  describeCardFailure: jest.requireActual('../../src/services/cashuCardNfc')
    .describeCardFailure,
}));

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

/** A promise the test controls, standing in for "user has not tapped yet". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelCardSession.mockResolvedValue(undefined);
  mockIsCardReadingSupported.mockResolvedValue(true);
  mockReadCardOverNfc.mockResolvedValue(SUMMARY);
});

/** Renders and drains the `isCardReadingSupported` effect. */
async function renderScreen() {
  const utils = render(<CashuCardDebug />);
  await act(async () => {});
  return utils;
}

describe('CashuCardDebug session lifecycle', () => {
  // An IsoDep request never times out on Android — it stays pending until a
  // card arrives, and a pending request makes the native module swallow every
  // BoltCard tap app-wide. Walking away mid-read must not strand it.
  it('cancels an in-flight read when the screen unmounts', async () => {
    const pending = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(pending.promise);

    const {getByText, unmount} = await renderScreen();
    fireEvent.press(getByText('Read card'));
    await act(async () => {});

    expect(mockCancelCardSession).not.toHaveBeenCalled();

    unmount();

    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);

    // Settle the abandoned promise so it cannot leak into another test.
    await act(async () => {
      pending.resolve(SUMMARY);
    });
  });

  it('cancels the session from the Cancel control without unmounting', async () => {
    const pending = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(pending.promise);

    const {getByText} = await renderScreen();
    fireEvent.press(getByText('Read card'));
    await act(async () => {});

    fireEvent.press(getByText('Cancel read'));

    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.reject(new Error('ERR_CANCEL'));
    });
  });

  // Cancelling rejects the in-flight read exactly like a hardware failure, so
  // the naive version paints a red error box for something the merchant just
  // asked for.
  // Rejection shapes a cancel actually produces: nfc-manager's own class on
  // Android, and the bare bridge error when the native side is the one that
  // tears down. Neither may surface as a card failure. The bare-message case is
  // the load-bearing one — it fails if the guard goes, whatever
  // `describeCardFailure` maps that class to.
  it.each([
    [
      'nfc-manager UserCancel',
      () => new NfcError.UserCancel(),
      'Read cancelled',
    ],
    ['a bare bridge error', () => new Error('ERR_CANCEL'), 'ERR_CANCEL'],
  ])(
    'shows no error box after a deliberate cancel (%s)',
    async (_name, buildError, text) => {
      const pending = deferred<CardSummary>();
      mockReadCardOverNfc.mockReturnValue(pending.promise);

      const {getByText, queryByText} = await renderScreen();
      fireEvent.press(getByText('Read card'));
      await act(async () => {});

      fireEvent.press(getByText('Cancel read'));

      await act(async () => {
        pending.reject(buildError());
      });

      expect(queryByText(text)).toBeNull();
      expect(queryByText('Card read failed')).toBeNull();
      // Back to idle, ready for another attempt.
      expect(getByText('Read card')).toBeTruthy();
      expect(queryByText('Waiting for tap…')).toBeNull();
    },
  );

  // The unmount cleanup sets the same flag, so a read abandoned by navigating
  // away does not setState on a screen that is gone. That has no rendered tree
  // left to assert against, so it is covered by inspection here rather than by
  // a query.
  it('settles an unmount-abandoned read without throwing', async () => {
    const pending = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(pending.promise);

    const {getByText, unmount} = await renderScreen();
    fireEvent.press(getByText('Read card'));
    await act(async () => {});

    unmount();
    await act(async () => {
      pending.reject(new Error('ERR_CANCEL'));
    });

    expect(mockCancelCardSession).toHaveBeenCalled();
  });

  // The suppression must be scoped to the cancelled read only — the next
  // failure still has to be reported.
  it('reports a failure on the read that follows a cancel', async () => {
    const cancelled = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(cancelled.promise);

    const {getByText, queryByText} = await renderScreen();
    fireEvent.press(getByText('Read card'));
    await act(async () => {});
    fireEvent.press(getByText('Cancel read'));
    await act(async () => {
      cancelled.reject(new NfcError.UserCancel());
    });
    expect(queryByText('Read cancelled')).toBeNull();

    mockReadCardOverNfc.mockRejectedValue(new NfcError.RadioDisabled());
    fireEvent.press(getByText('Read card'));

    await waitFor(() => expect(getByText('NFC is turned off')).toBeTruthy());
  });

  it('cancels once on unmount even when no read was ever started', async () => {
    const {unmount} = await renderScreen();
    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
  });
});

// A second requestTechnology rejects with ERR_MULTI_REQ, and its own teardown
// then cancels the first, still-pending session — both reads fail. "Press, then
// wait several seconds before tapping" makes the impatient second press the
// likely case, so this needs two independent defences.
describe('CashuCardDebug read guard', () => {
  it('disables the read button while a read is in flight', async () => {
    const pending = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(pending.promise);

    const utils = await renderScreen();
    fireEvent.press(utils.getByText('Read card'));
    await act(async () => {});

    expect(utils.getByText('Waiting for tap…')).toBeTruthy();
    const [readButton] = utils.UNSAFE_getAllByType(TouchableOpacity);
    expect(readButton.props.disabled).toBe(true);

    // fireEvent refuses to dispatch to a disabled element, so this asserts the
    // affordance only — the in-code guard is covered by the next test.
    fireEvent.press(utils.getByText('Waiting for tap…'));
    await act(async () => {});
    expect(mockReadCardOverNfc).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(SUMMARY);
    });
  });

  // Invokes the handler directly, bypassing the `disabled` prop, so this fails
  // if the in-code guard is removed even while the button still greys out.
  it('ignores a second onPress while a read is in flight', async () => {
    const pending = deferred<CardSummary>();
    mockReadCardOverNfc.mockReturnValue(pending.promise);

    const utils = await renderScreen();
    const [readButton] = utils.UNSAFE_getAllByType(TouchableOpacity);

    await act(async () => {
      readButton.props.onPress();
    });
    expect(mockReadCardOverNfc).toHaveBeenCalledTimes(1);

    await act(async () => {
      readButton.props.onPress();
    });
    expect(mockReadCardOverNfc).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(SUMMARY);
    });
  });

  it('allows a second read once the first has finished', async () => {
    const {getByText} = await renderScreen();

    fireEvent.press(getByText('Read card'));
    await waitFor(() => expect(getByText('Read card')).toBeTruthy());

    fireEvent.press(getByText('Read card'));
    await act(async () => {});

    expect(mockReadCardOverNfc).toHaveBeenCalledTimes(2);
  });
});

describe('CashuCardDebug results', () => {
  it('renders the pubkey and balance from a successful read', async () => {
    const {getByText} = await renderScreen();

    fireEvent.press(getByText('Read card'));
    await waitFor(() => expect(getByText(SUMMARY.pubkey)).toBeTruthy());

    expect(getByText('500')).toBeTruthy();
    expect(getByText('1.0')).toBeTruthy();
    expect(getByText('3/1/28')).toBeTruthy();
    expect(getByText('set')).toBeTruthy();
  });

  it('surfaces the card failure text and clears the reading state', async () => {
    mockReadCardOverNfc.mockRejectedValue(new CardError(0x6983, 'GET_INFO'));

    const {getByText, queryByText} = await renderScreen();
    fireEvent.press(getByText('Read card'));

    await waitFor(() => expect(getByText(/card locked/)).toBeTruthy());
    expect(queryByText('Waiting for tap…')).toBeNull();
    expect(getByText('Read card')).toBeTruthy();
  });

  it('reports whether NFC is available on this device', async () => {
    mockIsCardReadingSupported.mockResolvedValue(false);
    const {getByText} = await renderScreen();
    expect(getByText('no')).toBeTruthy();
  });
});
