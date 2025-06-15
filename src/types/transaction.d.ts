// Transaction type enumeration for different payment flows
type TransactionType = 'lightning' | 'rewards-only' | 'standalone';

// Payment method types for tracking how the payment was made
type PaymentMethod =
  | 'lightning'
  | 'cash'
  | 'card'
  | 'check'
  | 'external'
  | 'other';

interface TransactionData {
  id: string;
  timestamp: string;
  // New fields for External Payment Rewards
  transactionType: TransactionType; // How the transaction was processed
  paymentMethod?: PaymentMethod; // How the customer paid (optional for backward compatibility)
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
    sentToCard?: boolean; // Whether rewards were sent to NFC card
    cardLnurl?: string; // LNURL of the card that received rewards
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
  // Enhanced fields for External Payment Rewards
  transactionType?: TransactionType;
  paymentMethod?: PaymentMethod;
  rewardAmount?: number;
  rewardRate?: number;
}

// For card-based rewards and NFC storage
interface StoredCardInfo {
  tagId: string; // NFC tag identifier
  lnurl: string; // Lightning URL for withdrawing rewards
  lastSeen: string; // ISO timestamp of when this card was last scanned
  balanceInSats?: number; // Last known card balance
}
