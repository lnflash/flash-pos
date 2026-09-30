import React from 'react';
import {render} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {NavigationContainer} from '@react-navigation/native';
import {configureStore} from '@reduxjs/toolkit';
import Success from '../../src/screens/Success';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';
import amountSlice from '../../src/store/slices/amountSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';
import userSlice from '../../src/store/slices/userSlice';

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

const renderSuccess = (preloadedState = {}) => {
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
        <SuccessScreen navigation={navigation} route={{params: {}}} />
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
});
