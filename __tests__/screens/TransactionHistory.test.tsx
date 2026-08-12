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

// Mock the usePrint hook — capture printReceipt calls so tests can assert
// on the exact ReceiptData the screen hands to the printer
const mockPrintReceipt = jest.fn();
jest.mock('../../src/hooks/usePrint', () => ({
  __esModule: true,
  default: () => ({
    printReceipt: mockPrintReceipt,
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

const renderWithProviders = (
  component: React.ReactElement,
  initialState = {},
) => {
  const store = createTestStore(initialState);
  return render(
    <Provider store={store}>
      <NavigationContainer>{component}</NavigationContainer>
    </Provider>,
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
  beforeEach(() => {
    mockPrintReceipt.mockClear();
  });

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

  it('should render a fiat-primary refund with a minus sign, not like a sale', () => {
    const mockRefund: TransactionData = {
      ...mockTransaction,
      id: 'refund-tx-1',
      transactionType: 'refund',
      refundOf: mockTransaction.id,
      amount: {
        ...mockTransaction.amount,
        satAmount: -400,
        displayAmount: '4.00',
        isPrimaryAmountSats: false,
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

    const {getByText, queryByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    expect(getByText('-$ 4.00')).toBeTruthy();
    expect(queryByText('$ 4.00')).toBeNull();
    // The sale keeps its unsigned rendering
    expect(getByText('$ 10.00')).toBeTruthy();
  });

  it('should offer a Refunds filter chip that shows only refund rows', () => {
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

    const {getByText, queryByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    const refundChip = getByText(/Refunds \(1\)/);
    expect(refundChip).toBeTruthy();

    fireEvent.press(refundChip);

    // Refund row stays, sale row is filtered out
    expect(getByText('-$ 4.00')).toBeTruthy();
    expect(queryByText('$ 10.00')).toBeNull();
  });

  it('should not count a zero-amount reward in the With Rewards chip', () => {
    const zeroRewardTransaction: TransactionData = {
      ...mockTransaction,
      reward: {
        rewardAmount: 0,
        rewardRate: 0.02,
        wasMinimumApplied: false,
        wasMaximumApplied: false,
        isStandalone: false,
        timestamp: '2024-01-01T12:00:00Z',
      },
    };
    const initialState = {
      transactionHistory: {
        transactions: [zeroRewardTransaction],
        lastTransaction: zeroRewardTransaction,
        maxTransactions: 50,
      },
    };

    const {queryByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    // Statistics come from selectTransactionStatistics, which only counts
    // rewards with rewardAmount > 0 — the chip must agree with it.
    expect(queryByText(/With Rewards/)).toBeNull();
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

    // A sale reprints with its amounts exactly as stored — unsigned
    expect(mockPrintReceipt).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        satAmount: 1000,
        displayAmount: '10.00',
        transactionType: 'lightning',
      }),
    );
  });

  it('should reprint a refund with signed amounts, never like a sale receipt', () => {
    const mockRefund: TransactionData = {
      ...mockTransaction,
      id: 'refund-tx-1',
      transactionType: 'refund',
      refundOf: mockTransaction.id,
      amount: {
        ...mockTransaction.amount,
        satAmount: -800,
        displayAmount: '8.00',
        isPrimaryAmountSats: false,
      },
      invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
      memo: 'Refund',
    };
    const initialState = {
      transactionHistory: {
        transactions: [mockRefund],
        lastTransaction: mockRefund,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    fireEvent.press(getByText('Reprint'));

    // The receipt fiat must carry the sign — '$ 8.00' on paper would be
    // indistinguishable from a sale receipt
    expect(mockPrintReceipt).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        satAmount: -800,
        displayAmount: '-8.00',
        transactionType: 'refund',
      }),
    );
  });

  it('should reprint a positive-stored refund with signed amounts (issue #64)', () => {
    // Legacy rows persisted before refund-sign normalization can still carry
    // a positive amount — the receipt must sign them anyway
    const legacyRefund: TransactionData = {
      ...mockTransaction,
      id: 'refund-tx-legacy',
      transactionType: 'refund',
      refundOf: mockTransaction.id,
      amount: {
        ...mockTransaction.amount,
        satAmount: 800,
        displayAmount: '8.00',
        isPrimaryAmountSats: false,
      },
      invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
      memo: 'Refund',
    };
    const initialState = {
      transactionHistory: {
        transactions: [legacyRefund],
        lastTransaction: legacyRefund,
        maxTransactions: 50,
      },
    };

    const {getByText} = renderWithProviders(
      <TransactionHistoryScreen />,
      initialState,
    );

    fireEvent.press(getByText('Reprint'));

    expect(mockPrintReceipt).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        satAmount: -800,
        displayAmount: '-8.00',
        transactionType: 'refund',
      }),
    );
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
