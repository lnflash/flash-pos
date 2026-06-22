import {validateInvoiceAmount} from '../../src/utils/amounts';

describe('amount utilities', () => {
  describe('validateInvoiceAmount', () => {
    it.each([NaN, Infinity, 0, -1])(
      'rejects invalid sat prices: %p',
      satPrice => {
        expect(validateInvoiceAmount(satPrice, 1000).valid).toBe(false);
      },
    );

    it.each([NaN, Infinity, 0, -1])('rejects invalid sats: %p', sats => {
      expect(validateInvoiceAmount(0.0005, sats).valid).toBe(false);
    });

    it('rounds valid sat amounts to integer cents', () => {
      expect(validateInvoiceAmount(0.0005, 1234)).toEqual({
        valid: true,
        cents: 62,
      });
    });

    it('rejects amounts below one cent', () => {
      expect(validateInvoiceAmount(0.00000001, 1).valid).toBe(false);
    });

    it('rejects amounts above the POS maximum', () => {
      expect(validateInvoiceAmount(1, 1_000_000).valid).toBe(false);
    });
  });
});
