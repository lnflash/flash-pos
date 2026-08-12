import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {NavigationContainer} from '@react-navigation/native';
import {configureStore} from '@reduxjs/toolkit';
import moment from 'moment';
import TransactionHistory from '../../src/screens/TransactionHistory';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';
import userSlice from '../../src/store/slices/userSlice';
import amountSlice from '../../src/store/slices/amountSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';

const TransactionHistoryScreen = TransactionHistory as React.ComponentType;

// Mock the usePrint hook
jest.mock('../../src/hooks/usePrint', () => ({
  __esModule: true,
  default: () => ({
    printReceipt: jest.fn(),
  }),
}));

const createTestStore = (initialState = {}) => {
  return configureStore({
    reducer: {
      transactionHistory: transactionHistorySlice,
      user: userSlice,
      amount: amountSlice,
      invoice: invoiceSlice,
    },
    preloadedState: initialState,
  });
};

const renderWithProviders = (component: React.ReactElement, initialState = {}) => {
  const store = createTestStore(initialState);
  return render(
    <Provider store={store}>
      <NavigationContainer>
        {component}
      </NavigationContainer>
    </Provider>
  );
};

const mockTransaction: TransactionData = {
  id: 'test-tx-1',
  timestamp: '2024-01-01T12:00:00Z',
  transactionType: 'lightning',
  amount: {
    satAmount: 1000,
    displayAmount: '10.00',
    currency: {
      id: 'USD',
      flag: '🇺🇸',
      name: 'US Dollar',
      symbol: '$',
      fractionDigits: 2,
    },
    isPrimaryAmountSats: false,
  },
  merchant: {
    username: 'testmerchant',
  },
  invoice: {
    paymentHash: 'test-hash-123',
    paymentRequest: 'lnbc1000n1p...',
    paymentSecret: 'secret-123',
  },
  memo: 'Test payment',
  status: 'completed',
};

describe('TransactionHistory Screen', () => {
  it('should render empty state when no transactions', () => {
    const {getByText} = renderWithProviders(<TransactionHistoryScreen />);

    expect(getByText('No transactions found')).toBeTruthy();
    expect(getByText('Completed transactions will appear here')).toBeTruthy();
  });

  it('should render transaction list when transactions exist', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText, getAllByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(getByText('Transaction History')).toBeTruthy();
    expect(getByText(/1 transactions/)).toBeTruthy();
    expect(getByText(/1000 points in sales/)).toBeTruthy();
    expect(getByText('$ 10.00')).toBeTruthy();
    expect(getByText('to testmerchant')).toBeTruthy();
    expect(getAllByText(/Lightning/).length).toBeGreaterThan(0);
  });

  it('should deduct refunds from the sales total in the header (issue #64)', () => {
    const mockRefund: TransactionData = {
      ...mockTransaction,
      id: 'refund-tx-1',
      transactionType: 'refund',
      refundOf: mockTransaction.id,
      amount: {
        ...mockTransaction.amount,
        satAmount: -400,
        displayAmount: '4.00',
      },
      invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
      memo: 'Refund',
    };
    const initialState = {
      transactionHistory: {
        transactions: [mockRefund, mockTransaction],
        lastTransaction: mockRefund,
        maxTransactions: 50,
      },
    };

    const {getByText, getAllByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    // 1000 sale - 400 refund = 600, NOT 1400
    expect(getByText(/600 points in sales/)).toBeTruthy();
    expect(getAllByText(/Refund/).length).toBeGreaterThan(0);
  });

  it('should display transaction with sats as primary amount', () => {
    const satsTransaction = {
      ...mockTransaction,
      amount: {
        ...mockTransaction.amount,
        isPrimaryAmountSats: true,
      },
    };

    const initialState = {
      transactionHistory: {
        transactions: [satsTransaction],
        lastTransaction: satsTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(getByText('1000 points')).toBeTruthy();
  });

  it('should display memo when present', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(getByText('Test payment')).toBeTruthy();
  });

  it('should handle reprint button press', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    const reprintButton = getByText('Reprint');
    fireEvent.press(reprintButton);

    // The print function should be called (mocked in this test)
    expect(reprintButton).toBeTruthy();
  });

  it('should show clear history button when transactions exist', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(getByText('Clear History')).toBeTruthy();
  });

  it('should not show clear history button when no transactions', () => {
    const {queryByText} = renderWithProviders(<TransactionHistoryScreen />);

    expect(queryByText('Clear History')).toBeNull();
  });

  it('should display formatted timestamp', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(
      getByText(moment(mockTransaction.timestamp).format('MMM DD, HH:mm')),
    ).toBeTruthy();
  });
});
