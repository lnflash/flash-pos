/**
 * The built-in satoshi display currency. SAT is not a backend currency-list
 * entry — it is the protocol's native unit, so it is defined here and offered
 * by the currency picker unconditionally (plus a fiat fallback list for when
 * the backend's currencyList is unreachable).
 */
export const SAT_CURRENCY = {
  id: 'SAT',
  name: 'Satoshi',
  flag: '⚡',
  symbol: 'sat',
  fractionDigits: 0,
};

export const FALLBACK_CURRENCY_LIST = [
  SAT_CURRENCY,
  {id: 'USD', name: 'US Dollar', flag: '🇺🇸', symbol: '$', fractionDigits: 2},
];
