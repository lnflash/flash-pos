import * as React from 'react';

// hooks
import {useQuery, useSubscription} from '@apollo/client';
import {useDisplayCurrency} from './useDisplayCurrency';
import {useAppSelector} from '../store/hooks';

// utils
import {SAT_CURRENCY} from '../utils/satCurrency';

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

  // SAT is the native unit: conversions are the identity and no price feed
  // is needed. Subscribing with a 'SAT' currency would only error.
  const isSat = currency.id === SAT_CURRENCY.id;

  const {loading} = useSubscription(RealtimePriceSubscription, {
    variables: {currency: currency.id},
    skip: isSat,
    onData({data}) {
      if (data.data.realtimePrice.realtimePrice.btcSatPrice) {
        const {base, offset} =
          data.data.realtimePrice.realtimePrice.btcSatPrice;
        setPrice(base / 10 ** offset);
      }
    },
  });

  const satConversions = React.useMemo(
    () => ({
      satsToCurrency: (sats: number) => ({
        convertedCurrencyAmount: sats,
        formattedCurrency: `${SAT_CURRENCY.symbol} ${sats}`,
      }),
      currencyToSats: (currencyAmount: number) => ({
        convertedCurrencyAmount: currencyAmount,
        formattedCurrency: `${SAT_CURRENCY.symbol} ${currencyAmount}`,
      }),
      loading: false,
    }),
    [],
  );

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

  if (isSat) {
    return satConversions;
  }

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
