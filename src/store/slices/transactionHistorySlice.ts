import {createSlice, PayloadAction} from '@reduxjs/toolkit';

const initialState: TransactionHistoryState = {
  transactions: [],
  lastTransaction: undefined,
  maxTransactions: 50, // Keep last 50 transactions
};

export const transactionHistorySlice = createSlice({
  name: 'transactionHistory',
  initialState,
  reducers: {
    addTransaction: (state, action: PayloadAction<TransactionData>) => {
      const newTransaction = action.payload;
      
      // Add to beginning of array (most recent first)
      state.transactions.unshift(newTransaction);
      
      // Keep only maxTransactions
      if (state.transactions.length > state.maxTransactions) {
        state.transactions = state.transactions.slice(0, state.maxTransactions);
      }
      
      // Update last transaction if it's completed
      if (newTransaction.status === 'completed') {
        state.lastTransaction = newTransaction;
      }
    },
    
    updateTransactionStatus: (state, action: PayloadAction<{id: string; status: TransactionData['status']}>) => {
      const {id, status} = action.payload;
      const transaction = state.transactions.find(t => t.id === id);
      
      if (transaction) {
        transaction.status = status;
        
        // Update last transaction if this becomes completed
        if (status === 'completed') {
          state.lastTransaction = transaction;
        }
      }
    },
    
    clearTransactionHistory: (state) => {
      state.transactions = [];
      state.lastTransaction = undefined;
    },
    
    removeTransaction: (state, action: PayloadAction<string>) => {
      const id = action.payload;
      state.transactions = state.transactions.filter(t => t.id !== id);
      
      // Update lastTransaction if we removed it
      if (state.lastTransaction?.id === id) {
        state.lastTransaction = state.transactions.find(t => t.status === 'completed');
      }
    },
  },
});

export const {
  addTransaction,
  updateTransactionStatus,
  clearTransactionHistory,
  removeTransaction,
} = transactionHistorySlice.actions;

export default transactionHistorySlice.reducer;