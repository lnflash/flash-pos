import {REWARDS_ENABLED} from '@env';

export const isRewardsEnabled = (): boolean => {
  try {
    const rewardsEnabled =
      process.env.NODE_ENV === 'test' && process.env.REWARDS_ENABLED !== undefined
        ? process.env.REWARDS_ENABLED
        : REWARDS_ENABLED;

    return rewardsEnabled === 'true';
  } catch {
    return false;
  }
};
