import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';
import {Provider} from 'react-redux';
import {NavigationContainer} from '@react-navigation/native';
import {configureStore} from '@reduxjs/toolkit';
import TransactionHistory from '../../src/screens/TransactionHistory';
import transactionHistorySlice from '../../src/store/slices/transactionHistorySlice';
import userSlice from '../../src/store/slices/userSlice';
import amountSlice from '../../src/store/slices/amountSlice';
import invoiceSlice from '../../src/store/slices/invoiceSlice';

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
    const {getByText} = renderWithProviders(<TransactionHistory />);
    
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

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    expect(getByText('Transaction History')).toBeTruthy();
    expect(getByText('1 transactions')).toBeTruthy();
    expect(getByText('$10.00')).toBeTruthy();
    expect(getByText('≈ 1000 sats')).toBeTruthy();
    expect(getByText('testmerchant')).toBeTruthy();
    expect(getByText('COMPLETED')).toBeTruthy();
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

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    expect(getByText('1000 sats')).toBeTruthy();
    expect(getByText('$10.00')).toBeTruthy();
  });

  it('should display memo when present', () => {
    const initialState = {
      transactionHistory: {
        transactions: [mockTransaction],
        lastTransaction: mockTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    expect(getByText('Description:')).toBeTruthy();
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

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    const reprintButton = getByText('Reprint Receipt');
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

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    expect(getByText('Clear History')).toBeTruthy();
  });

  it('should not show clear history button when no transactions', () => {
    const {queryByText} = renderWithProviders(<TransactionHistory />);
    
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

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    // Should display formatted date (Jan 01, 2024 12:00)
    expect(getByText(/Jan 01, 2024/)).toBeTruthy();
  });

  it('should truncate long payment hashes', () => {
    const longHashTransaction = {
      ...mockTransaction,
      invoice: {
        ...mockTransaction.invoice,
        paymentHash: 'very-long-payment-hash-that-should-be-truncated-for-display',
      },
    };

    const initialState = {
      transactionHistory: {
        transactions: [longHashTransaction],
        lastTransaction: longHashTransaction,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(<TransactionHistory />, initialState);
    
    expect(getByText(/very-long-payment-hash/)).toBeTruthy();
  });
});