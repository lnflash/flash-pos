describe('featureFlags', () => {
  const originalRewardsEnabled = process.env.REWARDS_ENABLED;

  afterEach(() => {
    jest.resetModules();
    if (originalRewardsEnabled === undefined) {
      delete process.env.REWARDS_ENABLED;
    } else {
      process.env.REWARDS_ENABLED = originalRewardsEnabled;
    }
  });

  it('returns true when REWARDS_ENABLED=true', () => {
    process.env.REWARDS_ENABLED = 'true';

    const {isRewardsEnabled} = require('../../src/utils/featureFlags');

    expect(isRewardsEnabled()).toBe(true);
  });

  it('returns false when REWARDS_ENABLED=false', () => {
    process.env.REWARDS_ENABLED = 'false';

    const {isRewardsEnabled} = require('../../src/utils/featureFlags');

    expect(isRewardsEnabled()).toBe(false);
  });

  it('returns false when REWARDS_ENABLED is missing', () => {
    delete process.env.REWARDS_ENABLED;

    const {isRewardsEnabled} = require('../../src/utils/featureFlags');

    expect(isRewardsEnabled()).toBe(false);
  });
});

describe('isLadderChangeEnabled (ENG-701 kill switch)', () => {
  const saved = process.env.FLASH_LADDER_CHANGE;

  afterEach(() => {
    jest.resetModules();
    if (saved === undefined) {
      delete process.env.FLASH_LADDER_CHANGE;
    } else {
      process.env.FLASH_LADDER_CHANGE = saved;
    }
  });

  it('is on when FLASH_LADDER_CHANGE is missing', () => {
    delete process.env.FLASH_LADDER_CHANGE;
    const {isLadderChangeEnabled} = require('../../src/utils/featureFlags');
    expect(isLadderChangeEnabled()).toBe(true);
  });

  it('is on for anything but false', () => {
    const {isLadderChangeEnabled} = require('../../src/utils/featureFlags');
    for (const value of ['true', '', '1', 'on']) {
      process.env.FLASH_LADDER_CHANGE = value;
      expect(isLadderChangeEnabled()).toBe(true);
    }
  });

  it('is off for FLASH_LADDER_CHANGE=false, in any case', () => {
    const {isLadderChangeEnabled} = require('../../src/utils/featureFlags');
    for (const value of ['false', 'FALSE', ' False ']) {
      process.env.FLASH_LADDER_CHANGE = value;
      expect(isLadderChangeEnabled()).toBe(false);
    }
  });
});
