// Mock environment variables for testing
module.exports = {
  FLASH_GRAPHQL_URI: 'http://localhost:4000/graphql',
  FLASH_GRAPHQL_WS_URI: 'ws://localhost:4000/graphql',
  FLASH_LN_ADDRESS_URL: 'http://localhost:4000',
  FLASH_LN_ADDRESS: 'test@localhost',
  BTC_PAY_SERVER: 'http://localhost:4000',
  PULL_PAYMENT_ID: 'test-pull-payment-id',

  // Reward system configuration - Test defaults
  DEFAULT_REWARD_RATE: '0.02', // 2%
  MIN_REWARD_SATS: '1', // 1 sat minimum
  MAX_REWARD_SATS: '1000', // 1000 sats maximum
  STANDALONE_REWARD_SATS: '21', // 21 sats for standalone
  REWARDS_ENABLED: 'true', // Enabled by default
};
