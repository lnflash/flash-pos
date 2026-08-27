type RootStackType = {
  Welcome: undefined;
  Auth: undefined;
  Home: undefined;
  Keypad: undefined;
  Rewards: RewardsScreenParams | undefined;
  Paycode: undefined;
  Profile: undefined;
  Invoice: undefined;
  Success?: {title?: string};
  RewardsSuccess: RewardsSuccessParams;
  FlashcardBalance: undefined;
  TransactionHistory: undefined;
  RewardsSettings: undefined;
  RegisteredRewardCards: undefined;
  EventSettings: undefined;
  SupportChat: undefined;
  // Dev-only route — the screen is registered under `__DEV__` in
  // src/routes/index.tsx, so navigating here in a release build typechecks but
  // fails at runtime with an unhandled NAVIGATE action. Guard every call site
  // with `__DEV__`; the Profile screen's dev row is the intended entry point.
  CashuCardDebug: undefined;
};

// Rewards screen parameters - all optional for backward compatibility
type RewardsScreenParams = {
  purchaseAmount?: number; // Amount in sats for purchase-based rewards
  purchaseCurrency?: string; // Currency symbol (e.g., "USD", "JMD")
  transactionId?: string; // Optional transaction linking
  purchaseDisplayAmount?: string; // Formatted amount for display (e.g., "$10.00")
  // External Payment Rewards support
  isExternalPayment?: boolean; // Whether this is an external payment (cash/card) vs Lightning
  paymentMethod?: PaymentMethod; // How the customer paid (cash, card, check, etc.)
};

// Enhanced RewardsSuccess screen parameters
type RewardsSuccessParams = {
  rewardSatAmount: number; // Required: amount of reward earned
  balance?: string; // Optional: updated total balance
  purchaseAmount?: number; // Optional: original purchase amount in sats
  purchaseCurrency?: string; // Optional: purchase currency
  purchaseDisplayAmount?: string; // Optional: formatted purchase amount
  rewardRate?: number; // Optional: percentage earned (e.g., 0.02 for 2%)
  calculationType?: 'purchase-based' | 'standalone'; // How the reward was calculated
  // External Payment Rewards support
  isExternalPayment?: boolean; // Whether this was an external payment reward
  paymentMethod?: PaymentMethod; // Payment method used
};
