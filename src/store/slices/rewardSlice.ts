import {createSlice, createSelector} from '@reduxjs/toolkit';

interface RewardState {
  rewardRate: number; // Percentage (e.g., 0.02 for 2%)
  minimumReward: number; // Minimum sats to award
  maximumReward: number; // Maximum sats to award
  defaultReward: number; // Fallback for standalone rewards
  merchantRewardId: string; // Pull Payment ID for BTCPay Server rewards
  isEnabled: boolean; // Global reward system toggle
  showStandaloneRewards: boolean; // Show/hide standalone rewards navigation
  loading: boolean; // For async operations
  error: string; // Error messages

  // Event Mode - Phase 1 MVP
  eventModeEnabled: boolean; // Event mode toggle
  eventRewardLimit: number; // Total points before auto-deactivation
  eventRewardRate: number; // Percentage override (e.g., 0.05 for 5%)
  eventCustomerLimit: number; // Max customers before auto-deactivation
  eventMerchantRewardId: string; // Override merchant reward ID

  // Customer Tracking
  eventCustomerRewardLimit: number; // Max rewards per customer
  eventUniqueCustomersOnly: boolean; // Only count unique customers
  eventTrackBy: 'flashcard' | 'phone' | 'email' | 'none'; // Tracking method
  eventRewardedCustomers: string[]; // Array of customer IDs who received rewards

  // Transaction Filters
  eventMinPurchaseAmount: number; // Minimum purchase to qualify (sats)
  eventAllowedPaymentMethods: string; // "all" or comma-separated list
  eventExcludeRefunds: boolean; // Don't reward refunded transactions

  // Budget Controls
  eventBudgetSats: number; // Total budget in sats
  eventStopOnBudgetExceed: boolean; // Hard stop when budget reached
  eventBudgetWarningPercent: number; // Warning threshold (0.0 to 1.0)

  // Display Settings
  eventDisplayName: string; // Customer-facing event name
  eventDisplayMessage: string; // Event message
  eventShowProgress: boolean; // Show progress to staff

  // Event Tracking
  eventTotalRewardsGiven: number; // Track total rewards given
  eventCustomersRewarded: number; // Track unique customers rewarded
  eventActive: boolean; // Whether event is currently active (not exhausted)
}

// Default configuration - can be overridden by environment variables in production
const getDefaultConfiguration = () => {
  try {
    // Try to load environment variables if available
    const {
      DEFAULT_REWARD_RATE,
      MIN_REWARD_SATS,
      MAX_REWARD_SATS,
      STANDALONE_REWARD_SATS,
      REWARDS_ENABLED,
      PULL_PAYMENT_ID,
      // Event Mode environment variables
      EVENT_MODE_ENABLED,
      DEFAULT_EVENT_REWARD_LIMIT,
      DEFAULT_EVENT_REWARD_RATE,
      DEFAULT_EVENT_CUSTOMER_LIMIT,
      DEFAULT_EVENT_MERCHANT_REWARD_ID,
      EVENT_CUSTOMER_REWARD_LIMIT,
      EVENT_UNIQUE_CUSTOMERS_ONLY,
      EVENT_TRACK_BY,
      EVENT_MIN_PURCHASE_AMOUNT,
      EVENT_ALLOWED_PAYMENT_METHODS,
      EVENT_EXCLUDE_REFUNDS,
      EVENT_BUDGET_SATS,
      EVENT_STOP_ON_BUDGET_EXCEED,
      EVENT_BUDGET_WARNING_PERCENT,
      EVENT_DISPLAY_NAME,
      EVENT_DISPLAY_MESSAGE,
      EVENT_SHOW_PROGRESS,
    } = require('@env');

    return {
      rewardRate: parseFloat(DEFAULT_REWARD_RATE || '0.02'),
      minimumReward: parseInt(MIN_REWARD_SATS || '1', 10),
      maximumReward: parseInt(MAX_REWARD_SATS || '1000', 10),
      defaultReward: parseInt(STANDALONE_REWARD_SATS || '21', 10),
      merchantRewardId: PULL_PAYMENT_ID || '',
      isEnabled: (REWARDS_ENABLED || 'true').toLowerCase() === 'true',
      showStandaloneRewards: false, // Default to off

      // Event Mode defaults
      eventModeEnabled:
        (EVENT_MODE_ENABLED || 'false').toLowerCase() === 'true',
      eventRewardLimit: parseInt(DEFAULT_EVENT_REWARD_LIMIT || '10000', 10),
      eventRewardRate: parseFloat(DEFAULT_EVENT_REWARD_RATE || '0.05'),
      eventCustomerLimit: parseInt(DEFAULT_EVENT_CUSTOMER_LIMIT || '100', 10),
      eventMerchantRewardId: DEFAULT_EVENT_MERCHANT_REWARD_ID || '',

      // Customer Tracking defaults
      eventCustomerRewardLimit: parseInt(
        EVENT_CUSTOMER_REWARD_LIMIT || '1',
        10,
      ),
      eventUniqueCustomersOnly:
        (EVENT_UNIQUE_CUSTOMERS_ONLY || 'true').toLowerCase() === 'true',
      eventTrackBy: (EVENT_TRACK_BY || 'flashcard') as
        | 'flashcard'
        | 'phone'
        | 'email'
        | 'none',
      eventRewardedCustomers: [],

      // Transaction Filter defaults
      eventMinPurchaseAmount: parseInt(EVENT_MIN_PURCHASE_AMOUNT || '500', 10),
      eventAllowedPaymentMethods: EVENT_ALLOWED_PAYMENT_METHODS || 'all',
      eventExcludeRefunds:
        (EVENT_EXCLUDE_REFUNDS || 'true').toLowerCase() === 'true',

      // Budget Control defaults
      eventBudgetSats: parseInt(EVENT_BUDGET_SATS || '100000', 10),
      eventStopOnBudgetExceed:
        (EVENT_STOP_ON_BUDGET_EXCEED || 'true').toLowerCase() === 'true',
      eventBudgetWarningPercent:
        parseFloat(EVENT_BUDGET_WARNING_PERCENT || '80') / 100,

      // Display Settings defaults
      eventDisplayName: EVENT_DISPLAY_NAME || 'Special Event',
      eventDisplayMessage: EVENT_DISPLAY_MESSAGE || 'Earn extra rewards!',
      eventShowProgress:
        (EVENT_SHOW_PROGRESS || 'true').toLowerCase() === 'true',

      // Event Tracking (always starts at 0)
      eventTotalRewardsGiven: 0,
      eventCustomersRewarded: 0,
      eventActive: false,
    };
  } catch (error) {
    // Fallback to hardcoded defaults if environment variables are not available
    return {
      rewardRate: 0.02, // 2% default
      minimumReward: 1, // Minimum 1 sat
      maximumReward: 1000, // Maximum 1000 sats
      defaultReward: 21, // Current fixed amount for standalone rewards
      merchantRewardId: '', // Empty by default, user must configure
      isEnabled: true, // Rewards enabled by default
      showStandaloneRewards: false, // Default to off

      // Event Mode hardcoded defaults
      eventModeEnabled: false,
      eventRewardLimit: 10000, // 10,000 sats total limit
      eventRewardRate: 0.05, // 5% event reward rate
      eventCustomerLimit: 100, // 100 customers max
      eventMerchantRewardId: '', // Empty, requires configuration

      // Customer Tracking defaults
      eventCustomerRewardLimit: 1, // One reward per customer
      eventUniqueCustomersOnly: true, // Only unique customers count
      eventTrackBy: 'flashcard' as const, // Use flashcard by default
      eventRewardedCustomers: [],

      // Transaction Filter defaults
      eventMinPurchaseAmount: 500, // 500 sats minimum
      eventAllowedPaymentMethods: 'all', // All payment methods
      eventExcludeRefunds: true, // Exclude refunds

      // Budget Control defaults
      eventBudgetSats: 100000, // 100,000 sats budget
      eventStopOnBudgetExceed: true, // Hard stop on budget
      eventBudgetWarningPercent: 0.8, // Warn at 80%

      // Display Settings defaults
      eventDisplayName: 'Special Event',
      eventDisplayMessage: 'Earn extra rewards!',
      eventShowProgress: true, // Show progress

      // Event Tracking
      eventTotalRewardsGiven: 0,
      eventCustomersRewarded: 0,
      eventActive: false,
    };
  }
};

const defaultConfig = getDefaultConfiguration();

const initialState: RewardState = {
  ...defaultConfig,
  loading: false,
  error: '',
};

export const rewardSlice = createSlice({
  name: 'reward',
  initialState,
  reducers: {
    setRewardRate: (state, action) => {
      // Enforce 0-10% limit
      const rate = Math.max(0, Math.min(0.1, action.payload));
      return {
        ...state,
        rewardRate: rate,
        error: '',
      };
    },
    setMinimumReward: (state, action) => {
      // Enforce minimum 1 sat
      const minimum = Math.max(1, action.payload);
      return {
        ...state,
        minimumReward: minimum,
        error: '',
      };
    },
    setMaximumReward: (state, action) => {
      // Enforce reasonable maximum
      const maximum = Math.max(state.minimumReward, action.payload);
      return {
        ...state,
        maximumReward: maximum,
        error: '',
      };
    },
    setDefaultReward: (state, action) => {
      // Enforce minimum 1 sat for default reward
      const defaultReward = Math.max(1, action.payload);
      return {
        ...state,
        defaultReward: defaultReward,
        error: '',
      };
    },
    setMerchantRewardId: (state, action) => ({
      ...state,
      merchantRewardId: action.payload || '',
      error: '',
    }),
    setIsEnabled: (state, action) => ({
      ...state,
      isEnabled: action.payload,
      error: '',
    }),
    setLoading: (state, action) => ({
      ...state,
      loading: action.payload,
    }),
    setError: (state, action) => ({
      ...state,
      error: action.payload,
    }),
    updateRewardConfig: (state, action) => {
      const {
        rewardRate,
        minimumReward,
        maximumReward,
        defaultReward,
        merchantRewardId,
        isEnabled,
        showStandaloneRewards,
      } = action.payload;

      return {
        ...state,
        rewardRate:
          rewardRate !== undefined
            ? Math.max(0, Math.min(0.1, rewardRate))
            : state.rewardRate,
        minimumReward:
          minimumReward !== undefined
            ? Math.max(1, minimumReward)
            : state.minimumReward,
        maximumReward:
          maximumReward !== undefined
            ? Math.max(state.minimumReward, maximumReward)
            : state.maximumReward,
        defaultReward:
          defaultReward !== undefined
            ? Math.max(1, defaultReward)
            : state.defaultReward,
        merchantRewardId:
          merchantRewardId !== undefined
            ? merchantRewardId
            : state.merchantRewardId,
        isEnabled: isEnabled !== undefined ? isEnabled : state.isEnabled,
        showStandaloneRewards:
          showStandaloneRewards !== undefined
            ? showStandaloneRewards
            : state.showStandaloneRewards,
        error: '',
      };
    },
    resetRewardConfig: () => ({
      ...initialState,
    }),

    // Event Mode reducers
    setEventModeEnabled: (state, action) => ({
      ...state,
      eventModeEnabled: action.payload,
      eventActive: action.payload, // Explicitly set based on action.payload
      error: '',
    }),
    setEventRewardLimit: (state, action) => ({
      ...state,
      eventRewardLimit: Math.max(1, Math.min(1000000, action.payload)),
      error: '',
    }),
    setEventRewardRate: (state, action) => ({
      ...state,
      eventRewardRate: Math.max(0, Math.min(1, action.payload)),
      error: '',
    }),
    setEventCustomerLimit: (state, action) => ({
      ...state,
      eventCustomerLimit: Math.max(1, Math.min(10000, action.payload)),
      error: '',
    }),
    setEventMerchantRewardId: (state, action) => ({
      ...state,
      eventMerchantRewardId: action.payload || '',
      error: '',
    }),
    updateEventConfig: (state, action) => {
      const {
        eventRewardLimit,
        eventRewardRate,
        eventCustomerLimit,
        eventMerchantRewardId,
        eventCustomerRewardLimit,
        eventMinPurchaseAmount,
        eventBudgetSats,
        eventBudgetWarningPercent,
        eventDisplayName,
        eventDisplayMessage,
      } = action.payload;

      return {
        ...state,
        eventRewardLimit:
          eventRewardLimit !== undefined
            ? Math.max(1, Math.min(1000000, eventRewardLimit))
            : state.eventRewardLimit,
        eventRewardRate:
          eventRewardRate !== undefined
            ? Math.max(0, Math.min(1, eventRewardRate))
            : state.eventRewardRate,
        eventCustomerLimit:
          eventCustomerLimit !== undefined
            ? Math.max(1, Math.min(10000, eventCustomerLimit))
            : state.eventCustomerLimit,
        eventMerchantRewardId:
          eventMerchantRewardId !== undefined
            ? eventMerchantRewardId
            : state.eventMerchantRewardId,
        eventCustomerRewardLimit:
          eventCustomerRewardLimit !== undefined
            ? Math.max(1, eventCustomerRewardLimit)
            : state.eventCustomerRewardLimit,
        eventMinPurchaseAmount:
          eventMinPurchaseAmount !== undefined
            ? Math.max(0, eventMinPurchaseAmount)
            : state.eventMinPurchaseAmount,
        eventBudgetSats:
          eventBudgetSats !== undefined
            ? Math.max(1, eventBudgetSats)
            : state.eventBudgetSats,
        eventBudgetWarningPercent:
          eventBudgetWarningPercent !== undefined
            ? Math.max(0, Math.min(1, eventBudgetWarningPercent))
            : state.eventBudgetWarningPercent,
        eventDisplayName:
          eventDisplayName !== undefined
            ? eventDisplayName
            : state.eventDisplayName,
        eventDisplayMessage:
          eventDisplayMessage !== undefined
            ? eventDisplayMessage
            : state.eventDisplayMessage,
        error: '',
      };
    },
    activateEvent: state => ({
      ...state,
      eventActive: state.eventModeEnabled, // Only activate if enabled
      eventTotalRewardsGiven: 0, // Reset counters
      eventCustomersRewarded: 0,
      eventRewardedCustomers: [],
      error: '',
    }),
    deactivateEvent: state => ({
      ...state,
      eventActive: false,
      error: '',
    }),
    trackEventReward: (state, action) => {
      const {rewardAmount, customerId} = action.payload;
      const newTotalRewards = state.eventTotalRewardsGiven + rewardAmount;

      // Check if customer already rewarded
      const isNewCustomer =
        customerId && !state.eventRewardedCustomers.includes(customerId);
      const newCustomersRewarded = isNewCustomer
        ? state.eventCustomersRewarded + 1
        : state.eventCustomersRewarded;

      // Check if limits exceeded
      const budgetExceeded =
        state.eventBudgetSats > 0 && newTotalRewards >= state.eventBudgetSats;
      const customerLimitExceeded =
        newCustomersRewarded >= state.eventCustomerLimit;
      const shouldDeactivate =
        state.eventStopOnBudgetExceed &&
        (budgetExceeded || customerLimitExceeded);

      return {
        ...state,
        eventTotalRewardsGiven: newTotalRewards,
        eventCustomersRewarded: newCustomersRewarded,
        eventRewardedCustomers:
          isNewCustomer && customerId
            ? [...state.eventRewardedCustomers, customerId]
            : state.eventRewardedCustomers,
        eventActive: shouldDeactivate ? false : state.eventActive,
        error: '',
      };
    },
    resetEventTracking: state => ({
      ...state,
      eventTotalRewardsGiven: 0,
      eventCustomersRewarded: 0,
      eventRewardedCustomers: [],
      eventActive: state.eventModeEnabled, // Re-activate if enabled
      error: '',
    }),
  },
});

export const {
  setRewardRate,
  setMinimumReward,
  setMaximumReward,
  setDefaultReward,
  setMerchantRewardId,
  setIsEnabled,
  setLoading,
  setError,
  updateRewardConfig,
  resetRewardConfig,
  setEventModeEnabled,
  setEventRewardLimit,
  setEventRewardRate,
  setEventCustomerLimit,
  setEventMerchantRewardId,
  updateEventConfig,
  activateEvent,
  deactivateEvent,
  trackEventReward,
  resetEventTracking,
} = rewardSlice.actions;

export default rewardSlice.reducer;

// Selectors for easy access to reward configuration
export const selectRewardRate = (state: any) => state.reward.rewardRate;
export const selectMinimumReward = (state: any) => state.reward.minimumReward;
export const selectMaximumReward = (state: any) => state.reward.maximumReward;
export const selectDefaultReward = (state: any) => state.reward.defaultReward;
export const selectMerchantRewardId = (state: any) =>
  state.reward.merchantRewardId;
export const selectIsRewardEnabled = (state: any) => state.reward.isEnabled;
export const selectShowStandaloneRewards = (state: any) =>
  state.reward.showStandaloneRewards;

// Memoized selector to prevent unnecessary re-renders
export const selectRewardConfig = createSelector(
  [
    selectRewardRate,
    selectMinimumReward,
    selectMaximumReward,
    selectDefaultReward,
    selectMerchantRewardId,
    selectIsRewardEnabled,
    selectShowStandaloneRewards,
  ],
  (
    rewardRate,
    minimumReward,
    maximumReward,
    defaultReward,
    merchantRewardId,
    isEnabled,
    showStandaloneRewards,
  ) => ({
    rewardRate,
    minimumReward,
    maximumReward,
    defaultReward,
    merchantRewardId,
    isEnabled,
    showStandaloneRewards,
  }),
);

// Event Mode selectors
export const selectEventModeEnabled = (state: any) =>
  state.reward.eventModeEnabled;
export const selectEventActive = (state: any) => state.reward.eventActive;
export const selectEventRewardLimit = (state: any) =>
  state.reward.eventRewardLimit;
export const selectEventRewardRate = (state: any) =>
  state.reward.eventRewardRate;
export const selectEventCustomerLimit = (state: any) =>
  state.reward.eventCustomerLimit;
export const selectEventMerchantRewardId = (state: any) =>
  state.reward.eventMerchantRewardId;
export const selectEventTotalRewardsGiven = (state: any) =>
  state.reward.eventTotalRewardsGiven;
export const selectEventCustomersRewarded = (state: any) =>
  state.reward.eventCustomersRewarded;

// Event tracking selectors
export const selectEventCustomerRewardLimit = (state: any) =>
  state.reward.eventCustomerRewardLimit;
export const selectEventRewardedCustomers = (state: any) =>
  state.reward.eventRewardedCustomers;
export const selectEventMinPurchaseAmount = (state: any) =>
  state.reward.eventMinPurchaseAmount;
export const selectEventBudgetSats = (state: any) =>
  state.reward.eventBudgetSats;
export const selectEventBudgetWarningPercent = (state: any) =>
  state.reward.eventBudgetWarningPercent;
export const selectEventDisplayName = (state: any) =>
  state.reward.eventDisplayName;
export const selectEventDisplayMessage = (state: any) =>
  state.reward.eventDisplayMessage;

// Memoized event config selector
export const selectEventConfig = createSelector(
  [
    selectEventModeEnabled,
    selectEventActive,
    selectEventRewardLimit,
    selectEventRewardRate,
    selectEventCustomerLimit,
    selectEventMerchantRewardId,
    selectEventTotalRewardsGiven,
    selectEventCustomersRewarded,
    selectEventCustomerRewardLimit,
    selectEventRewardedCustomers,
    selectEventMinPurchaseAmount,
    selectEventBudgetSats,
    selectEventBudgetWarningPercent,
    selectEventDisplayName,
    selectEventDisplayMessage,
  ],
  (
    eventModeEnabled,
    eventActive,
    eventRewardLimit,
    eventRewardRate,
    eventCustomerLimit,
    eventMerchantRewardId,
    eventTotalRewardsGiven,
    eventCustomersRewarded,
    eventCustomerRewardLimit,
    eventRewardedCustomers,
    eventMinPurchaseAmount,
    eventBudgetSats,
    eventBudgetWarningPercent,
    eventDisplayName,
    eventDisplayMessage,
  ) => ({
    eventModeEnabled,
    eventActive,
    eventRewardLimit,
    eventRewardRate,
    eventCustomerLimit,
    eventMerchantRewardId,
    eventTotalRewardsGiven,
    eventCustomersRewarded,
    eventCustomerRewardLimit,
    eventRewardedCustomers,
    eventMinPurchaseAmount,
    eventBudgetSats,
    eventBudgetWarningPercent,
    eventDisplayName,
    eventDisplayMessage,
  }),
);

// Event progress selectors
export const selectEventRewardProgress = createSelector(
  [selectEventTotalRewardsGiven, selectEventBudgetSats],
  (given, budget) => (budget > 0 ? given / budget : 0),
);

export const selectEventCustomerProgress = createSelector(
  [selectEventCustomersRewarded, selectEventCustomerLimit],
  (rewarded, limit) => (limit > 0 ? rewarded / limit : 0),
);
