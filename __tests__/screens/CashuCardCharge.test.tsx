import React from 'react';
import {act, fireEvent, render, within} from '@testing-library/react-native';
import {BackHandler} from 'react-native';
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
import {PhaseError} from '../../src/services/phaseError';
import {
  NEEDS_CARD_BODY,
  PIN_CHANGE_NEEDS_CONNECTION_TEXT,
  PIN_ONLINE_ONLY_TEXT,
  REFUSED_BODY,
  SIGNATURE_INVALID_BODY,
  UNCONFIRMED_BODY,
} from '../../src/components/cashu/charge/money';
import {CardError, CardNeedsUpdateError} from '../../src/services/cashuCard';

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

// The card's clock: the screen fetches the tip header on mount. No network
// in a unit test.
const mockRefreshTipHeader = jest.fn(async () => null);
jest.mock('../../src/services/blockHeader', () => ({
  refreshTipHeader: () => mockRefreshTipHeader(),
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

// The press-able BackHandler: `mockPressBack` runs the subscriptions the way
// Android's hardware Back does, newest first.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/__mocks__/BackHandler'),
);

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

/** An exact bill: one 16-sat slot, no change. */
const EXACT = {
  ...PLAN,
  plan: {slots: [1], burnedSat: 16, changeSat: 0},
  unspent: [{slot: 1, amount: 16}],
};

/**
 * What `executeCharge` throws once the swap has settled the bill: a
 * `PhaseError` flagged `paid`, from "[phase] detail".
 */
const paidFailure = (message: string) => {
  const [, phase, detail] = /^\[([^\]]+)\]\s*(.*)$/.exec(message)!;
  return new PhaseError(phase, new Error(detail), {paid: true});
};

type BeforeRemove = (e: {
  preventDefault: () => void;
  data: {action: {type: string}};
}) => void;

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
  const beforeRemove: BeforeRemove[] = [];
  const navigation = {
    pop: jest.fn(),
    navigate: jest.fn(),
    setParams: jest.fn(),
    goBack: jest.fn(),
    reset: jest.fn(),
    addListener: jest.fn((event: string, cb: BeforeRemove) => {
      if (event !== 'beforeRemove') {
        return () => {};
      }
      beforeRemove.push(cb);
      return () => {
        beforeRemove.splice(beforeRemove.indexOf(cb), 1);
      };
    }),
    /** Fires `beforeRemove` as the stack does for a pop; true = prevented. */
    emitBeforeRemove: (type = 'GO_BACK') => {
      let prevented = false;
      for (const cb of [...beforeRemove]) {
        cb({preventDefault: () => (prevented = true), data: {action: {type}}});
      }
      return prevented;
    },
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

  it("fetches the tip header for the card's clock on mount", async () => {
    await renderScreen();
    expect(mockRefreshTipHeader).toHaveBeenCalledTimes(1);
  });

  it('a 0.x card says it needs an update: no PIN pad, no charge (decision 8)', async () => {
    mockReadAndPlan.mockRejectedValue(new CardNeedsUpdateError('0.x applet'));
    const {getByText, getAllByText, queryByText} = await renderScreen();
    await act(async () => {
      fireEvent.press(getByText('Tap card to charge'));
    });
    // The body, and the pill that carries the failure verbatim.
    expect(
      getAllByText('This card needs an update', visible).length,
    ).toBeGreaterThan(0);
    expect(queryByText('Enter the card PIN', visible)).toBeNull();
    expect(mockExecuteCharge).not.toHaveBeenCalled();
  });

  it('a card whose no-PIN allowance did not cover the bill after all (6A94 at SIGN): the PIN pad opens with the reason, and the PIN re-runs the charge', async () => {
    jest.useFakeTimers(FAKE_TIMERS);
    mockExecuteCharge
      .mockImplementationOnce(
        async ({onPhase}: {onPhase: (p: string) => void}) => {
          onPhase('reading card');
          onPhase('burning 16 sat (proof 1/1)');
          throw new PhaseError(
            'burning 16 sat (proof 1/1)',
            new CardError(0x6a94, 'SPEND_ALL_SIGN'),
          );
        },
      )
      .mockImplementation(async () => ({
        amountSat: 16,
        burned: [],
        changeSat: 0,
        changeLoaded: 0,
        balanceAfter: 0,
      }));
    const {getByText, getByLabelText, getByTestId} = await renderScreen({
      preRead: {...EXACT, pinRequired: false, pinSet: true},
    });

    expect(getByText('Enter the card PIN', visible)).toBeTruthy();
    expect(getByTestId('pin-error-text').props.children).toBe(
      "This payment needs the card's PIN.",
    );
    expect(mockExecuteCharge).toHaveBeenCalledTimes(1);

    for (const digit of ['1', '9', '8', '4']) {
      fireEvent.press(getByLabelText(digit));
    }
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(mockExecuteCharge).toHaveBeenCalledTimes(2);
    expect(mockExecuteCharge.mock.calls[1][0]).toMatchObject({
      pin: '1984',
      pinRequired: true,
      pinSet: true,
    });
    expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
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
    expect(
      getByText('Wrong PIN — 2 tries left. Try again.', visible),
    ).toBeTruthy();
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

  describe('a failure after the mint swap ends the charge as paid (ENG-642)', () => {
    /** Phases up to the change write, then the card's answer. */
    const failsWritingChange =
      (message: string) =>
      async ({
        onPhase,
        onBurnStart,
      }: {
        onPhase: (p: string) => void;
        onBurnStart?: () => void;
      }) => {
        onPhase('reading card');
        onPhase('verifying PIN');
        // The service's burn point (ENG-645).
        onBurnStart?.();
        onPhase('burning 16 sat (proof 1/2)');
        onPhase('burning 8 sat (proof 2/2)');
        onPhase('settling payment and minting change');
        onPhase('writing change to card');
        throw paidFailure(message);
      };

    const enterPin = async (
      getByLabelText: (label: string) => any,
      digits = ['1', '9', '8', '4'],
    ) => {
      for (const digit of digits) {
        fireEvent.press(getByLabelText(digit));
      }
      await act(async () => {
        jest.advanceTimersByTime(700);
      });
    };

    /**
     * Paid, change saved, no way to run the charge again. The headline (the
     * big text) says paid too: "Charge didn't finish" or "The card moved
     * away" over a paid body sends the merchant to charge the card again.
     */
    const expectPaidNoRetry = async (
      utils: Awaited<ReturnType<typeof renderScreen>>,
      body: string,
      headline = 'Paid — change not on card',
    ) => {
      const {getByTestId, getByText, queryByTestId, queryByText} = utils;
      expect(getByTestId('error-title').props.children).toBe(headline);
      expect(getByTestId('error-title', visible)).toBeTruthy();
      for (const unpaid of [
        'Charge didn’t finish',
        'The card moved away',
        'The card is full',
      ]) {
        expect(queryByText(unpaid, all)).toBeNull();
      }
      expect(getByTestId('error-body').props.children).toBe(body);
      expect(getByText(body, visible)).toBeTruthy();
      // No PIN pad to re-enter a PIN into, no "Tap card again", no Cancel
      // back to a fresh charge for the same bill: Done is the one way out.
      expect(queryByTestId('pin-sheet', all)).toBeNull();
      expect(queryByTestId('pin-error-text', all)).toBeNull();
      expect(queryByText('Enter the card PIN', visible)).toBeNull();
      expect(queryByText('Tap card again', all)).toBeNull();
      expect(queryByText('Cancel', visible)).toBeNull();
      expect(getByText('Done', visible)).toBeTruthy();
      // The ledger stays on the paid bill.
      expect(getByTestId('ledger')).toBeTruthy();
      expect(getByTestId('chip-paid')).toBeTruthy();
    };

    it('a PIN card whose change LOAD answers 6A84: no PIN pad, change saved on the terminal, executeCharge runs once', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        failsWritingChange(
          '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
        ),
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      const {getByLabelText, getByText, queryByLabelText, store, navigation} =
        utils;
      await enterPin(getByLabelText);

      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added once the card has a free slot.',
      );

      // The customer tries the PIN again: there is no pad to type it into,
      // and nothing re-runs the charge on its own.
      expect(queryByLabelText('1')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      expect(mockReadAndPlan).not.toHaveBeenCalled();

      // Ended as paid: the bill is in the history and the invoice is gone.
      expect(store.getState().transactionHistory.transactions).toHaveLength(1);
      expect(store.getState().transactionHistory.transactions[0]).toMatchObject(
        {
          transactionType: 'ecash',
          paymentMethod: 'card',
          amount: {satAmount: 16},
          status: 'completed',
        },
      );
      expect(mockRunAutoSettlement).toHaveBeenCalledWith('merchant');
      // Never the Success hand-off: the change did not land.
      expect(navigation.reset).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.press(getByText('Done', visible));
      });
      expect(navigation.reset).toHaveBeenCalledTimes(1);
      const [{index, routes}] = navigation.reset.mock.calls[0];
      expect(index).toBe(0);
      expect(routes).toEqual([HOME]);
      expect(routes[0]).toBe(HOME);
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a PIN card that loses the tag during the change write: no PIN pad, change added on the next charge', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        failsWritingChange('[writing change to card] Tag was lost.'),
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);

      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
      expect(
        within(utils.getByTestId('error-pill')).getByText(
          '[writing change to card] Tag was lost.',
        ),
      ).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a change write whose record did not land: paid, change not promised, still no PIN pad', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        failsWritingChange(
          '[writing change to card (unrecorded)] Tag was lost.',
        ),
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change could not be put on the card.',
      );
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a Cancel pressed during the change write still ends as paid', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      let fail!: () => void;
      mockExecuteCharge.mockImplementation(
        ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          // The service's burn point (ENG-645).
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/2)');
          onPhase('settling payment and minting change');
          onPhase('writing change to card');
          return new Promise((_, reject) => {
            fail = () =>
              reject(paidFailure('[writing change to card] Tag was lost.'));
          });
        },
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);
      fireEvent.press(utils.getByText('Cancel', visible));
      expect(mockCancelCardSession).toHaveBeenCalled();
      await act(async () => {
        fail();
      });
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
    });

    it('a PIN-less card whose change write fails: the same paid body, and no "Tap card again"', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockReadAndPlan.mockResolvedValue(PLAN);
      mockExecuteCharge.mockImplementation(
        failsWritingChange('[writing change to card] Tag was lost.'),
      );
      const utils = await renderScreen();
      await act(async () => {
        fireEvent.press(utils.getByText('Tap card to charge'));
      });
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a PIN-less card the router pre-read: the same paid end, never back to "Tap card to charge"', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        failsWritingChange(
          '[writing change to card] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
        ),
      );
      const utils = await renderScreen({preRead: PLAN});
      await act(async () => {});
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added once the card has a free slot.',
      );
      expect(utils.queryByText('Tap card to charge', visible)).toBeNull();
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a signed payment whose swap fails ambiguously with change due: paid, change owed at the next tap, no "Tap card again" (ENG-674 blocking 2b)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onPhase('verifying PIN');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/2)');
          onPhase('burning 8 sat (proof 2/2)');
          onPhase('settling payment and minting change');
          // The card already signed and burned the bill AND its own
          // change; the swap itself never confirmed (a network failure,
          // not a change write — nothing ever reached LOAD_PROOF).
          throw paidFailure(
            '[settling payment and minting change (change owed, next tap)] the request never reached the network (TypeError: Network request failed)',
          );
        },
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);

      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is saved on this terminal and will be added the next time this card is charged.',
      );
      // No "Tap card again" was ever rendered, and nothing re-charges the
      // card on its own (this is the exact bug ENG-674 blocking 2 fixes:
      // before it, this failure was thrown unpaid and the screen offered a
      // retry here).
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('pieces that could not be checked offline, whose swap fails ambiguously: "Not confirmed yet", never "Paid", and no re-charge (ENG-674)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/1)');
          onPhase('settling payment');
          throw paidFailure(
            '[settling payment — the mint has not confirmed it] the request never reached the network (TypeError: Network request failed)',
          );
        },
      );
      const utils = await renderScreen({preRead: PLAN});
      await act(async () => {});
      await expectPaidNoRetry(utils, UNCONFIRMED_BODY, 'Not confirmed yet');
      for (const paidTitle of ['Paid', 'Paid — change not on card']) {
        expect(utils.queryByText(paidTitle, all)).toBeNull();
      }
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('the mint refuses the swap after the card burned: "Not paid — the mint refused it", Done only, not recorded as a sale (ENG-674)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/1)');
          onPhase('settling payment and minting change');
          throw new PhaseError(
            'settling payment — the mint refused it',
            new Error('proofs could not be verified'),
            {refused: true},
          );
        },
      );
      const utils = await renderScreen({preRead: PLAN});
      await act(async () => {});
      const {getByTestId, getByText, queryByText} = utils;
      expect(getByTestId('error-title').props.children).toBe(
        'Not paid — the mint refused it',
      );
      expect(getByTestId('error-body').props.children).toBe(REFUSED_BODY);
      // The card has burned: Done is the one way out, never a re-charge.
      expect(queryByText('Tap card again', all)).toBeNull();
      expect(queryByText('Cancel', visible)).toBeNull();
      expect(getByText('Done', visible)).toBeTruthy();
      // Not a sale: nothing goes into the history.
      expect(
        utils.store.getState().transactionHistory.transactions,
      ).toHaveLength(0);
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('the card answers with a signature that does not verify: "Not paid", Done only, not recorded as a sale, no promise of a settlement (ENG-674)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/1)');
          throw new PhaseError(
            "settling payment — the card's signature is not valid",
            new Error(
              "the card's signature does not verify against the payment",
            ),
            {refused: true},
          );
        },
      );
      const utils = await renderScreen({preRead: EXACT});
      await act(async () => {});
      const {getByTestId, getByText, queryByText} = utils;
      expect(getByTestId('error-title').props.children).toBe(
        "Not paid — the card's signature is not valid",
      );
      expect(getByTestId('error-body').props.children).toBe(
        SIGNATURE_INVALID_BODY,
      );
      for (const wrong of [
        'Paid',
        'Not confirmed yet',
        'Paid — change not on card',
      ]) {
        expect(queryByText(wrong, all)).toBeNull();
      }
      expect(queryByText(/keeps trying/, all)).toBeNull();
      // The card has burned: Done is the one way out, never a re-charge.
      expect(queryByText('Tap card again', all)).toBeNull();
      expect(queryByText('Cancel', visible)).toBeNull();
      expect(getByText('Done', visible)).toBeTruthy();
      // Not a sale: nothing goes into the history, the invoice is kept.
      expect(
        utils.store.getState().transactionHistory.transactions,
      ).toHaveLength(0);
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      expect(
        utils.store.getState().transactionHistory.transactions,
      ).toHaveLength(0);
    });

    it('the card burned and its answer was lost: "Not confirmed yet", recoverable only if its next payment is on this terminal, no re-charge (ENG-674)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/1)');
          throw paidFailure(
            '[settling payment — the mint has not confirmed it (signature lost, next tap)] the card burned the payment and its signature was lost',
          );
        },
      );
      const utils = await renderScreen({preRead: EXACT});
      await act(async () => {});
      await expectPaidNoRetry(utils, NEEDS_CARD_BODY, 'Not confirmed yet');
      expect(utils.queryByText(UNCONFIRMED_BODY, all)).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    describe('once paid, every exit is Done (ENG-642)', () => {
      /** Router path: Keypad → Invoice → "Pay by Flashcard" → here, pre-read. */
      const settleViaRouter = async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        mockExecuteCharge.mockImplementation(
          failsWritingChange('[writing change to card] Tag was lost.'),
        );
        const utils = await renderScreen({preRead: PLAN});
        await act(async () => {});
        expect(utils.getByText('Done', visible)).toBeTruthy();
        return utils;
      };

      const expectHome = (navigation: {
        reset: jest.Mock;
        goBack: jest.Mock;
      }) => {
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(navigation.reset).toHaveBeenCalledTimes(1);
        const [{index, routes}] = navigation.reset.mock.calls[0];
        expect(index).toBe(0);
        expect(routes).toEqual([HOME]);
        expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      };

      it('the header back arrow resets to Home, never back onto the Invoice', async () => {
        const {getByTestId, navigation} = await settleViaRouter();
        await act(async () => {
          fireEvent.press(getByTestId('charge-back'));
        });
        expectHome(navigation);
      });

      it('hardware Back resets to Home, never back onto the Invoice', async () => {
        const {navigation} = await settleViaRouter();
        await act(async () => {
          (
            BackHandler as unknown as {mockPressBack: () => void}
          ).mockPressBack();
        });
        expectHome(navigation);
      });

      it('an edge swipe (any pop) is prevented and becomes Done', async () => {
        const {navigation} = await settleViaRouter();
        let prevented = false;
        await act(async () => {
          prevented = navigation.emitBeforeRemove('POP');
        });
        expect(prevented).toBe(true);
        expectHome(navigation);
        // Done's own reset passes through.
        expect(navigation.emitBeforeRemove('RESET')).toBe(false);
      });

      it('before the swap, Back is still a plain pop', async () => {
        jest.useFakeTimers(FAKE_TIMERS);
        mockExecuteCharge.mockRejectedValue(
          new Error('[burning 16 sat (proof 1/2)] Tag was lost.'),
        );
        const {getByTestId, getByText, navigation} = await renderScreen({
          preRead: PLAN,
        });
        await act(async () => {});
        expect(getByText('Tap card again', visible)).toBeTruthy();
        expect(navigation.emitBeforeRemove('POP')).toBe(false);
        fireEvent.press(getByTestId('charge-back'));
        expect(navigation.goBack).toHaveBeenCalledTimes(1);
        expect(navigation.reset).not.toHaveBeenCalled();
      });
    });

    it('a PIN-less exact bill that fails AFTER the swap on a non-change phase ends on Done, the card read once', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockReadAndPlan.mockResolvedValue(EXACT);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          // The service's burn point (ENG-645).
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/1)');
          onPhase('settling payment and minting change');
          onPhase('reading card');
          throw paidFailure('[reading card] Tag was lost.');
        },
      );
      const utils = await renderScreen();
      await act(async () => {
        fireEvent.press(utils.getByText('Tap card to charge'));
      });
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. There is nothing more to do.',
        'Paid',
      );
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      expect(
        utils.store.getState().transactionHistory.transactions,
      ).toHaveLength(1);
      await act(async () => {
        fireEvent.press(utils.getByText('Done', visible));
      });
      expect(utils.navigation.reset).toHaveBeenCalledTimes(1);
      expect(mockReadAndPlan).toHaveBeenCalledTimes(1);
    });

    /**
     * A fallback, not a state the service reaches today: with change in the
     * plan, `executeCharge` reports a bookkeeping failure as a change-write
     * failure (a LOAD failed) or as "(change on card)" (every LOAD landed),
     * never as a bare "[recording the payment]". The screen must still end
     * any paid failure it cannot place as paid, with nothing promised about
     * the change (ENG-645 review).
     */
    it('fallback: a bare "[recording the payment]" paid failure with change in the plan still ends paid, no PIN pad, change not promised', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onPhase('verifying PIN');
          // The service's burn point (ENG-645).
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/2)');
          onPhase('burning 8 sat (proof 2/2)');
          onPhase('settling payment and minting change');
          throw paidFailure('[recording the payment] keychain write denied');
        },
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change did not reach the card.',
      );
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a PIN card whose bookkeeping fails but whose change landed: headlined "Paid", the change on the card, no PIN pad', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge.mockImplementation(
        async ({
          onPhase,
          onBurnStart,
        }: {
          onPhase: (p: string) => void;
          onBurnStart?: () => void;
        }) => {
          onPhase('reading card');
          onPhase('verifying PIN');
          // The service's burn point (ENG-645).
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/2)');
          onPhase('burning 8 sat (proof 2/2)');
          onPhase('settling payment and minting change');
          onPhase('writing change to card');
          throw paidFailure(
            '[recording the payment (change on card)] keychain write denied',
          );
        },
      );
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      await enterPin(utils.getByLabelText);
      await expectPaidNoRetry(
        utils,
        '16 sats are paid. Your 8 sats change is on the card.',
        'Paid',
      );
      expect(utils.queryByText('Paid — change not on card', all)).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
    });

    it('a failure BEFORE the burn still returns to the PIN pad, and the re-entered PIN re-runs the charge', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      mockExecuteCharge
        .mockRejectedValueOnce(
          new Error('[verifying PIN] wrong PIN — 2 tries left'),
        )
        .mockRejectedValueOnce(new Error('[reading card] Tag was lost.'))
        .mockRejectedValueOnce(
          new Error(
            '[adding 4 sat of change owed from an earlier charge] LOAD_PROOF failed: card is full — no free slot (0x6A84)',
          ),
        )
        .mockResolvedValueOnce({
          amountSat: 16,
          burned: [],
          changeSat: 8,
          changeLoaded: 1,
          balanceAfter: 8,
        });
      const {getByLabelText, getByTestId, getByText, queryByText} =
        await renderScreen({preRead: {...PLAN, pinRequired: true}});

      await enterPin(getByLabelText, ['1', '2', '3', '4']);
      expect(getByTestId('pin-sheet')).toBeTruthy();
      expect(getByTestId('pin-error-text').props.children).toBe(
        'Wrong PIN — 2 tries left. Try again.',
      );
      expect(queryByText('Done', all)).toBeNull();

      await enterPin(getByLabelText);
      expect(getByTestId('pin-sheet')).toBeTruthy();
      expect(getByTestId('pin-error-text').props.children).toBe(
        'Tag was lost.',
      );

      await enterPin(getByLabelText);
      expect(getByTestId('pin-sheet')).toBeTruthy();
      expect(getByTestId('pin-error-text').props.children).toBe(
        'LOAD_PROOF failed: card is full — no free slot (0x6A84)',
      );
      expect(queryByText('Done', all)).toBeNull();

      await enterPin(getByLabelText);
      expect(mockExecuteCharge).toHaveBeenCalledTimes(4);
      expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
    });

    it('an offline refusal on the PIN sheet reads as one short sentence that may wrap, never cut off (ENG-698)', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      // The texts the service really throws, wrapped as `makeStep` wraps
      // them in the preparing step: refused before anything burns.
      const {CHANGE_NEEDS_MINT, ONLINE_ONLY, PHASE_PREPARING} =
        jest.requireActual('../../src/services/cashuCharge');
      mockExecuteCharge
        .mockImplementationOnce(
          async ({onPhase}: {onPhase: (p: string) => void}) => {
            onPhase('reading card');
            onPhase('verifying PIN');
            onPhase(PHASE_PREPARING);
            throw new PhaseError(PHASE_PREPARING, new Error(CHANGE_NEEDS_MINT));
          },
        )
        .mockRejectedValueOnce(
          new PhaseError(PHASE_PREPARING, new Error(ONLINE_ONLY)),
        );
      const {getByLabelText, getByTestId, queryByText} = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });

      await enterPin(getByLabelText);
      expect(getByTestId('pin-sheet')).toBeTruthy();
      const line = getByTestId('pin-error-text');
      expect(line.props.children).toBe(PIN_CHANGE_NEEDS_CONNECTION_TEXT);
      expect(line.props.numberOfLines).toBe(2);
      expect(line.props.textBreakStrategy).toBe('balanced');
      expect(queryByText(CHANGE_NEEDS_MINT, all)).toBeNull();

      await enterPin(getByLabelText);
      expect(getByTestId('pin-sheet')).toBeTruthy();
      expect(getByTestId('pin-error-text').props.children).toBe(
        PIN_ONLINE_ONLY_TEXT,
      );
      expect(mockExecuteCharge).toHaveBeenCalledTimes(2);
    });
  });

  describe('Back while the charge is in flight after the burn (ENG-645)', () => {
    type ExecArgs = {
      onPhase: (p: string) => void;
      onBurnStart?: () => void;
    };

    /**
     * executeCharge, held open mid change-write: past the PIN verify and the
     * first burn (`onBurnStart` called as the service does, before the first
     * SPEND_PROOF), the swap done, the change LOAD outstanding. `succeed` /
     * `failPaid` / `failUnpaid` settle it.
     */
    const heldAfterBurn = () => {
      const ctl = {
        succeed: () => {},
        failPaid: (_message: string) => {},
        failUnpaid: (_message: string) => {},
      };
      mockExecuteCharge.mockImplementation(
        ({onPhase, onBurnStart}: ExecArgs) => {
          onPhase('reading card');
          onPhase('verifying PIN');
          onBurnStart?.();
          onPhase('burning 16 sat (proof 1/2)');
          onPhase('burning 8 sat (proof 2/2)');
          onPhase('settling payment and minting change');
          onPhase('writing change to card');
          return new Promise((resolve, reject) => {
            ctl.succeed = () =>
              resolve({
                amountSat: 16,
                burned: [],
                changeSat: 8,
                changeLoaded: 1,
                balanceAfter: 8,
              });
            ctl.failPaid = message => reject(paidFailure(message));
            ctl.failUnpaid = message => reject(new Error(message));
          });
        },
      );
      return ctl;
    };

    /** Held before the burn: the PIN verify is still outstanding. */
    const heldBeforeBurn = () => {
      const ctl = {fail: (_message: string) => {}};
      mockExecuteCharge.mockImplementation(({onPhase}: ExecArgs) => {
        onPhase('reading card');
        onPhase('verifying PIN');
        return new Promise((_, reject) => {
          ctl.fail = message => reject(new Error(message));
        });
      });
      return ctl;
    };

    const enterPin = async (getByLabelText: (label: string) => any) => {
      for (const digit of ['1', '9', '8', '4']) {
        fireEvent.press(getByLabelText(digit));
      }
      await act(async () => {
        jest.advanceTimersByTime(700);
      });
    };

    /**
     * The navigator's own hardware-Back handler, as react-navigation
     * registers it (before any screen's, so it runs last): a pop that
     * `beforeRemove` may prevent. Returns its remover.
     */
    const installNavigatorBack = (
      navigation: Awaited<ReturnType<typeof renderScreen>>['navigation'],
    ) =>
      BackHandler.addEventListener('hardwareBackPress', () => {
        if (!navigation.emitBeforeRemove('GO_BACK')) {
          navigation.goBack();
        }
        return true;
      });
    const pressHardwareBack = () =>
      (BackHandler as unknown as {mockPressBack: () => void}).mockPressBack();

    /** PIN card from the router, PIN entered, charge held after the burn. */
    const inFlight = async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      const ctl = heldAfterBurn();
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      const navigatorBack = installNavigatorBack(utils.navigation);
      await enterPin(utils.getByLabelText);
      expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      expect(title(utils.getByTestId)).toBe('Putting 8 sats on the card');
      return {...utils, ctl, navigatorBack};
    };

    const expectNoNavigation = (navigation: {
      goBack: jest.Mock;
      pop: jest.Mock;
      navigate: jest.Mock;
      reset: jest.Mock;
    }) => {
      expect(navigation.goBack).not.toHaveBeenCalled();
      expect(navigation.pop).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(navigation.reset).not.toHaveBeenCalled();
    };

    /** Success's hand-off, ONE reset to [Home, Success]. */
    const expectHandedOffToSuccess = async (navigation: {reset: jest.Mock}) => {
      await act(async () => {
        jest.advanceTimersByTime(LIFT_HOLD_MS);
      });
      expect(navigation.reset).toHaveBeenCalledTimes(1);
      const [{index, routes}] = navigation.reset.mock.calls[0];
      expect(index).toBe(1);
      expect(routes[0]).toBe(HOME);
      expect(routes[1]).toMatchObject({name: 'Success'});
    };

    it('the header back arrow does nothing: the charge finishes on screen and hands off to Success', async () => {
      const utils = await inFlight();
      const {getByTestId, getByText, navigation, ctl, navigatorBack} = utils;
      try {
        expect(getByTestId('charge-back').props.accessibilityState).toEqual(
          expect.objectContaining({disabled: true}),
        );
        await act(async () => {
          fireEvent.press(getByTestId('charge-back'));
        });
        // The press is refused even when it reaches the handler.
        await act(async () => {
          getByTestId('charge-back').props.onPress?.();
        });
        expectNoNavigation(navigation);
        expect(getByTestId('charge-view')).toBeTruthy();

        await act(async () => {
          ctl.succeed();
        });
        expect(getByText('Paid — you can lift the card', visible)).toBeTruthy();
        await expectHandedOffToSuccess(navigation);
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      } finally {
        navigatorBack.remove();
      }
    });

    it('hardware Back is swallowed, and the paid failure then ends on Done (Home), never the Invoice', async () => {
      const utils = await inFlight();
      const {getByText, navigation, ctl, navigatorBack} = utils;
      try {
        await act(async () => {
          pressHardwareBack();
        });
        expectNoNavigation(navigation);
        expect(utils.getByTestId('charge-view')).toBeTruthy();

        await act(async () => {
          ctl.failPaid('[writing change to card] Tag was lost.');
        });
        expect(getByText('Done', visible)).toBeTruthy();
        expect(utils.queryByText('Tap card again', all)).toBeNull();
        expect(navigation.goBack).not.toHaveBeenCalled();

        // Once paid, hardware Back is Done (ENG-642), still never a pop.
        await act(async () => {
          pressHardwareBack();
        });
        expect(navigation.goBack).not.toHaveBeenCalled();
        expect(navigation.reset).toHaveBeenCalledTimes(1);
        const [{index, routes}] = navigation.reset.mock.calls[0];
        expect(index).toBe(0);
        expect(routes).toEqual([HOME]);
        expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
      } finally {
        navigatorBack.remove();
      }
    });

    it('an edge swipe (any pop) is prevented while in flight, then becomes Done once paid', async () => {
      const utils = await inFlight();
      const {getByTestId, navigation, ctl, navigatorBack} = utils;
      try {
        let prevented = false;
        await act(async () => {
          prevented = navigation.emitBeforeRemove('POP');
        });
        expect(prevented).toBe(true);
        expectNoNavigation(navigation);

        await act(async () => {
          ctl.failPaid('[writing change to card] Tag was lost.');
        });
        // The header arrow is live again, as Done (ENG-642).
        expect(
          getByTestId('charge-back').props.accessibilityState?.disabled,
        ).toBeFalsy();
        await act(async () => {
          prevented = navigation.emitBeforeRemove('POP');
        });
        expect(prevented).toBe(true);
        expect(navigation.reset).toHaveBeenCalledTimes(1);
        expect(navigation.reset.mock.calls[0][0].routes).toEqual([HOME]);
        // Done's own reset passes through.
        expect(navigation.emitBeforeRemove('RESET')).toBe(false);
      } finally {
        navigatorBack.remove();
      }
    });

    it("the Success hand-off's own reset passes through the hold", async () => {
      const utils = await inFlight();
      const {navigation, ctl, navigatorBack} = utils;
      try {
        await act(async () => {
          ctl.succeed();
        });
        // During the held paid frame a pop is still refused …
        expect(navigation.emitBeforeRemove('POP')).toBe(true);
        await expectHandedOffToSuccess(navigation);
        // … and the hand-off's reset is not.
        expect(navigation.emitBeforeRemove('RESET')).toBe(false);
      } finally {
        navigatorBack.remove();
      }
    });

    it('a PIN-less charge the router pre-read holds the same way', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      const ctl = heldAfterBurn();
      const utils = await renderScreen({preRead: PLAN});
      const navigatorBack = installNavigatorBack(utils.navigation);
      try {
        await act(async () => {});
        expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
        await act(async () => {
          fireEvent.press(utils.getByTestId('charge-back'));
          pressHardwareBack();
        });
        expect(utils.navigation.emitBeforeRemove('POP')).toBe(true);
        expectNoNavigation(utils.navigation);
        await act(async () => {
          ctl.succeed();
        });
        await expectHandedOffToSuccess(utils.navigation);
      } finally {
        navigatorBack.remove();
      }
    });

    it('before the burn (PIN verify outstanding), Back still leaves: header, hardware and swipe', async () => {
      jest.useFakeTimers(FAKE_TIMERS);
      heldBeforeBurn();
      const utils = await renderScreen({
        preRead: {...PLAN, pinRequired: true},
      });
      const navigatorBack = installNavigatorBack(utils.navigation);
      try {
        await enterPin(utils.getByLabelText);
        expect(mockExecuteCharge).toHaveBeenCalledTimes(1);
        expect(
          utils.getByTestId('charge-back').props.accessibilityState?.disabled,
        ).toBeFalsy();
        expect(utils.navigation.emitBeforeRemove('POP')).toBe(false);
        fireEvent.press(utils.getByTestId('charge-back'));
        expect(utils.navigation.goBack).toHaveBeenCalledTimes(1);
        await act(async () => {
          pressHardwareBack();
        });
        expect(utils.navigation.goBack).toHaveBeenCalledTimes(2);
        expect(utils.navigation.reset).not.toHaveBeenCalled();
      } finally {
        navigatorBack.remove();
      }
    });

    it('a failure after the burn that is NOT paid releases the hold: Back leaves as before', async () => {
      const utils = await inFlight();
      const {getByTestId, getByText, navigation, ctl, navigatorBack} = utils;
      try {
        expect(navigation.emitBeforeRemove('POP')).toBe(true);
        await act(async () => {
          ctl.failUnpaid('[settling payment and minting change] offline');
        });
        expect(getByText('Enter the card PIN', visible)).toBeTruthy();
        expect(navigation.emitBeforeRemove('POP')).toBe(false);
        fireEvent.press(getByTestId('charge-back'));
        expect(navigation.goBack).toHaveBeenCalledTimes(1);
        expect(navigation.reset).not.toHaveBeenCalled();
      } finally {
        navigatorBack.remove();
      }
    });
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
