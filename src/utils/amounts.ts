const MAX_INVOICE_CENTS = 99_999_999;

export const validateInvoiceAmount = (
  satPrice: number,
  sats: number,
): {valid: boolean; cents?: number; error?: string} => {
  if (!Number.isFinite(satPrice) || satPrice <= 0) {
    return {
      valid: false,
      error: 'Bitcoin price is still loading. Please try again in a moment.',
    };
  }

  if (!Number.isFinite(sats) || sats <= 0) {
    return {
      valid: false,
      error: 'Please enter a valid amount.',
    };
  }

  const cents = Math.round(sats * satPrice * 100);

  if (!Number.isFinite(cents) || cents < 1) {
    return {
      valid: false,
      error: 'Amount is too small. Please enter at least 1 cent.',
    };
  }

  if (cents > MAX_INVOICE_CENTS) {
    return {
      valid: false,
      error: 'Amount is too large. Please enter a smaller amount.',
    };
  }

  return {valid: true, cents};
};
