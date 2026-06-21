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
