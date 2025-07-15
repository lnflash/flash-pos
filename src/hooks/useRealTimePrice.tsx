import * as React from 'react';

// hooks
import {useQuery, useSubscription} from '@apollo/client';
import {useDisplayCurrency} from './useDisplayCurrency';
import {useAppSelector} from '../store/hooks';

// gql
import {RealtimePriceSubscription} from '../graphql/subscriptions';
import {RealtimePrice} from '../graphql/queries';

const useRealtimePrice = () => {
  const [price, setPrice] = React.useState<number>(0);
  const {currency} = useAppSelector(state => state.amount);
  const {formatCurrency} = useDisplayCurrency();

  const {loading: initLoading} = useQuery(RealtimePrice, {
    variables: {currency: currency.id},
    onCompleted(initData) {
      if (initData?.realtimePrice?.btcSatPrice) {
        const {base, offset} = initData.realtimePrice.btcSatPrice;
        setPrice(base / 10 ** offset);
      }
    },
  });

  const {loading} = useSubscription(RealtimePriceSubscription, {
    variables: {currency: currency.id},
    onData({data}) {
      if (data.data.realtimePrice.realtimePrice.btcSatPrice) {
        const {base, offset} =
          data.data.realtimePrice.realtimePrice.btcSatPrice;
        setPrice(base / 10 ** offset);
      }
    },
  });

  const conversions = React.useMemo(
    () => ({
      satsToCurrency: (sats: number) => {
        const convertedCurrencyAmount =
          currency.fractionDigits === 2 ? (sats * price) / 100 : sats * price;
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
            ? (100 * currencyAmount) / price
            : currencyAmount / price;
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
    [price, formatCurrency, loading, initLoading, currency],
  );

  if (price === 0) {
    return {
      satsToCurrency: () => ({
        convertedCurrencyAmount: NaN,
        formattedCurrency: '0',
      }),
      currencyToSats: () => ({
        convertedCurrencyAmount: NaN,
        formattedCurrency: '0',
      }),
      loading: loading || initLoading,
    };
  }

  return conversions;
};

export default useRealtimePrice;
