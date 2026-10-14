import {REWARDS_ENABLED} from '@env';
import {FLASH_LADDER_CHANGE} from '@env-optional';

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

/**
 * ENG-701's kill switch: a charge's change refills the card's covering
 * ladder, and coin selection prefers the plan that leaves the card closest
 * to it. On by default; `FLASH_LADDER_CHANGE=false` in the build's .env
 * (`@env-optional`, so a build without it is on) restores power-of-two change
 * and the coin selection before ENG-701 exactly.
 */
export const isLadderChangeEnabled = (): boolean => {
  try {
    const value =
      process.env.NODE_ENV === 'test' &&
      process.env.FLASH_LADDER_CHANGE !== undefined
        ? process.env.FLASH_LADDER_CHANGE
        : FLASH_LADDER_CHANGE;
    return (
      String(value ?? '')
        .trim()
        .toLowerCase() !== 'false'
    );
  } catch {
    return true;
  }
};
