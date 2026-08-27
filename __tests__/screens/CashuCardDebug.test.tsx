import React from 'react';
import {TouchableOpacity} from 'react-native';
import {act, fireEvent, render, waitFor} from '@testing-library/react-native';

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
