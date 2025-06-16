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
}
