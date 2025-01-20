import * as React from 'react';

// hooks
import {useQuery, useSubscription} from '@apollo/client';
import {useDisplayCurrency} from './useDisplayCurrency';
import {useAppSelector} from '../store/hooks';

// gql
import {RealtimePriceSubscription} from '../graphql/subscriptions';
import {RealtimePrice} from '../graphql/queries';

const useRealtimePrice = () => {
  const priceRef = React.useRef<number>(0);

  const {currency} = useAppSelector(state => state.amount);

  const {formatCurrency} = useDisplayCurrency();

  const {data, loading: dataLoading} = useSubscription(
    RealtimePriceSubscription,
    {
      variables: {currency: currency.id},
    },
  );

  const {loading: initialDataLoading} = useQuery(RealtimePrice, {
    variables: {currency: currency.id},
    onCompleted(initData) {
      if (initData?.realtimePrice?.btcSatPrice) {
        const {base, offset} = initData.realtimePrice.btcSatPrice;
        priceRef.current = base / 10 ** offset;
      }
    },
  });

  const conversions = React.useMemo(
    () => ({
      satsToCurrency: (
        sats: number,
        display: string,
        fractionDigits: number,
      ) => {
        console.log(display);
        console.log(display);
        const convertedCurrencyAmount =
          fractionDigits === 2
            ? (sats * priceRef.current) / 100
            : sats * priceRef.current;
        const formattedCurrency = formatCurrency({
          amountInMajorUnits: convertedCurrencyAmount,
          currency: display,
          withSign: true,
        });
        return {
          convertedCurrencyAmount,
          formattedCurrency,
        };
      },
      currencyToSats: (
        currency: number,
        display: string,
        fractionDigits: number,
      ) => {
        const convertedCurrencyAmount =
          fractionDigits === 2
            ? (100 * currency) / priceRef.current
            : currency / priceRef.current;
        const formattedCurrency = formatCurrency({
          amountInMajorUnits: convertedCurrencyAmount,
          currency: display,
          withSign: true,
        });
        return {
          convertedCurrencyAmount,
          formattedCurrency,
        };
      },
      loading: dataLoading || initialDataLoading,
    }),
    [priceRef, formatCurrency, dataLoading, initialDataLoading],
  );

  if (data?.realtimePrice?.realtimePrice?.btcSatPrice) {
    const {base, offset} = data.realtimePrice.realtimePrice.btcSatPrice;
    priceRef.current = base / 10 ** offset;
  }

  if (priceRef.current === 0) {
    return {
      satsToCurrency: () => {
        return {
          convertedCurrencyAmount: NaN,
          formattedCurrency: '0',
        };
      },
      currencyToSats: () => {
        return {
          convertedCurrencyAmount: NaN,
          formattedCurrency: '0',
        };
      },
      loading: dataLoading || initialDataLoading,
    };
  }

  return conversions;
};
export default useRealtimePrice;
