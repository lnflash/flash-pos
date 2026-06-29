import React from 'react';
import {act, render, waitFor} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {configureStore} from '@reduxjs/toolkit';
import Invoice from '../../src/screens/Invoice';
import rootReducer from '../../src/store/reducers';

const mockUseSubscription = jest.fn();
const mockUseLazyQuery = jest.fn();
const mockResetFlashcard = jest.fn();
const mockGetAllStoredCards = jest.fn(() => Promise.resolve([]));
const invoiceUnavailableMessage =
  'Please try again. Either the invoice has expired or it has not been paid.';

jest.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
  useSubscription: (...args: unknown[]) => mockUseSubscription(...args),
  useLazyQuery: (...args: unknown[]) => mockUseLazyQuery(...args),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => callback(),
}));

jest.mock('../../src/components', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    Amount: () => MockReact.createElement(Text, null, 'Amount'),
    ExpireTime: () => MockReact.createElement(Text, null, 'ExpireTime'),
    InvoiceQRCode: ({errMessage}: {errMessage?: string}) =>
      MockReact.createElement(Text, null, errMessage || 'InvoiceQRCode'),
    NfcButton: () => null,
    PrimaryButton: () => MockReact.createElement(Text, null, 'PrimaryButton'),
    TextButton: () => MockReact.createElement(Text, null, 'TextButton'),
  };
});

jest.mock('../../src/contexts/ActivityIndicator', () => {
  const MockReact = require('react');
  const {Text} = require('react-native');

  return {
    ActivityIndicator: () => MockReact.createElement(Text, null, 'Loading'),
  };
});

jest.mock('../../src/hooks', () => ({
  useFlashcard: () => ({
    loading: false,
    resetFlashcard: mockResetFlashcard,
    getAllStoredCards: mockGetAllStoredCards,
  }),
}));

jest.mock('@react-native-clipboard/clipboard', () => ({
  setString: jest.fn(),
}));

const paidSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'PAID',
    errors: [],
  },
};

const pendingSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'PENDING',
    errors: [],
  },
};

const erroredSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: undefined,
    errors: [
      {
        message: 'Invoice lookup is not ready yet',
        __typename: 'Error',
      },
    ],
  },
};

const expiredSubscriptionData = {
  lnInvoicePaymentStatus: {
    status: 'EXPIRED',
    errors: [],
  },
};

const deferredStatus = (status: string) => {
  let resolveStatus!: (value: unknown) => void;
  const promise = new Promise(resolve => {
    resolveStatus = resolve;
  });
  const confirmStatus = jest.fn(() => promise);

  return {
    confirmStatus,
    resolve: () =>
      resolveStatus({
        data: {
          lnInvoicePaymentStatus: {
            status,
            errors: [],
          },
        },
      }),
  };
};

const deferredStatusWithErrors = () => {
  let resolveStatus!: (value: unknown) => void;
  const promise = new Promise(resolve => {
    resolveStatus = resolve;
  });
  const confirmStatus = jest.fn(() => promise);

  return {
    confirmStatus,
    resolve: () =>
      resolveStatus({
        data: {
          lnInvoicePaymentStatus: {
            status: undefined,
            errors: [
              {
                message: 'Invoice lookup is not ready yet',
                __typename: 'Error',
              },
            ],
          },
        },
      }),
  };
};

const renderInvoice = () => {
  const store = configureStore({
    reducer: rootReducer,
    preloadedState: {
      amount: {
        satAmount: '1000',
        displayAmount: '10.00',
        currency: {id: 'USD', symbol: '$', flag: '', name: 'US Dollar'},
        isPrimaryAmountSats: false,
        memo: 'test invoice',
        loading: false,
        error: '',
      },
      invoice: {
        paymentHash: 'payment-hash-1',
        paymentRequest: 'lnbc1000n1ptest',
        paymentSecret: 'payment-secret-1',
        loading: false,
        error: '',
      },
      user: {
        username: 'merchant',
        walletId: 'wallet-id',
      },
    } as any,
  });
  const navigation = {
    replace: jest.fn(),
    goBack: jest.fn(),
  };

  const view = render(
    <Provider store={store}>
      <Invoice navigation={navigation as any} route={{} as any} />
    </Provider>,
  );

  return {store, navigation, ...view};
};

describe('Invoice screen payment confirmation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSubscription.mockReturnValue({
      data: paidSubscriptionData,
      error: undefined,
    });
  });

  it('keeps showing the QR code while the invoice is pending', () => {
    mockUseSubscription.mockReturnValue({
      data: pendingSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(store.getState().invoice.paymentRequest).toBe('lnbc1000n1ptest');
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('keeps showing the QR code when the initial subscription status lookup errors', () => {
    mockUseSubscription.mockReturnValue({
      data: erroredSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(store.getState().invoice.paymentRequest).toBe('lnbc1000n1ptest');
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('ignores a paid subscription event when the status query says pending', async () => {
    const {confirmStatus, resolve} = deferredStatus('PENDING');
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('ignores a paid subscription event when the confirmation status lookup errors', async () => {
    const {confirmStatus, resolve} = deferredStatusWithErrors();
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {getByText, queryByText, store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(store.getState().transactionHistory.transactions).toHaveLength(0);
    expect(getByText('InvoiceQRCode')).toBeTruthy();
    expect(queryByText(invoiceUnavailableMessage)).toBeNull();
  });

  it('stores the transaction only after the status query confirms paid', async () => {
    const {confirmStatus, resolve} = deferredStatus('PAID');
    mockUseLazyQuery.mockReturnValue([confirmStatus]);

    const {store, navigation} = renderInvoice();

    await waitFor(() => expect(confirmStatus).toHaveBeenCalled());
    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('Success'));

    expect(store.getState().transactionHistory.transactions).toHaveLength(1);
  });

  it('shows an invoice error after the subscription reports expired', () => {
    mockUseSubscription.mockReturnValue({
      data: expiredSubscriptionData,
      error: undefined,
    });
    mockUseLazyQuery.mockReturnValue([jest.fn()]);

    const {getByText, navigation} = renderInvoice();

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(getByText(invoiceUnavailableMessage)).toBeTruthy();
  });
});
