import {store} from '../../src/store';
import {
  addTransaction,
  updateTransactionStatus,
  clearTransactionHistory,
  removeTransaction,
  selectTransactionStatistics,
} from '../../src/store/slices/transactionHistorySlice';

describe('transactionHistorySlice', () => {
  beforeEach(() => {
    store.dispatch(clearTransactionHistory());
  });

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

  describe('addTransaction', () => {
    it('should add a transaction to the history', () => {
      store.dispatch(addTransaction(mockTransaction));

      const state = store.getState();
      expect(state.transactionHistory.transactions).toHaveLength(1);
      expect(state.transactionHistory.transactions[0]).toEqual(mockTransaction);
    });

    it('should set lastTransaction when status is completed', () => {
      store.dispatch(addTransaction(mockTransaction));

      const state = store.getState();
      expect(state.transactionHistory.lastTransaction).toEqual(mockTransaction);
    });

    it('should not set lastTransaction when status is not completed', () => {
      const pendingTransaction = {...mockTransaction, status: 'pending' as const};
      store.dispatch(addTransaction(pendingTransaction));

      const state = store.getState();
      expect(state.transactionHistory.lastTransaction).toBeUndefined();
    });

    it('should maintain transactions in chronological order (newest first)', () => {
      const transaction1 = {...mockTransaction, id: 'tx-1', timestamp: '2024-01-01T12:00:00Z'};
      const transaction2 = {...mockTransaction, id: 'tx-2', timestamp: '2024-01-01T13:00:00Z'};

      store.dispatch(addTransaction(transaction1));
      store.dispatch(addTransaction(transaction2));

      const state = store.getState();
      expect(state.transactionHistory.transactions[0].id).toBe('tx-2');
      expect(state.transactionHistory.transactions[1].id).toBe('tx-1');
    });

    it('should limit transactions to maxTransactions', () => {
      // Add 52 transactions (exceeding maxTransactions of 50)
      for (let i = 0; i < 52; i++) {
        const transaction = {...mockTransaction, id: `tx-${i}`};
        store.dispatch(addTransaction(transaction));
      }

      const state = store.getState();
      expect(state.transactionHistory.transactions).toHaveLength(50);
    });
  });

  describe('updateTransactionStatus', () => {
    it('should update transaction status', () => {
      const pendingTransaction = {...mockTransaction, status: 'pending' as const};
      store.dispatch(addTransaction(pendingTransaction));
      store.dispatch(updateTransactionStatus({id: mockTransaction.id, status: 'completed'}));

      const state = store.getState();
      expect(state.transactionHistory.transactions[0].status).toBe('completed');
    });

    it('should update lastTransaction when status becomes completed', () => {
      const pendingTransaction = {...mockTransaction, status: 'pending' as const};
      store.dispatch(addTransaction(pendingTransaction));
      store.dispatch(updateTransactionStatus({id: mockTransaction.id, status: 'completed'}));

      const state = store.getState();
      expect(state.transactionHistory.lastTransaction?.id).toBe(mockTransaction.id);
    });
  });

  describe('removeTransaction', () => {
    it('should remove transaction from history', () => {
      store.dispatch(addTransaction(mockTransaction));
      store.dispatch(removeTransaction(mockTransaction.id));

      const state = store.getState();
      expect(state.transactionHistory.transactions).toHaveLength(0);
    });

    it('should update lastTransaction if removed transaction was the last', () => {
      const transaction1 = {...mockTransaction, id: 'tx-1'};
      const transaction2 = {...mockTransaction, id: 'tx-2'};

      store.dispatch(addTransaction(transaction1));
      store.dispatch(addTransaction(transaction2));
      store.dispatch(removeTransaction('tx-2')); // Remove the last transaction

      const state = store.getState();
      expect(state.transactionHistory.lastTransaction?.id).toBe('tx-1');
    });
  });

  describe('clearTransactionHistory', () => {
    it('should clear all transactions', () => {
      store.dispatch(addTransaction(mockTransaction));
      store.dispatch(clearTransactionHistory());

      const state = store.getState();
      expect(state.transactionHistory.transactions).toHaveLength(0);
      expect(state.transactionHistory.lastTransaction).toBeUndefined();
    });
  });

  describe('selectTransactionStatistics — sales total (issue #64)', () => {
    const mockRefund: TransactionData = {
      ...mockTransaction,
      id: 'refund-tx-1',
      transactionType: 'refund',
      refundOf: 'test-tx-1',
      amount: {
        ...mockTransaction.amount,
        satAmount: -400,
        displayAmount: '4.00',
      },
      invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
      memo: 'Refund',
    };

    it('sums sale amounts when there are only sales', () => {
      store.dispatch(addTransaction({...mockTransaction, id: 'sale-1'}));
      store.dispatch(addTransaction({...mockTransaction, id: 'sale-2'}));

      const stats = selectTransactionStatistics(store.getState());
      expect(stats.totalSales).toBe(2000);
      expect(stats.refundCount).toBe(0);
    });

    it('deducts a refund from the sales total instead of adding it', () => {
      store.dispatch(addTransaction({...mockTransaction, id: 'sale-1'}));
      store.dispatch(addTransaction(mockRefund));

      const stats = selectTransactionStatistics(store.getState());
      expect(stats.totalSales).toBe(600); // 1000 sale - 400 refund
      expect(stats.refundCount).toBe(1);
    });

    it('returns a negative total when history contains only a refund', () => {
      store.dispatch(addTransaction(mockRefund));

      const stats = selectTransactionStatistics(store.getState());
      expect(stats.totalSales).toBe(-400);
      expect(stats.refundCount).toBe(1);
      expect(stats.totalTransactions).toBe(1);
    });

    it('deducts a refund even if it was stored with a positive amount', () => {
      store.dispatch(addTransaction({...mockTransaction, id: 'sale-1'}));
      store.dispatch(
        addTransaction({
          ...mockRefund,
          amount: {...mockRefund.amount, satAmount: 400},
        }),
      );

      const stats = selectTransactionStatistics(store.getState());
      expect(stats.totalSales).toBe(600);
    });
  });
});
