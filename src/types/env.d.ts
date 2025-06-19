declare module '@env' {
  export const FLASH_GRAPHQL_URI = string;
  export const FLASH_GRAPHQL_WS_URI = string;
  export const FLASH_LN_ADDRESS_URL = string;
  export const FLASH_LN_ADDRESS = string;
  export const BTC_PAY_SERVER = string;
  export const PULL_PAYMENT_ID = string;

  // Reward system configuration
  export const DEFAULT_REWARD_RATE = string; // Default percentage rate (e.g., "0.02" for 2%)
  export const MIN_REWARD_SATS = string; // Minimum sats to award (e.g., "1")
  export const MAX_REWARD_SATS = string; // Maximum sats to award (e.g., "1000")
  export const STANDALONE_REWARD_SATS = string; // Default standalone reward (e.g., "21")
  export const REWARDS_ENABLED = string; // Global reward system toggle (e.g., "true")

  // Event Mode configuration - Phase 1 MVP
  export const EVENT_MODE_ENABLED = string; // Event mode toggle (e.g., "false")
  export const DEFAULT_EVENT_REWARD_LIMIT = string; // Total points limit (e.g., "10000")
  export const DEFAULT_EVENT_REWARD_RATE = string; // Event reward rate (e.g., "0.05" for 5%)
  export const DEFAULT_EVENT_CUSTOMER_LIMIT = string; // Max customers (e.g., "100")
  export const DEFAULT_EVENT_MERCHANT_REWARD_ID = string; // Event-specific merchant ID

  // Customer Tracking & Limits
  export const EVENT_CUSTOMER_REWARD_LIMIT = string; // Max rewards per customer (e.g., "1")
  export const EVENT_UNIQUE_CUSTOMERS_ONLY = string; // Only count unique customers (e.g., "true")
  export const EVENT_TRACK_BY = string; // Tracking method (e.g., "flashcard")

  // Transaction Filters
  export const EVENT_MIN_PURCHASE_AMOUNT = string; // Minimum purchase in sats (e.g., "500")
  export const EVENT_ALLOWED_PAYMENT_METHODS = string; // Allowed methods (e.g., "all")
  export const EVENT_EXCLUDE_REFUNDS = string; // Exclude refunds (e.g., "true")

  // Budget Controls
  export const EVENT_BUDGET_SATS = string; // Total budget in sats (e.g., "100000")
  export const EVENT_STOP_ON_BUDGET_EXCEED = string; // Hard stop on budget (e.g., "true")
  export const EVENT_BUDGET_WARNING_PERCENT = string; // Warning threshold (e.g., "80")

  // Display Settings
  export const EVENT_DISPLAY_NAME = string; // Customer-facing name
  export const EVENT_DISPLAY_MESSAGE = string; // Event message
  export const EVENT_SHOW_PROGRESS = string; // Show progress (e.g., "true")
}
