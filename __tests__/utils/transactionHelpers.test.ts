import {
  calculateSalesTotal,
  getSalesContribution,
  createRefundTransaction,
  validateTransactionData,
} from '../../src/utils/transactionHelpers';

const usd: CurrencyItem = {
  id: 'USD',
  flag: '🇺🇸',
  name: 'US Dollar',
  symbol: '$',
  fractionDigits: 2,
};

const makeSale = (
  id: string,
  satAmount: number,
  overrides: Partial<TransactionData> = {},
): TransactionData => ({
  id,
  timestamp: '2024-01-01T12:00:00Z',
  transactionType: 'lightning',
  paymentMethod: 'lightning',
  amount: {
    satAmount,
    displayAmount: String(satAmount),
    currency: usd,
    isPrimaryAmountSats: true,
  },
  merchant: {username: 'testmerchant'},
  invoice: {
    paymentHash: `hash-${id}`,
    paymentRequest: 'lnbc1...',
    paymentSecret: 'secret',
  },
  status: 'completed',
  ...overrides,
});

const makeRefund = (
  id: string,
  satAmount: number,
  overrides: Partial<TransactionData> = {},
): TransactionData =>
  makeSale(id, satAmount, {
    transactionType: 'refund',
    invoice: {paymentHash: '', paymentRequest: '', paymentSecret: ''},
    ...overrides,
  });

describe('getSalesContribution', () => {
  it('returns the positive amount for a sale', () => {
    expect(getSalesContribution(makeSale('s1', 1000))).toBe(1000);
  });

  it('returns a negative amount for a refund stored negative', () => {
    expect(getSalesContribution(makeRefund('r1', -400))).toBe(-400);
  });

  it('returns a negative amount even for a refund stored positive (issue #64)', () => {
    // A refund recorded with a positive amount must still deduct from sales
    expect(getSalesContribution(makeRefund('r1', 400))).toBe(-400);
  });

  it('returns 0 for a standalone reward with no purchase amount', () => {
    expect(
      getSalesContribution(makeSale('s1', 0, {transactionType: 'standalone'})),
    ).toBe(0);
  });
});

describe('calculateSalesTotal', () => {
  it('returns 0 for an empty transaction list', () => {
    expect(calculateSalesTotal([])).toBe(0);
  });

  it('sums sale amounts when there are only sales', () => {
    const transactions = [
      makeSale('s1', 1000),
      makeSale('s2', 2500),
      makeSale('s3', 500, {transactionType: 'rewards-only'}),
    ];

    expect(calculateSalesTotal(transactions)).toBe(4000);
  });

  it('deducts a refund from the sales total (issue #64)', () => {
    const transactions = [
      makeSale('s1', 1000),
      makeSale('s2', 2500),
      makeRefund('r1', -1000),
    ];

    expect(calculateSalesTotal(transactions)).toBe(2500);
  });

  it('deducts a refund even when its amount was stored positive (issue #64)', () => {
    const transactions = [makeSale('s1', 3000), makeRefund('r1', 1000)];

    expect(calculateSalesTotal(transactions)).toBe(2000);
  });

  it('returns a negative total when there are only refunds', () => {
    const transactions = [makeRefund('r1', -700), makeRefund('r2', -300)];

    expect(calculateSalesTotal(transactions)).toBe(-1000);
  });

  it('fully cancels a sale refunded in full', () => {
    const transactions = [makeSale('s1', 1500), makeRefund('r1', -1500)];

    expect(calculateSalesTotal(transactions)).toBe(0);
  });
});

describe('createRefundTransaction', () => {
  const params = {
    amount: {
      satAmount: 800,
      displayAmount: '8.00',
      currency: usd,
      isPrimaryAmountSats: true,
    },
    merchant: {username: 'testmerchant'},
    refundOf: 'original-tx-1',
  };

  it('stores the amount as negative even when passed positive', () => {
    const refund = createRefundTransaction(params);

    expect(refund.amount.satAmount).toBe(-800);
  });

  it('keeps the amount negative when already passed negative', () => {
    const refund = createRefundTransaction({
      ...params,
      amount: {...params.amount, satAmount: -800},
    });

    expect(refund.amount.satAmount).toBe(-800);
  });

  it('marks the transaction as a refund and links the original transaction', () => {
    const refund = createRefundTransaction(params);

    expect(refund.transactionType).toBe('refund');
    expect(refund.refundOf).toBe('original-tx-1');
    expect(refund.status).toBe('completed');
  });

  it('produces a transaction that passes validation', () => {
    const refund = createRefundTransaction(params);

    expect(validateTransactionData(refund)).toEqual({
      isValid: true,
      errors: [],
    });
  });

  it('produces a transaction that deducts from the sales total', () => {
    const sale = makeSale('s1', 1000);
    const refund = createRefundTransaction(params);

    expect(calculateSalesTotal([sale, refund])).toBe(200);
  });
});

describe('validateTransactionData (refunds)', () => {
  it('accepts a refund with a negative amount', () => {
    const result = validateTransactionData(makeRefund('r1', -500));

    expect(result.isValid).toBe(true);
  });

  it('rejects a refund with a positive amount (would inflate sales, issue #64)', () => {
    const result = validateTransactionData(makeRefund('r1', 500));

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      'Refund amount must be negative (a deduction from sales)',
    );
  });

  it('rejects a refund with a zero amount', () => {
    const result = validateTransactionData(makeRefund('r1', 0));

    expect(result.isValid).toBe(false);
  });

  it('still rejects a negative amount on a non-refund sale', () => {
    const result = validateTransactionData(makeSale('s1', -100));

    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(
      'Amount must be greater than 0 for non-standalone transactions',
    );
  });

  it('still accepts a valid positive sale', () => {
    const result = validateTransactionData(makeSale('s1', 100));

    expect(result.isValid).toBe(true);
  });
});
