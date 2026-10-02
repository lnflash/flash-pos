import React from 'react';
import {Animated, Dimensions, StatusBar, StyleSheet} from 'react-native';
import {render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {NavigationContainer} from '@react-navigation/native';
import {configureStore} from '@reduxjs/toolkit';
import Success from '../../src/screens/Success';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';
import amountSlice from '../../src/store/slices/amountSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';
import userSlice from '../../src/store/slices/userSlice';
import {SAT_CURRENCY} from '../../src/utils/satCurrency';
import {successBadgeCenter} from '../../src/utils/successBadge';
import {chargeLayout} from '../../src/components/cashu/charge/geometry';

const mockHoldEdgeTint = jest.fn();
const mockHideEdgeTint = jest.fn();
let mockReduceMotion = false;
jest.mock('../../src/utils/reduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));
jest.mock('../../src/utils/edgeTint', () => ({
  holdEdgeTint: () => mockHoldEdgeTint(),
  hideEdgeTint: (ms?: number) => mockHideEdgeTint(ms),
}));

// The components barrel drags in QR and progress-bar packages that ship as
// untransformed ESM; the screen only needs its two buttons, as the other
// screen tests do.
jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');
  const Button = ({btnText}: {btnText: string}) =>
    MockReact.createElement(Text, null, btnText);
  return {PrimaryButton: Button, SecondaryButton: Button};
});

jest.mock('../../src/hooks', () => ({
  usePrint: () => ({
    print: jest.fn(),
    printSilently: jest.fn(),
    printReceipt: jest.fn(),
    printReceiptHTML: jest.fn(),
  }),
  useFlashcard: () => ({setNfcEnabled: jest.fn()}),
}));

const SuccessScreen = Success as React.ComponentType<any>;

const jmd = {
  id: 'JMD',
  flag: '🇯🇲',
  name: 'Jamaican Dollar',
  symbol: 'J$',
  fractionDigits: 2,
};

const ecashTransaction: TransactionData = {
  id: 'cashu_1',
  timestamp: '2026-09-30T16:57:05.222Z',
  transactionType: 'ecash',
  paymentMethod: 'card',
  amount: {
    satAmount: 8,
    displayAmount: '1',
    currency: jmd,
    isPrimaryAmountSats: false,
  },
  merchant: {username: 'Dreadmax'},
  invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
  memo: '',
  status: 'completed',
} as TransactionData;

const renderSuccess = (
  preloadedState = {},
  params: Record<string, unknown> = {},
) => {
  const store = configureStore({
    reducer: {
      transactionHistory: transactionHistorySlice,
      amount: amountSlice,
      invoice: invoiceSlice,
      user: userSlice,
    },
    preloadedState,
  });
  const navigation = {reset: jest.fn(), navigate: jest.fn()};
  return render(
    <Provider store={store}>
      <NavigationContainer>
        <SuccessScreen navigation={navigation} route={{params}} />
      </NavigationContainer>
    </Provider>,
  );
};

describe('Success amount', () => {
  it('shows the recorded transaction even after the keypad reset the amount slice', () => {
    // The card charge pops through the keypad on its way here, and the
    // keypad's focus effect resets the amount slice — the live state can be
    // empty by the time this renders. The record was written before the pop.
    const {getByText} = renderSuccess({
      amount: {
        currency: jmd,
        isPrimaryAmountSats: false,
        displayAmount: undefined,
        satAmount: undefined,
        memo: '',
        loading: false,
      },
      transactionHistory: {
        transactions: [ecashTransaction],
        lastTransaction: ecashTransaction,
        maxTransactions: 50,
      },
    });

    expect(getByText('J$ 1')).toBeTruthy();
  });

  it('falls back to the amount slice when nothing has been recorded yet', () => {
    const {getByText} = renderSuccess({
      amount: {
        currency: jmd,
        isPrimaryAmountSats: false,
        displayAmount: '250',
        satAmount: 2000,
        memo: '',
        loading: false,
      },
      transactionHistory: {
        transactions: [],
        lastTransaction: undefined,
        maxTransactions: 50,
      },
    });

    expect(getByText('J$ 250')).toBeTruthy();
  });

  it('renders a sat-denominated record unit-last and pluralised, like the keypad', () => {
    // SAT's symbol is "sat", so the fiat layout printed "sat 13" (field-found
    // 2026-09-30). The keypad shows "13 sats"; the receipt must agree.
    const satTransaction = {
      ...ecashTransaction,
      id: 'cashu_2',
      amount: {
        satAmount: 13,
        displayAmount: '13',
        currency: SAT_CURRENCY,
        isPrimaryAmountSats: false,
      },
    } as TransactionData;
    const {getByText} = renderSuccess({
      transactionHistory: {
        transactions: [satTransaction],
        lastTransaction: satTransaction,
        maxTransactions: 50,
      },
    });

    expect(getByText('13 sats')).toBeTruthy();
  });

  it('singularises a one-sat record', () => {
    const satTransaction = {
      ...ecashTransaction,
      id: 'cashu_3',
      amount: {
        satAmount: 1,
        displayAmount: '1',
        currency: SAT_CURRENCY,
        isPrimaryAmountSats: false,
      },
    } as TransactionData;
    const {getByText} = renderSuccess({
      transactionHistory: {
        transactions: [satTransaction],
        lastTransaction: satTransaction,
        maxTransactions: 50,
      },
    });

    expect(getByText('1 sat')).toBeTruthy();
  });
});

describe('Success hand-off from the card charge', () => {
  // No SafeAreaProvider in the test tree: Success (and the charge layout)
  // fall back to the window.
  const frame = Dimensions.get('window');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('puts the badge exactly where the charge finale lands it, in every flow', () => {
    const expectedTop = successBadgeCenter(frame).y - 40;
    for (const params of [{}, {handoff: true}]) {
      const {getByTestId, unmount} = renderSuccess({}, params);
      const top = StyleSheet.flatten(
        getByTestId('success-hero').props.style,
      ).top;
      expect(top).toBe(expectedTop);
      // The finale's last frame: card centre + dy = the Success badge centre.
      const L = chargeLayout(frame);
      expect(
        Math.abs(L.finale.cy + L.finale.dy - (top + 40)),
      ).toBeLessThanOrEqual(1);
      expect(getByTestId('success-badge')).toBeTruthy();
      unmount();
    }
  });

  it('hand-off: the badge is static and the text rises in on ONE native clock', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const push = jest.spyOn(StatusBar, 'pushStackEntry');
    const pop = jest.spyOn(StatusBar, 'popStackEntry');
    const {getByText, unmount} = renderSuccess(
      {},
      {
        handoff: true,
        title: 'Charged 12 sats — paid by eCash card',
      },
    );
    expect(getByText('Charged 12 sats — paid by eCash card')).toBeTruthy();
    const entrance = timing.mock.calls.filter(
      ([, config]) => (config as {duration: number}).duration === 360,
    );
    expect(entrance).toHaveLength(1);
    expect(entrance[0][1]).toMatchObject({toValue: 1, useNativeDriver: true});
    expect(entrance[0][1]).not.toHaveProperty('delay');
    // The green reaches the insets and stays while Success is up.
    expect(mockHoldEdgeTint).toHaveBeenCalledTimes(1);
    // Light status-bar icons on the green, on both platforms, restored on
    // the way out (a stack entry, not a global setter).
    expect(push).toHaveBeenCalledWith({
      barStyle: 'light-content',
      animated: true,
    });
    const entry = push.mock.results[0].value;
    unmount();
    expect(mockHideEdgeTint).toHaveBeenCalledWith(200);
    expect(pop).toHaveBeenCalledWith(entry);
    timing.mockRestore();
    push.mockRestore();
    pop.mockRestore();
  });

  it('hand-off under reduce motion: the text fades in place, nothing rises', () => {
    mockReduceMotion = true;
    try {
      const {getByText} = renderSuccess(
        {},
        {handoff: true, title: 'Charged 12 sats — paid by eCash card'},
      );
      const title = getByText('Charged 12 sats — paid by eCash card');
      // The Animated.View around the title carries the entrance transform.
      type Host = {props: {style?: unknown}; parent: Host | null};
      let node: Host | null = title as unknown as Host;
      let translate: {__getValue: () => number} | null = null;
      while (node && !translate) {
        const style = StyleSheet.flatten(node.props.style as never) as {
          transform?: Array<{translateY?: {__getValue: () => number}}>;
        } | null;
        translate = style?.transform?.[0]?.translateY ?? null;
        node = node.parent;
      }
      expect(translate).not.toBeNull();
      // Constant 0 at every point of the entrance clock.
      expect(translate!.__getValue()).toBe(0);
    } finally {
      mockReduceMotion = false;
    }
  });

  it('a normal Success (lightning) renders as before: no entrance clock, no edge tint', () => {
    const timing = jest.spyOn(Animated, 'timing');
    const {getByText} = renderSuccess({}, {title: 'The invoice has been paid'});
    expect(getByText('The invoice has been paid')).toBeTruthy();
    expect(
      timing.mock.calls.filter(
        ([, config]) => (config as {duration: number}).duration === 360,
      ),
    ).toHaveLength(0);
    expect(mockHoldEdgeTint).not.toHaveBeenCalled();
    timing.mockRestore();
  });
});
