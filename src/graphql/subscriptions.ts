import {gql} from '@apollo/client';

export const RealtimePriceSubscription = gql`
  subscription realtimePriceWs($currency: string!) {
    realtimePrice(input: {currency: $currency}) {
      errors {
        message
      }
      realtimePrice {
        timestamp
        btcSatPrice {
          base
          offset
        }
        usdCentPrice {
          base
          offset
        }
        denominatorCurrency
      }
    }
  }
`;
