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

  const {loading: initLoading} = useQuery(RealtimePrice, {
    variables: {currency: currency.id},
    onCompleted(initData) {
      if (initData?.realtimePrice?.btcSatPrice) {
        const {base, offset} = initData.realtimePrice.btcSatPrice;
        priceRef.current = base / 10 ** offset;
      }
    },
  });

  const {loading} = useSubscription(RealtimePriceSubscription, {
    variables: {currency: currency.id},
    onData({data}) {
      if (data.data.realtimePrice.realtimePrice.btcSatPrice) {
        const {base, offset} =
          data.data.realtimePrice.realtimePrice.btcSatPrice;
        priceRef.current = base / 10 ** offset;
      }
    },
  });

  const conversions = React.useMemo(
    () => ({
      satsToCurrency: (sats: number) => {
        const convertedCurrencyAmount =
          currency.fractionDigits === 2
            ? (sats * priceRef.current) / 100
            : sats * priceRef.current;
        const formattedCurrency = formatCurrency({
          amountInMajorUnits: convertedCurrencyAmount,
          currency: currency.id,
          withSign: true,
        });
        return {
          convertedCurrencyAmount,
          formattedCurrency,
        };
      },
      currencyToSats: (currencyAmount: number) => {
        const convertedCurrencyAmount =
          currency.fractionDigits === 2
            ? (100 * currencyAmount) / priceRef.current
            : currencyAmount / priceRef.current;
        const formattedCurrency = formatCurrency({
          amountInMajorUnits: convertedCurrencyAmount,
          currency: currency.id,
          withSign: true,
        });
        return {
          convertedCurrencyAmount,
          formattedCurrency,
        };
      },
      loading: loading || initLoading,
    }),
    [priceRef, formatCurrency, loading, initLoading, currency],
  );

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
      loading: loading || initLoading,
    };
  }

  return conversions;
};
export default useRealtimePrice;
