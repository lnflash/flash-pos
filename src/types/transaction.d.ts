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
  reward?: {
    rewardAmount: number; // Reward sats earned
    rewardRate: number; // Percentage rate used (e.g., 0.02 for 2%)
    wasMinimumApplied: boolean; // Whether minimum constraint was applied
    wasMaximumApplied: boolean; // Whether maximum constraint was applied
    isStandalone: boolean; // Whether this was a standalone reward (no purchase)
    timestamp: string; // When reward was calculated/awarded
  };
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
  rewardAmount?: number;
  rewardRate?: number;
}
