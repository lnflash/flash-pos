import {store} from '../../src/store';
import {
  setRewardRate,
  setMinimumReward,
  setMaximumReward,
  setDefaultReward,
  setIsEnabled,
  setLoading,
  setError,
  updateRewardConfig,
  resetRewardConfig,
  selectRewardRate,
  selectMinimumReward,
  selectMaximumReward,
  selectDefaultReward,
  selectIsRewardEnabled,
  selectRewardConfig,
} from '../../src/store/slices/rewardSlice';

describe('rewardSlice', () => {
  beforeEach(() => {
    store.dispatch(resetRewardConfig());
  });

  describe('initial state', () => {
    it('should have correct default values', () => {
      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.02); // 2%
      expect(state.reward.minimumReward).toBe(1);
      expect(state.reward.maximumReward).toBe(1000);
      expect(state.reward.defaultReward).toBe(21);
      expect(state.reward.isEnabled).toBe(true);
      expect(state.reward.loading).toBe(false);
      expect(state.reward.error).toBe('');
    });
  });

  describe('setRewardRate', () => {
    it('should set valid reward rate', () => {
      store.dispatch(setRewardRate(0.05)); // 5%

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.05);
      expect(state.reward.error).toBe('');
    });

    it('should enforce maximum 10% limit', () => {
      store.dispatch(setRewardRate(0.15)); // 15%

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.1); // Should be clamped to 10%
    });

    it('should enforce minimum 0% limit', () => {
      store.dispatch(setRewardRate(-0.01)); // Negative rate

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0); // Should be clamped to 0%
    });

    it('should clear error when setting valid rate', () => {
      store.dispatch(setError('Previous error'));
      store.dispatch(setRewardRate(0.03));

      const state = store.getState();
      expect(state.reward.error).toBe('');
    });
  });

  describe('setMinimumReward', () => {
    it('should set valid minimum reward', () => {
      store.dispatch(setMinimumReward(5));

      const state = store.getState();
      expect(state.reward.minimumReward).toBe(5);
    });

    it('should enforce minimum 1 sat limit', () => {
      store.dispatch(setMinimumReward(0));

      const state = store.getState();
      expect(state.reward.minimumReward).toBe(1);
    });

    it('should handle negative values', () => {
      store.dispatch(setMinimumReward(-5));

      const state = store.getState();
      expect(state.reward.minimumReward).toBe(1);
    });
  });

  describe('setMaximumReward', () => {
    it('should set valid maximum reward', () => {
      store.dispatch(setMaximumReward(2000));

      const state = store.getState();
      expect(state.reward.maximumReward).toBe(2000);
    });

    it('should enforce minimum reward constraint', () => {
      store.dispatch(setMinimumReward(100));
      store.dispatch(setMaximumReward(50)); // Less than minimum

      const state = store.getState();
      expect(state.reward.maximumReward).toBe(100); // Should be at least minimum
    });
  });

  describe('setDefaultReward', () => {
    it('should set valid default reward', () => {
      store.dispatch(setDefaultReward(42));

      const state = store.getState();
      expect(state.reward.defaultReward).toBe(42);
    });

    it('should enforce minimum 1 sat limit', () => {
      store.dispatch(setDefaultReward(0));

      const state = store.getState();
      expect(state.reward.defaultReward).toBe(1);
    });
  });

  describe('setIsEnabled', () => {
    it('should enable rewards system', () => {
      store.dispatch(setIsEnabled(true));

      const state = store.getState();
      expect(state.reward.isEnabled).toBe(true);
    });

    it('should disable rewards system', () => {
      store.dispatch(setIsEnabled(false));

      const state = store.getState();
      expect(state.reward.isEnabled).toBe(false);
    });
  });

  describe('setLoading', () => {
    it('should set loading state', () => {
      store.dispatch(setLoading(true));

      const state = store.getState();
      expect(state.reward.loading).toBe(true);
    });
  });

  describe('setError', () => {
    it('should set error message', () => {
      store.dispatch(setError('Test error message'));

      const state = store.getState();
      expect(state.reward.error).toBe('Test error message');
    });
  });

  describe('updateRewardConfig', () => {
    it('should update multiple fields at once', () => {
      const config = {
        rewardRate: 0.03,
        minimumReward: 5,
        maximumReward: 500,
        defaultReward: 30,
        isEnabled: false,
      };

      store.dispatch(updateRewardConfig(config));

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.03);
      expect(state.reward.minimumReward).toBe(5);
      expect(state.reward.maximumReward).toBe(500);
      expect(state.reward.defaultReward).toBe(30);
      expect(state.reward.isEnabled).toBe(false);
      expect(state.reward.error).toBe('');
    });

    it('should apply validation to all fields', () => {
      const config = {
        rewardRate: 0.15, // Should be clamped to 10%
        minimumReward: 0, // Should be clamped to 1
        maximumReward: 50,
        defaultReward: -5, // Should be clamped to 1
      };

      store.dispatch(setMinimumReward(100)); // Set minimum first
      store.dispatch(updateRewardConfig(config));

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.1); // Clamped to 10%
      expect(state.reward.minimumReward).toBe(1); // Clamped to 1
      expect(state.reward.maximumReward).toBe(100); // Should respect existing minimum
      expect(state.reward.defaultReward).toBe(1); // Clamped to 1
    });

    it('should only update provided fields', () => {
      store.dispatch(setRewardRate(0.05));
      store.dispatch(setMinimumReward(10));

      store.dispatch(
        updateRewardConfig({
          rewardRate: 0.03,
          // Other fields not provided
        }),
      );

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.03); // Updated
      expect(state.reward.minimumReward).toBe(10); // Unchanged
    });
  });

  describe('resetRewardConfig', () => {
    it('should reset to initial state', () => {
      // Modify state
      store.dispatch(setRewardRate(0.08));
      store.dispatch(setMinimumReward(50));
      store.dispatch(setIsEnabled(false));
      store.dispatch(setError('Test error'));

      // Reset
      store.dispatch(resetRewardConfig());

      const state = store.getState();
      expect(state.reward.rewardRate).toBe(0.02);
      expect(state.reward.minimumReward).toBe(1);
      expect(state.reward.maximumReward).toBe(1000);
      expect(state.reward.defaultReward).toBe(21);
      expect(state.reward.isEnabled).toBe(true);
      expect(state.reward.loading).toBe(false);
      expect(state.reward.error).toBe('');
    });
  });

  describe('selectors', () => {
    beforeEach(() => {
      store.dispatch(
        updateRewardConfig({
          rewardRate: 0.04,
          minimumReward: 10,
          maximumReward: 800,
          defaultReward: 35,
          isEnabled: false,
        }),
      );
    });

    it('should select reward rate', () => {
      const state = store.getState();
      expect(selectRewardRate(state)).toBe(0.04);
    });

    it('should select minimum reward', () => {
      const state = store.getState();
      expect(selectMinimumReward(state)).toBe(10);
    });

    it('should select maximum reward', () => {
      const state = store.getState();
      expect(selectMaximumReward(state)).toBe(800);
    });

    it('should select default reward', () => {
      const state = store.getState();
      expect(selectDefaultReward(state)).toBe(35);
    });

    it('should select is enabled', () => {
      const state = store.getState();
      expect(selectIsRewardEnabled(state)).toBe(false);
    });

    it('should select complete reward config', () => {
      const state = store.getState();
      const config = selectRewardConfig(state);

      expect(config).toEqual({
        rewardRate: 0.04,
        minimumReward: 10,
        maximumReward: 800,
        defaultReward: 35,
        isEnabled: false,
      });
    });
  });
});
