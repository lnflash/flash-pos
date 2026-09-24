import {useQuery} from '@apollo/client';
import {useCallback, useMemo} from 'react';
import {CurrencyList} from '../graphql/queries';

import {SAT_CURRENCY} from '../utils/satCurrency';

const usdDisplayCurrency = {
  symbol: '$',
  id: 'USD',
  fractionDigits: 2,
};

const defaultDisplayCurrency = usdDisplayCurrency;

const formatCurrencyHelper = ({
  amountInMajorUnits,
  symbol,
  fractionDigits,
  withSign = true,
  withDecimals = true,
}: {
  amountInMajorUnits: number | string;
  symbol: string;
  fractionDigits: number;
  withSign?: boolean;
  withDecimals?: boolean;
}) => {
  const isNegative = Number(amountInMajorUnits) < 0;
  const decimalPlaces = withDecimals ? fractionDigits : 0;
  const amountStr = Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
    // FIXME this workaround of using .format and not .formatNumber is
    // because hermes haven't fully implemented Intl.NumberFormat yet
  }).format(Math.abs(Number(amountInMajorUnits)));
  return `${isNegative && withSign ? '-' : ''}${symbol} ${amountStr}`;
};

export const useDisplayCurrency = () => {
  const {data: dataCurrencyList} = useQuery<CurrencyList>(CurrencyList);

  const displayCurrencyDictionary = useMemo(() => {
    const currencyList = dataCurrencyList?.currencyList || [];
    const dictionary = currencyList.reduce((acc, currency) => {
      acc[currency.id] = currency;
      return acc;
    }, {} as Record<string, typeof defaultDisplayCurrency>);
    // SAT formats even when the backend list is unreachable.
    dictionary[SAT_CURRENCY.id] = {
      symbol: SAT_CURRENCY.symbol,
      id: SAT_CURRENCY.id,
      fractionDigits: SAT_CURRENCY.fractionDigits,
    };
    return dictionary;
  }, [dataCurrencyList?.currencyList]);

  const formatCurrency = useCallback(
    ({
      amountInMajorUnits,
      currency,
      withSign,
    }: {
      amountInMajorUnits: number | string;
      currency: string;
      withSign?: boolean;
    }) => {
      const currencyInfo = displayCurrencyDictionary[currency] || {
        symbol: currency,
        fractionDigits: 2,
      };
      return formatCurrencyHelper({
        amountInMajorUnits,
        symbol: currencyInfo.symbol,
        fractionDigits: currencyInfo.fractionDigits,
        withSign,
      });
    },
    [displayCurrencyDictionary],
  );

  return {
    formatCurrency,
    currencyList: dataCurrencyList?.currencyList || [],
  };
};
