import React from 'react';
import {act, fireEvent, render, within} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';

import CashuCardCharge, {
  LIFT_HOLD_MS,
  SETTLE_AFTER_HANDOFF_MS,
} from '../../src/screens/CashuCardCharge';
import amountSlice from '../../src/store/slices/amountSlice';
import userSlice from '../../src/store/slices/userSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';

const mockWithCardSession = jest.fn();
const mockCancelCardSession = jest.fn();
const mockSetCardSessionMessage = jest.fn();
const mockIsCardReadingSupported = jest.fn();
const mockExecuteCharge = jest.fn();
const mockReadAndPlan = jest.fn();
const mockRunAutoSettlement = jest.fn();
const mockViewRenders = {count: 0};

jest.mock('../../src/services/cashuCardNfc', () => ({
  cancelCardSession: (...args: unknown[]) => mockCancelCardSession(...args),
  isCardReadingSupported: () => mockIsCardReadingSupported(),
  setCardSessionMessage: (...args: unknown[]) =>
    mockSetCardSessionMessage(...args),
  withCardSession: (...args: unknown[]) => mockWithCardSession(...args),
  describeCardFailure: jest.requireActual('../../src/services/cashuCardNfc')
    .describeCardFailure,
  isUserCancel: jest.requireActual('../../src/services/cashuCardNfc')
    .isUserCancel,
}));

jest.mock('../../src/services/cashuCharge', () => ({
  executeCharge: (...args: unknown[]) => mockExecuteCharge(...args),
  readAndPlan: (...args: unknown[]) => mockReadAndPlan(...args),
}));

jest.mock('../../src/services/cashuAutoSettle', () => ({
  runAutoSettlement: (...args: unknown[]) => mockRunAutoSettlement(...args),
}));

// This screen ships in release builds and imports leaves only: the barrels
// would drag the printer and currency-picker native modules into its graph.
jest.mock('../../src/components', () => {
  throw new Error(
    'CashuCardCharge must import leaf components, not the barrel',
  );
});
jest.mock('../../src/hooks', () => {
  throw new Error('CashuCardCharge must not import the hooks barrel');
});

jest.mock('react-native-svg', () => require('../../__mocks__/svgStub'));

// The real ChargeView, wrapped only to count its renders.
jest.mock('../../src/components/cashu/charge/ChargeView', () => {
  const actual = jest.requireActual(
    '../../src/components/cashu/charge/ChargeView',
  );
  const MockReact = require('react');
  const Counted = (props: object) => {
    mockViewRenders.count += 1;
    return MockReact.createElement(actual.default, props);
  };
  return {...actual, __esModule: true, default: Counted};
});

const visible = {includeHiddenElements: false} as const;
/** For "must not exist at all": hidden layers count too. */
const all = {includeHiddenElements: true} as const;

const PLAN = {
  plan: {slots: [1, 2], burnedSat: 24, changeSat: 8},
  unspent: [
    {slot: 1, amount: 16},
    {slot: 2, amount: 8},
  ],
  cardPubkey: '02'.padEnd(64, 'ab') + '7f3a',
  pinRequired: false,
};

const HOME = {key: 'Home-abc', name: 'Home'};

/** Renders and drains the `isCardReadingSupported` effect. */
const renderScreen = async (params: Record<string, unknown> = {}) => {
  const store = configureStore({
    reducer: {
      amount: amountSlice,
      user: userSlice,
      invoice: invoiceSlice,
      transactionHistory: transactionHistorySlice,
    },
    preloadedState: {
      amount: {
        ...amountSlice(undefined, {type: 'init'}),
        isPrimaryAmountSats: true,
        displayAmount: '16',
        satAmount: '16',
      },
      user: {...userSlice(undefined, {type: 'init'}), username: 'merchant'},
      invoice: invoiceSlice(undefined, {type: 'init'}),
      transactionHistory: transactionHistorySlice(undefined, {type: 'init'}),
    },
  });
  const navigation = {
    pop: jest.fn(),
    navigate: jest.fn(),
    setParams: jest.fn(),
    goBack: jest.fn(),
    reset: jest.fn(),
    getState: () => ({
      routes: [
        HOME,
        {key: 'Invoice-1', name: 'Invoice'},
        {key: 'Charge-1', name: 'CashuCardCharge'},
      ],
    }),
  };
  const utils = render(
    <Provider store={store}>
      <CashuCardCharge
        navigation={navigation as never}
        route={{params} as never}
      />
    </Provider>,
  );
  await act(async () => {});
  return {...utils, navigation, store};
};

const title = (getByTestId: (id: string) => any) =>
  getByTestId('phase-title').props.children;
const raw = (getByTestId: (id: string) => any) =>
  within(getByTestId('phase-raw')).getByText(/./).props.children;

beforeEach(() => {
  jest.clearAllMocks();
  mockViewRenders.count = 0;
  mockIsCardReadingSupported.mockResolvedValue(true);
  mockCancelCardSession.mockResolvedValue(undefined);
  mockRunAutoSettlement.mockResolvedValue(undefined);
  // The session runs its callback with a fake transceiver: the service mocks
  // decide what happens inside.
  mockWithCardSession.mockImplementation(
    (fn: (t: unknown) => Promise<unknown>) => fn(jest.fn()),
  );
});

/**
 * Leave the microtask machinery real. Faking queueMicrotask / nextTick /
 * setImmediate stalls React's act() under Node 22 (the CI runtime): every
 * test after the first fake-timer one hung for 5 s, while Node 24 passed.
 */
const FAKE_TIMERS: Parameters<typeof jest.useFakeTimers>[0] = {
  doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
};

afterEach(() => {
  jest.useRealTimers();
});

describe('CashuCardCharge', () => {
  it('shows the card, the amount and the tap button before any charge — and nothing else', async () => {
    const {getByText, getByTestId, queryByText} = await renderScreen();
    expect(getByText('Charge by card')).toBeTruthy();
    expect(getByText('16 sats')).toBeTruthy();
    expect(getByText('Tap card to charge', visible)).toBeTruthy();
    expect(title(getByTestId)).toBe('Ready to charge');
    expect(
      getByText('Then hold the card to the top of the phone', visible),
    ).toBeTruthy();
    expect(getByTestId('ecash-card').props.accessibilityLabel).toBe(
      'eCash card',
    );
    // Retired furniture.
    expect(queryByText('Charge by eCash card', all)).toBeNull();
    expect(queryByText(/NFC available/, all)).toBeNull();
    expect(queryByText('yes', all)).toBeNull();
    expect(queryByText('Customer pays by tapping their card.', all)).toBeNull();
  });

  it('feeds every phase to the stage and hands off to Success in ONE reset', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockReadAndPlan.mockImplementation(
      async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        onPhase('reading card');
        return PLAN;
      },
    );
    mockExecuteCharge.mockImplementation(
      async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        onPhase('burning 16 sat (proof 1/2)');
        onPhase('burning 8 sat (proof 2/2)');
        onPhase('settling payment and minting change');
        onPhase('writing change to card');
        onPhase('writing change to card');
        onPhase('reading card');
        await gate;
        return {
          amountSat: 16,
          burned: [],
          changeSat: 8,
          changeLoaded: 2,
          balanceAfter: 8,
        };
      },
    );

    const {getByText, getByTestId, queryByText, navigation, store} =
      await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });

    // The closing balance read: the money has moved.
    expect(title(getByTestId)).toBe('Checking the card');
    expect(raw(getByTestId)).toBe('reading card');
    expect(mockSetCardSessionMessage).toHaveBeenLastCalledWith(
      'Checking the card',
    );
    expect(mockSetCardSessionMessage).toHaveBeenCalledWith(
      'Putting 8 sats on the card',
    );
    expect(getByText('Cancel', visible)).toBeTruthy();
    expect(getByText('Keep the card on the phone', visible)).toBeTruthy();
    expect(queryByText(/NFC available/, all)).toBeNull();
    expect(
      within(getByTestId('chip-from')).getAllByText('24').length,
    ).toBeGreaterThan(0);
    expect(getByText('•••• 7F3A')).toBeTruthy();
    expect(getByTestId('ecash-card').props.accessibilityLabel).toBe(
      'eCash card ending 7F3A',
    );

    await act(async () => {
      release();
    });
    // The customer is told to lift the card the moment the session resolves.
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    expect(queryByText('Cancel', all)).toBeNull();
    expect(queryByText('Keep the card on the phone', visible)).toBeNull();
    expect(navigation.reset).not.toHaveBeenCalled();

    // Bookkeeping waits one frame, so it cannot delay the finale's start;
    // settlement waits until Success is up, so it cannot delay the hand-off.
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    expect(store.getState().transactionHistory.transactions[0]).toMatchObject({
      transactionType: 'ecash',
      paymentMethod: 'card',
    });
    expect(mockRunAutoSettlement).not.toHaveBeenCalled();
    expect(navigation.reset).not.toHaveBeenCalled();

    // The hand-off goes out 40 ms ahead of the first frame that IS Success's
    // first frame (flood complete, badge on the Success centre, 1040 ms), so
    // Success mounts onto exactly that frame — well inside 1.25 s.
    expect(LIFT_HOLD_MS).toBe(1000);
    await act(async () => {
      jest.advanceTimersByTime(LIFT_HOLD_MS - 20);
    });
    expect(navigation.reset).toHaveBeenCalledTimes(1);
    expect(mockRunAutoSettlement).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(SETTLE_AFTER_HANDOFF_MS);
    });
    expect(mockRunAutoSettlement).toHaveBeenCalledWith('merchant');
    expect(navigation.reset).toHaveBeenCalledTimes(1);
    const [{index, routes}] = navigation.reset.mock.calls[0];
    expect(index).toBe(1);
    // Home is the SAME route object (same key): it does not remount.
    expect(routes[0]).toBe(HOME);
    expect(routes[1]).toEqual({
      name: 'Success',
      params: {title: 'Charged 16 sats — paid by eCash card', handoff: true},
    });
    expect(navigation.pop).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('does not re-render for a repeated identical phase', async () => {
    let emit!: (phase: string) => void;
    mockReadAndPlan.mockImplementation(
      ({onPhase}: {onPhase: (p: string) => void}) => {
        emit = onPhase;
        return new Promise(() => {});
      },
    );
    const {getByText, getByTestId} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    await act(async () => emit('reading card'));
    const after = mockViewRenders.count;
    for (let i = 0; i < 4; i++) {
      await act(async () => emit('reading card'));
    }
    expect(mockViewRenders.count).toBe(after);
    expect(mockSetCardSessionMessage).toHaveBeenCalledTimes(1);
    await act(async () => emit('verifying PIN'));
    expect(mockViewRenders.count).toBe(after + 1);
    expect(title(getByTestId)).toBe('Checking the PIN');
  });

  it('shows the error where it died, then a retry starts from the top', async () => {
    mockReadAndPlan.mockImplementation(
      async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        return PLAN;
      },
    );
    mockExecuteCharge
      .mockImplementationOnce(
        async ({onPhase}: {onPhase: (p: string) => void}) => {
          onPhase('reading card');
          onPhase('burning 16 sat (proof 1/2)');
          throw new Error('[burning 16 sat (proof 1/2)] tag lost');
        },
      )
      .mockImplementation(async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        return {
          amountSat: 16,
          burned: [],
          changeSat: 8,
          changeLoaded: 0,
          balanceAfter: 8,
        };
      });

    jest.useFakeTimers(FAKE_TIMERS);
    const {getByText, getByTestId, navigation} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByText('The card moved away', visible)).toBeTruthy();
    // Plain words in the body; the raw failure, verbatim, on the pill.
    expect(
      getByText('Hold the card to the phone again to finish.', visible),
    ).toBeTruthy();
    expect(
      within(getByTestId('error-pill')).getByText(
        '[burning 16 sat (proof 1/2)] tag lost',
      ),
    ).toBeTruthy();
    expect(getByText('Cancel', visible)).toBeTruthy();
    expect(navigation.reset).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(getByText('Tap card again'));
    });
    expect(mockReadAndPlan).toHaveBeenCalledTimes(2);
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(LIFT_HOLD_MS + 20);
    });
    expect(navigation.reset).toHaveBeenCalledTimes(1);
  });

  it('Cancel in the error state clears the error back to idle', async () => {
    mockReadAndPlan.mockRejectedValue(new Error('[reading card] tag lost'));
    const {getByText, getByTestId, queryByText} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByText('Tap card again', visible)).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByText('Cancel', visible));
    });
    expect(queryByText('Tap card again')).toBeNull();
    expect(title(getByTestId)).toBe('Ready to charge');
    expect(mockCancelCardSession).not.toHaveBeenCalled();
  });

  it('records the charge but never navigates when the screen unmounts during the held frame', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockReadAndPlan.mockResolvedValue(PLAN);
    mockExecuteCharge.mockResolvedValue({
      amountSat: 16,
      burned: [],
      changeSat: 8,
      changeLoaded: 1,
      balanceAfter: 8,
    });
    const {getByText, navigation, store, unmount} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(20);
    });
    // Hardware Back inside LIFT_HOLD_MS: the merchant is on another screen
    // by the time the hold ends, and a reset there would throw away ITS stack.
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(LIFT_HOLD_MS);
    });
    expect(store.getState().transactionHistory.transactions[0]).toMatchObject({
      transactionType: 'ecash',
      amount: {satAmount: 16},
    });
    expect(navigation.reset).not.toHaveBeenCalled();
    expect(navigation.pop).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("clears the previous card's ledger when a retry starts", async () => {
    mockReadAndPlan
      .mockResolvedValueOnce(PLAN)
      .mockImplementationOnce(() => new Promise(() => {}));
    mockExecuteCharge.mockRejectedValueOnce(
      new Error('[burning 16 sat (proof 1/2)] tag lost'),
    );
    const {getByText, getByTestId, queryByTestId} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    expect(
      getByText('Hold the card to the phone again to finish.', visible),
    ).toBeTruthy();
    expect(getByTestId('ledger')).toBeTruthy();

    // Session 1 of the retry is pending: the stage must show only real money
    // state, not the last card's notes.
    await act(async () => {
      fireEvent.press(getByText('Tap card again'));
    });
    expect(queryByTestId('ledger')).toBeNull();
    expect(title(getByTestId)).toBe('Waiting for the card');
  });

  it('opens straight on the PIN sheet when the router pre-read a PIN card, and auto-commits at four digits', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockExecuteCharge.mockImplementation(
      async ({onPhase}: {onPhase: (p: string) => void}) => {
        onPhase('reading card');
        onPhase('verifying PIN');
        return {
          amountSat: 16,
          burned: [],
          changeSat: 8,
          changeLoaded: 0,
          balanceAfter: 8,
        };
      },
    );
    const {getByText, getByLabelText, queryByText, navigation} =
      await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
    expect(navigation.setParams).toHaveBeenCalledWith({preRead: undefined});
    expect(getByText('Enter the card PIN', visible)).toBeTruthy();
    // Never an idle frame on the way in.
    expect(queryByText('Ready to charge', visible)).toBeNull();
    expect(queryByText('Tap card to charge', visible)).toBeNull();

    for (const digit of ['1', '9', '8', '4']) {
      fireEvent.press(getByLabelText(digit));
    }
    expect(
      getByText('Now hold the card to the phone again', visible),
    ).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    expect(mockExecuteCharge.mock.calls[0][0]).toMatchObject({
      pin: '1984',
      pinRequired: true,
    });
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
  });

  it('hands the owed change the router read on to executeCharge (ENG-630)', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    const owedChange = [
      {id: 'card:aa', cardPubkey: PLAN.cardPubkey, amount: 4, nonce: 'aa'},
    ];
    const {getByLabelText} = await renderScreen({
      preRead: {...PLAN, pinRequired: true, owedChange},
    });
    for (const digit of ['1', '9', '8', '4']) {
      fireEvent.press(getByLabelText(digit));
    }
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    expect(mockExecuteCharge.mock.calls[0][0]).toMatchObject({
      pin: '1984',
      owedChange,
    });
  });

  it('keeps the PIN pose on a failed attempt: reason in the sheet, PIN cleared, no auto-retry', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockExecuteCharge.mockRejectedValue(
      new Error('[verifying PIN] wrong PIN — 2 tries left'),
    );
    const {getByText, getByLabelText} = await renderScreen({
      preRead: {...PLAN, pinRequired: true},
    });
    for (const digit of ['1', '2', '3', '4']) {
      fireEvent.press(getByLabelText(digit));
    }
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(getByText('Wrong PIN — 2 tries left. Try again.', visible)).toBeTruthy();
    expect(getByText('Enter the card PIN', visible)).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
  });

  it("tags the PIN sheet's reason line for the simulator e2e flows, empty until a failure (ENG-634)", async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockExecuteCharge.mockRejectedValue(
      new Error('[verifying PIN] wrong PIN — 2 tries left'),
    );
    const {getByTestId, getByLabelText} = await renderScreen({
      preRead: {...PLAN, pinRequired: true},
    });
    expect(getByTestId('pin-error-text').props.children).toBe('');
    for (const digit of ['1', '2', '3', '4']) {
      fireEvent.press(getByLabelText(digit));
    }
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(getByTestId('pin-error-text').props.children).toBe(
      'Wrong PIN — 2 tries left. Try again.',
    );
  });

  it('cancels the NFC session on Cancel and on unmount', async () => {
    mockWithCardSession.mockImplementation(() => new Promise(() => {}));
    const {getByText, unmount} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    fireEvent.press(getByText('Cancel', visible));
    expect(mockCancelCardSession).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockCancelCardSession).toHaveBeenCalledTimes(2);
  });

  it('blocks with a notice when the phone cannot read cards', async () => {
    mockIsCardReadingSupported.mockResolvedValue(false);
    const {getByText, getByTestId, queryByText} = await renderScreen();
    expect(title(getByTestId)).toBe('Card reading is off');
    expect(
      getByText(
        'This phone can’t read cards — turn on NFC in Settings',
        visible,
      ),
    ).toBeTruthy();
    expect(getByText('Open NFC settings', visible)).toBeTruthy();
    expect(queryByText('Tap card to charge', all)).toBeNull();
    expect(queryByText(/NFC available/, all)).toBeNull();
  });
});
