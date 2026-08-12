import {RewardCalculation} from './rewardCalculations';

/**
 * Create a Lightning transaction data object
 * @param params - Transaction parameters for Lightning payment
 * @returns Complete TransactionData object for Lightning payment
 */
export const createLightningTransaction = (params: {
  paymentHash: string;
  paymentRequest: string;
  paymentSecret: string;
  amount: {
    satAmount: number;
    displayAmount: string;
    currency: CurrencyItem;
    isPrimaryAmountSats: boolean;
  };
  merchant: {
    username: string;
  };
  memo?: string;
  reward?: {
    rewardAmount: number;
    rewardRate: number;
    wasMinimumApplied: boolean;
    wasMaximumApplied: boolean;
    isStandalone: boolean;
    timestamp: string;
  };
}): TransactionData => {
  return {
    id: params.paymentHash || `lightning_${Date.now()}`,
    timestamp: new Date().toISOString(),
    transactionType: 'lightning',
    paymentMethod: 'lightning',
    amount: params.amount,
    merchant: params.merchant,
    invoice: {
      paymentHash: params.paymentHash,
      paymentRequest: params.paymentRequest,
      paymentSecret: params.paymentSecret,
    },
    memo: params.memo,
    status: 'completed',
    reward: params.reward,
  };
};

/**
 * Create a rewards-only transaction data object for external payments
 * @param params - Transaction parameters for external payment rewards
 * @returns Complete TransactionData object for external payment rewards
 */
export const createRewardsOnlyTransaction = (params: {
  amount: {
    satAmount: number;
    displayAmount: string;
    currency: CurrencyItem;
    isPrimaryAmountSats: boolean;
  };
  merchant: {
    username: string;
  };
  paymentMethod: PaymentMethod;
  reward: {
    rewardAmount: number;
    rewardRate: number;
    wasMinimumApplied: boolean;
    wasMaximumApplied: boolean;
    isStandalone: boolean;
    timestamp: string;
  };
  memo?: string;
}): TransactionData => {
  return {
    id: `external_${Date.now()}`,
    timestamp: new Date().toISOString(),
    transactionType: 'rewards-only',
    paymentMethod: params.paymentMethod,
    amount: params.amount,
    merchant: params.merchant,
    invoice: {
      paymentHash: '', // No Lightning invoice for external payments
      paymentRequest: '',
      paymentSecret: '',
    },
    memo: params.memo || `${params.paymentMethod} payment reward`,
    status: 'completed',
    reward: params.reward,
  };
};

/**
 * Create a standalone transaction data object for flashcard-only rewards
 * @param params - Transaction parameters for standalone rewards
 * @returns Complete TransactionData object for standalone rewards
 */
export const createStandaloneTransaction = (params: {
  merchant: {
    username: string;
  };
  reward: {
    rewardAmount: number;
    rewardRate: number;
    wasMinimumApplied: boolean;
    wasMaximumApplied: boolean;
    isStandalone: boolean;
    timestamp: string;
  };
  currency?: CurrencyItem;
}): TransactionData => {
  const defaultCurrency: CurrencyItem = {
    id: 'USD',
    symbol: '$',
    name: 'US Dollar',
    flag: '🇺🇸',
    fractionDigits: 2,
  };

  return {
    id: `standalone_${Date.now()}`,
    timestamp: new Date().toISOString(),
    transactionType: 'standalone',
    paymentMethod: undefined, // No payment method for standalone rewards
    amount: {
      satAmount: 0, // No purchase amount for standalone
      displayAmount: '0',
      currency: params.currency || defaultCurrency,
      isPrimaryAmountSats: false,
    },
    merchant: params.merchant,
    invoice: {
      paymentHash: '', // No Lightning invoice for standalone
      paymentRequest: '',
      paymentSecret: '',
    },
    memo: 'Standalone flashcard reward',
    status: 'completed',
    reward: params.reward,
  };
};

/**
 * Create a refund transaction data object
 *
 * Refunds are stored with a NEGATIVE satAmount so that any summation over
 * transaction amounts deducts them from the sales total by construction
 * (issue #64: refunds were added to the sales total instead of deducted).
 *
 * @param params - Refund parameters (satAmount may be passed positive or
 *   negative; it is normalized to negative)
 * @returns Complete TransactionData object for the refund
 */
export const createRefundTransaction = (params: {
  amount: {
    satAmount: number;
    displayAmount: string;
    currency: CurrencyItem;
    isPrimaryAmountSats: boolean;
  };
  merchant: {
    username: string;
  };
  refundOf?: string;
  memo?: string;
}): TransactionData => {
  return {
    id: `refund_${Date.now()}`,
    timestamp: new Date().toISOString(),
    transactionType: 'refund',
    paymentMethod: 'lightning',
    amount: {
      ...params.amount,
      satAmount: -Math.abs(params.amount.satAmount),
    },
    merchant: params.merchant,
    invoice: {
      paymentHash: '', // Refunds are outgoing payments, no invoice of our own
      paymentRequest: '',
      paymentSecret: '',
    },
    memo: params.memo || 'Refund',
    status: 'completed',
    refundOf: params.refundOf,
  };
};

/**
 * Signed sat amount a transaction contributes to the sales total.
 *
 * Sales add their amount; refunds always SUBTRACT theirs — even if a refund
 * was stored with a positive satAmount (defensive against issue #64, where
 * refund amounts were added to the sales total instead of deducted).
 *
 * @param transaction - Transaction to evaluate
 * @returns Signed contribution in sats
 */
export const getSalesContribution = (transaction: TransactionData): number => {
  const satAmount = transaction.amount?.satAmount || 0;

  if (transaction.transactionType === 'refund') {
    return -Math.abs(satAmount);
  }

  return satAmount;
};

/**
 * Net sales total for a list of transactions, in sats.
 * Sales add; refunds deduct.
 *
 * @param transactions - Transactions to total
 * @returns Net sales total in sats
 */
export const calculateSalesTotal = (
  transactions: TransactionData[],
): number => {
  return transactions.reduce(
    (sum, transaction) => sum + getSalesContribution(transaction),
    0,
  );
};

/**
 * Create reward data from calculation result
 * @param calculation - Result from calculateReward function
 * @param isStandalone - Whether this is a standalone reward
 * @returns Reward data object for transaction
 */
export const createRewardData = (
  calculation: RewardCalculation,
  isStandalone: boolean = false,
) => {
  return {
    rewardAmount: calculation.rewardAmount,
    rewardRate: calculation.rewardRate || 0,
    wasMinimumApplied: calculation.appliedMinimum || false,
    wasMaximumApplied: calculation.appliedMaximum || false,
    isStandalone,
    timestamp: new Date().toISOString(),
  };
};

/**
 * Validate transaction data before creation
 * @param transactionData - Transaction data to validate
 * @returns Validation result
 */
export const validateTransactionData = (
  transactionData: Partial<TransactionData>,
) => {
  const errors: string[] = [];

  if (transactionData.transactionType === 'refund') {
    // Refunds must be stored negative so they deduct from the sales total
    if (
      !transactionData.amount?.satAmount ||
      transactionData.amount.satAmount >= 0
    ) {
      errors.push('Refund amount must be negative (a deduction from sales)');
    }
  } else if (
    !transactionData.amount?.satAmount ||
    transactionData.amount.satAmount < 0
  ) {
    if (transactionData.transactionType !== 'standalone') {
      errors.push(
        'Amount must be greater than 0 for non-standalone transactions',
      );
    }
  }

  if (!transactionData.merchant?.username) {
    errors.push('Merchant username is required');
  }

  if (!transactionData.transactionType) {
    errors.push('Transaction type is required');
  }

  if (
    transactionData.transactionType === 'lightning' &&
    !transactionData.invoice?.paymentHash
  ) {
    errors.push('Payment hash is required for Lightning transactions');
  }

  if (
    transactionData.transactionType === 'rewards-only' &&
    !transactionData.paymentMethod
  ) {
    errors.push('Payment method is required for external payment transactions');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};
