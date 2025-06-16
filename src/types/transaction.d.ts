interface TransactionData {
  id: string;
  timestamp: string;
  amount: {
    satAmount: number;
    displayAmount: string;
    currency: CurrencyItem;
    isPrimaryAmountSats: boolean;
  };
  merchant: {
    username: string;
  };
  invoice: {
    paymentHash: string;
    paymentRequest: string;
    paymentSecret: string;
  };
  memo?: string;
  status: 'pending' | 'completed' | 'failed';
}

interface TransactionHistoryState {
  transactions: TransactionData[];
  lastTransaction?: TransactionData;
  maxTransactions: number;
}

interface ReceiptData {
  id: string;
  timestamp: string;
  satAmount: number;
  displayAmount: string;
  currency: CurrencyItem;
  isPrimaryAmountSats: boolean;
  username: string;
  memo?: string;
  paymentHash: string;
  status: string;
}