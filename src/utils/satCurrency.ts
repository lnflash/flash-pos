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

/**
 * Sats render unit-last and pluralised ("0 sats", "1 sat", "21 sats") — the
 * SAT currency's symbol is "sat", so the generic `${symbol} ${amount}` fiat
 * layout would print "sat 13". Every screen that shows a sat amount goes
 * through here so the keypad, the success screen and the history agree.
 */
export function formatSatAmount(amount: number | string | undefined): string {
  const n = Number(amount || 0);
  return `${n} ${n === 1 ? 'sat' : 'sats'}`;
}
