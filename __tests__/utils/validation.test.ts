import {sanitizeMerchantRewardId} from '../../src/utils/validation';

describe('validation utilities', () => {
  describe('sanitizeMerchantRewardId', () => {
    it.each([
      '../admin',
      'foo/../bar',
      '?amount=999',
      'evil.com/x',
      '',
      'reward-id\u0000',
      'reward-id\nnext',
    ])('rejects malicious merchant reward ID input: %p', input => {
      expect(sanitizeMerchantRewardId(input)).toBeNull();
    });

    it('trims and returns safe merchant reward IDs', () => {
      expect(sanitizeMerchantRewardId(' reward_123-abc ')).toBe(
        'reward_123-abc',
      );
    });
  });
});
