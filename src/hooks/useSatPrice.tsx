import * as React from 'react';
import {useSubscription} from '@apollo/client';
import {PriceSubscription} from '../graphql/subscriptions';

const useSatPrice = () => {
  const [price, setPrice] = React.useState<number>(0);

  const {data} = useSubscription(PriceSubscription, {
    variables: {
      amount: 1,
      amountCurrencyUnit: 'BTCSAT',
      priceCurrencyUnit: 'USDCENT',
    },
  });

  // Update price when subscription data changes
  React.useEffect(() => {
    if (data?.price?.price) {
      const {base, offset} = data.price.price;
      setPrice(base / 10 ** offset);
    }
  }, [data]);

  const conversions = React.useMemo(
    () => ({
      satsToUsd: (sats: number) => (sats * price) / 100,
      usdToSats: (usd: number) => (100 * usd) / price,
    }),
    [price], // Now properly depends on price
  );

  if (price === 0) {
    return {
      satsToUsd: () => NaN,
      usdToSats: () => NaN,
    };
  }

  return conversions;
};

export default useSatPrice;
