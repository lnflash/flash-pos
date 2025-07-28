export interface RewardCalculation {
  rewardAmount: number;
  rewardRate?: number;
  purchaseAmount?: number;
  calculationType: 'purchase-based' | 'standalone';
  appliedMinimum?: boolean; // Was minimum reward applied?
  appliedMaximum?: boolean; // Was maximum reward applied?
}

interface RewardConfig {
  rewardRate: number;
  minimumReward: number;
  maximumReward: number;
  defaultReward: number;
  // Event mode fields
  eventActive?: boolean;
  eventRewardRate?: number;
  eventMerchantRewardId?: string;
  merchantRewardId?: string;
}

/**
 * Calculate reward amount based on purchase context or fallback to standalone
 * @param purchaseAmount - Purchase amount in sats (optional)
 * @param config - Reward configuration from Redux store
 * @returns Detailed reward calculation result
 */
export const calculateReward = (
  purchaseAmount?: number,
  config: RewardConfig = {
    rewardRate: 0.02,
    minimumReward: 1,
    maximumReward: 1000,
    defaultReward: 21,
  },
): RewardCalculation => {
  // Use event reward rate if event is active
  const effectiveRewardRate =
    config.eventActive && config.eventRewardRate !== undefined
      ? config.eventRewardRate
      : config.rewardRate;

  // Standalone reward when no purchase amount provided
  if (!purchaseAmount || purchaseAmount <= 0) {
    return {
      rewardAmount: config.defaultReward,
      calculationType: 'standalone',
    };
  }

  // Calculate percentage-based reward with effective rate
  const calculatedReward = Math.floor(purchaseAmount * effectiveRewardRate);

  // Apply minimum and maximum constraints
  let finalReward = calculatedReward;
  let appliedMinimum = false;
  let appliedMaximum = false;

  if (calculatedReward < config.minimumReward) {
    finalReward = config.minimumReward;
    appliedMinimum = true;
  } else if (calculatedReward > config.maximumReward) {
    finalReward = config.maximumReward;
    appliedMaximum = true;
  }

  return {
    rewardAmount: finalReward,
    rewardRate: effectiveRewardRate,
    purchaseAmount,
    calculationType: 'purchase-based',
    appliedMinimum,
    appliedMaximum,
  };
};

/**
 * Format reward calculation for display purposes
 * @param calculation - Result from calculateReward
 * @param satsToCurrency - Currency conversion function
 * @param isExternalPayment - Whether this is an external payment (cash/card) vs Lightning
 * @param paymentMethod - The payment method used (optional)
 * @returns Formatted strings for UI display
 */
export const formatRewardForDisplay = (
  calculation: RewardCalculation,
  satsToCurrency: (sats: number) => {formattedCurrency: string},
  isExternalPayment: boolean = false,
  paymentMethod?: PaymentMethod,
) => {
  const rewardCurrency = satsToCurrency(
    calculation.rewardAmount,
  ).formattedCurrency;

  if (calculation.calculationType === 'standalone') {
    return {
      primaryText: `${calculation.rewardAmount} sats (~${rewardCurrency})`,
      secondaryText: 'will be applied to reward balance.',
      description: 'Standalone reward',
    };
  }

  // Purchase-based display
  const percentage = ((calculation.rewardRate || 0) * 100).toFixed(1);

  // Determine payment context for description
  let paymentContext = 'purchase amount';
  if (isExternalPayment) {
    switch (paymentMethod) {
      case 'cash':
        paymentContext = 'cash payment';
        break;
      case 'card':
        paymentContext = 'card payment';
        break;
      case 'check':
        paymentContext = 'check payment';
        break;
      default:
        paymentContext = 'external payment';
    }
  }

  let description = `${percentage}% of ${paymentContext}`;

  if (calculation.appliedMinimum) {
    description += ' (minimum applied)';
  } else if (calculation.appliedMaximum) {
    description += ' (maximum applied)';
  }

  // Different secondary text for external payments
  const secondaryText = isExternalPayment
    ? 'Bitcoin reward will be applied to balance.'
    : 'will be applied to reward balance.';

  return {
    primaryText: `${calculation.rewardAmount} sats (~${rewardCurrency})`,
    secondaryText,
    description,
  };
};

/**
 * Validate reward configuration values
 * @param config - Reward configuration to validate
 * @returns Validation result with any errors
 */
export const validateRewardConfig = (config: Partial<RewardConfig>) => {
  const errors: string[] = [];

  if (config.rewardRate !== undefined) {
    if (config.rewardRate < 0 || config.rewardRate > 0.1) {
      errors.push('Reward rate must be between 0% and 10%');
    }
  }

  if (config.minimumReward !== undefined) {
    if (config.minimumReward < 1) {
      errors.push('Minimum reward must be at least 1 sat');
    }
  }

  if (
    config.maximumReward !== undefined &&
    config.minimumReward !== undefined
  ) {
    if (config.maximumReward < config.minimumReward) {
      errors.push('Maximum reward must be greater than minimum reward');
    }
  }

  if (config.defaultReward !== undefined) {
    if (config.defaultReward < 1) {
      errors.push('Default reward must be at least 1 sat');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};
