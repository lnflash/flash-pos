import * as React from 'react';
import {useSubscription} from '@apollo/client';
import {PriceSubscription} from '../graphql/subscriptions';
import {useQuery} from '@apollo/client';
import {RealtimePrice} from '../graphql/queries';

const useSatPrice = () => {
  const [price, setPrice] = React.useState<number>(0);

  // Primary source: the realtimePrice query over HTTP. The backend does not
  // expose the websocket endpoint the PriceSubscription needs (every path
  // rejects the upgrade), so polling is what actually delivers the price —
  // the subscription below stays as a live-update bonus when a WS exists.
  const {
    data: rtData,
    refetch: refetchQuery,
  } = useQuery(RealtimePrice, {
    variables: {currency: 'USD'},
    pollInterval: 20000,
    notifyOnNetworkStatusChange: true,
  });

  React.useEffect(() => {
    const btc = rtData?.realtimePrice?.btcSatPrice;
    if (btc) {
      const nextPrice = btc.base / 10 ** btc.offset;
      setPrice(Number.isFinite(nextPrice) && nextPrice > 0 ? nextPrice : 0);
    }
  }, [rtData]);

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
      const nextPrice = base / 10 ** offset;
      setPrice(Number.isFinite(nextPrice) && nextPrice > 0 ? nextPrice : 0);
    }
  }, [data]);

  const conversions = React.useMemo(
    () => ({
      satsToUsd: (sats: number) => {
        if (price <= 0 || !Number.isFinite(sats)) {
          return 0;
        }

        return (sats * price) / 100;
      },
      usdToSats: (usd: number) => {
        if (price <= 0 || !Number.isFinite(usd)) {
          return 0;
        }

        return (100 * usd) / price;
      },
    }),
    [price],
  );

  /**
   * On-demand price fetch: resolves with a usable USD-per-sat or 0. The
   * keypad awaits this once before bouncing the merchant with 'price is
   * still loading' — a cold start should not cost a tap.
   */
  const refetchPrice = async (): Promise<number> => {
    try {
      const {data} = await refetchQuery();
      const btc = data?.realtimePrice?.btcSatPrice;
      if (btc) {
        const next = btc.base / 10 ** btc.offset;
        const usable = Number.isFinite(next) && next > 0 ? next : 0;
        setPrice(usable);
        return usable;
      }
    } catch {
      // fall through: 0
    }
    return 0;
  };

  return {...conversions, refetchPrice};
};

export default useSatPrice;
