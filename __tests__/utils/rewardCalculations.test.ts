import {
  calculateReward,
  formatRewardForDisplay,
  validateRewardConfig,
} from '../../src/utils/rewardCalculations';

describe('rewardCalculations', () => {
  const defaultConfig = {
    rewardRate: 0.02, // 2%
    minimumReward: 1,
    maximumReward: 1000,
    defaultReward: 21,
  };

  const mockSatsToCurrency = (sats: number) => ({
    formattedCurrency: `$${(sats * 0.0001).toFixed(2)}`, // Mock 1 sat = $0.0001
  });

  describe('calculateReward', () => {
    describe('standalone rewards', () => {
      it('should return default reward when no purchase amount', () => {
        const result = calculateReward(undefined, defaultConfig);

        expect(result).toEqual({
          rewardAmount: 21,
          calculationType: 'standalone',
        });
      });

      it('should return default reward when purchase amount is zero', () => {
        const result = calculateReward(0, defaultConfig);

        expect(result).toEqual({
          rewardAmount: 21,
          calculationType: 'standalone',
        });
      });

      it('should return default reward when purchase amount is negative', () => {
        const result = calculateReward(-100, defaultConfig);

        expect(result).toEqual({
          rewardAmount: 21,
          calculationType: 'standalone',
        });
      });
    });

    describe('purchase-based rewards', () => {
      it('should calculate percentage-based reward correctly', () => {
        const result = calculateReward(1000, defaultConfig); // 1000 sats * 2% = 20 sats

        expect(result).toEqual({
          rewardAmount: 20,
          rewardRate: 0.02,
          purchaseAmount: 1000,
          calculationType: 'purchase-based',
          appliedMinimum: false,
          appliedMaximum: false,
        });
      });

      it('should apply minimum reward constraint', () => {
        const result = calculateReward(10, defaultConfig); // 10 sats * 2% = 0.2 sats -> 1 sat minimum

        expect(result).toEqual({
          rewardAmount: 1,
          rewardRate: 0.02,
          purchaseAmount: 10,
          calculationType: 'purchase-based',
          appliedMinimum: true,
          appliedMaximum: false,
        });
      });

      it('should apply maximum reward constraint', () => {
        const result = calculateReward(100000, defaultConfig); // 100000 sats * 2% = 2000 sats -> 1000 sats maximum

        expect(result).toEqual({
          rewardAmount: 1000,
          rewardRate: 0.02,
          purchaseAmount: 100000,
          calculationType: 'purchase-based',
          appliedMinimum: false,
          appliedMaximum: true,
        });
      });

      it('should floor decimal rewards', () => {
        const result = calculateReward(155, defaultConfig); // 155 sats * 2% = 3.1 sats -> 3 sats

        expect(result.rewardAmount).toBe(3);
      });

      it('should work with custom reward configuration', () => {
        const customConfig = {
          rewardRate: 0.05, // 5%
          minimumReward: 5,
          maximumReward: 500,
          defaultReward: 42,
        };

        const result = calculateReward(1000, customConfig); // 1000 sats * 5% = 50 sats

        expect(result).toEqual({
          rewardAmount: 50,
          rewardRate: 0.05,
          purchaseAmount: 1000,
          calculationType: 'purchase-based',
          appliedMinimum: false,
          appliedMaximum: false,
        });
      });
    });

    describe('edge cases', () => {
      it('should handle very small purchase amounts', () => {
        const result = calculateReward(1, defaultConfig); // 1 sat * 2% = 0.02 sats -> 1 sat minimum

        expect(result.rewardAmount).toBe(1);
        expect(result.appliedMinimum).toBe(true);
      });

      it('should handle very large purchase amounts', () => {
        const result = calculateReward(1000000, defaultConfig); // 1M sats * 2% = 20k sats -> 1k sats maximum

        expect(result.rewardAmount).toBe(1000);
        expect(result.appliedMaximum).toBe(true);
      });

      it('should work with zero reward rate', () => {
        const zeroRateConfig = {...defaultConfig, rewardRate: 0};
        const result = calculateReward(1000, zeroRateConfig);

        expect(result.rewardAmount).toBe(1); // Should apply minimum
        expect(result.appliedMinimum).toBe(true);
      });
    });
  });

  describe('formatRewardForDisplay', () => {
    it('should format standalone rewards correctly', () => {
      const calculation = {
        rewardAmount: 21,
        calculationType: 'standalone' as const,
      };

      const result = formatRewardForDisplay(calculation, mockSatsToCurrency);

      expect(result).toEqual({
        primaryText: '21 sats (~$0.00)',
        secondaryText: 'will be applied to reward balance.',
        description: 'Standalone reward',
      });
    });

    it('should format purchase-based rewards correctly', () => {
      const calculation = {
        rewardAmount: 50,
        rewardRate: 0.05,
        purchaseAmount: 1000,
        calculationType: 'purchase-based' as const,
        appliedMinimum: false,
        appliedMaximum: false,
      };

      const result = formatRewardForDisplay(calculation, mockSatsToCurrency);

      expect(result).toEqual({
        primaryText: '50 sats (~$0.01)',
        secondaryText: 'will be applied to reward balance.',
        description: '5.0% of purchase amount',
      });
    });

    it('should indicate when minimum was applied', () => {
      const calculation = {
        rewardAmount: 1,
        rewardRate: 0.02,
        purchaseAmount: 10,
        calculationType: 'purchase-based' as const,
        appliedMinimum: true,
        appliedMaximum: false,
      };

      const result = formatRewardForDisplay(calculation, mockSatsToCurrency);

      expect(result.description).toBe(
        '2.0% of purchase amount (minimum applied)',
      );
    });

    it('should indicate when maximum was applied', () => {
      const calculation = {
        rewardAmount: 1000,
        rewardRate: 0.02,
        purchaseAmount: 100000,
        calculationType: 'purchase-based' as const,
        appliedMinimum: false,
        appliedMaximum: true,
      };

      const result = formatRewardForDisplay(calculation, mockSatsToCurrency);

      expect(result.description).toBe(
        '2.0% of purchase amount (maximum applied)',
      );
    });
  });

  describe('validateRewardConfig', () => {
    it('should validate correct configuration', () => {
      const result = validateRewardConfig(defaultConfig);

      expect(result).toEqual({
        isValid: true,
        errors: [],
      });
    });

    it('should reject reward rate above 10%', () => {
      const result = validateRewardConfig({rewardRate: 0.15});

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Reward rate must be between 0% and 10%');
    });

    it('should reject negative reward rate', () => {
      const result = validateRewardConfig({rewardRate: -0.01});

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Reward rate must be between 0% and 10%');
    });

    it('should reject minimum reward below 1 sat', () => {
      const result = validateRewardConfig({minimumReward: 0});

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Minimum reward must be at least 1 sat');
    });

    it('should reject maximum reward below minimum', () => {
      const result = validateRewardConfig({
        minimumReward: 100,
        maximumReward: 50,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Maximum reward must be greater than minimum reward',
      );
    });

    it('should reject default reward below 1 sat', () => {
      const result = validateRewardConfig({defaultReward: 0});

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Default reward must be at least 1 sat');
    });

    it('should collect multiple errors', () => {
      const result = validateRewardConfig({
        rewardRate: 0.15,
        minimumReward: 0,
        defaultReward: -5,
      });

      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(3);
    });

    it('should handle partial configuration', () => {
      const result = validateRewardConfig({rewardRate: 0.05});

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
