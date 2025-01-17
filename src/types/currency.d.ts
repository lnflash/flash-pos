interface CurrencyItem {
  id: string;
  flag: string;
  name: string;
  symbol: string;
  fractionDigits: number;
}

interface CurrencyList {
  currencyList: CurrencyItem[];
}
