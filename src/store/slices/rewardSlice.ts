import {createSlice, createSelector} from '@reduxjs/toolkit';

interface RewardState {
  rewardRate: number; // Percentage (e.g., 0.02 for 2%)
  minimumReward: number; // Minimum sats to award
  maximumReward: number; // Maximum sats to award
  defaultReward: number; // Fallback for standalone rewards
  isEnabled: boolean; // Global reward system toggle
  loading: boolean; // For async operations
  error: string; // Error messages
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
    } = require('@env');

    return {
      rewardRate: parseFloat(DEFAULT_REWARD_RATE || '0.02'),
      minimumReward: parseInt(MIN_REWARD_SATS || '1', 10),
      maximumReward: parseInt(MAX_REWARD_SATS || '1000', 10),
      defaultReward: parseInt(STANDALONE_REWARD_SATS || '21', 10),
      isEnabled: (REWARDS_ENABLED || 'true').toLowerCase() === 'true',
    };
  } catch (error) {
    // Fallback to hardcoded defaults if environment variables are not available
    return {
      rewardRate: 0.02, // 2% default
      minimumReward: 1, // Minimum 1 sat
      maximumReward: 1000, // Maximum 1000 sats
      defaultReward: 21, // Current fixed amount for standalone rewards
      isEnabled: true, // Rewards enabled by default
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
        isEnabled,
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
        isEnabled: isEnabled !== undefined ? isEnabled : state.isEnabled,
        error: '',
      };
    },
    resetRewardConfig: () => ({
      ...initialState,
    }),
  },
});

export const {
  setRewardRate,
  setMinimumReward,
  setMaximumReward,
  setDefaultReward,
  setIsEnabled,
  setLoading,
  setError,
  updateRewardConfig,
  resetRewardConfig,
} = rewardSlice.actions;

export default rewardSlice.reducer;

// Selectors for easy access to reward configuration
export const selectRewardRate = (state: any) => state.reward.rewardRate;
export const selectMinimumReward = (state: any) => state.reward.minimumReward;
export const selectMaximumReward = (state: any) => state.reward.maximumReward;
export const selectDefaultReward = (state: any) => state.reward.defaultReward;
export const selectIsRewardEnabled = (state: any) => state.reward.isEnabled;

// Memoized selector to prevent unnecessary re-renders
export const selectRewardConfig = createSelector(
  [
    selectRewardRate,
    selectMinimumReward,
    selectMaximumReward,
    selectDefaultReward,
    selectIsRewardEnabled,
  ],
  (rewardRate, minimumReward, maximumReward, defaultReward, isEnabled) => ({
    rewardRate,
    minimumReward,
    maximumReward,
    defaultReward,
    isEnabled,
  }),
);
