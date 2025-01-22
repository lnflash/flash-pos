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

export const PriceSubscription = gql`
  subscription price(
    $amount: SatAmount!
    $amountCurrencyUnit: ExchangeCurrencyUnit!
    $priceCurrencyUnit: ExchangeCurrencyUnit!
  ) {
    price(
      input: {
        amount: $amount
        amountCurrencyUnit: $amountCurrencyUnit
        priceCurrencyUnit: $priceCurrencyUnit
      }
    ) {
      errors {
        message
      }
      price {
        base
        offset
        currencyUnit
        formattedAmount
      }
    }
  }
`;

export const LnInvoicePaymentStatus = gql`
  subscription lnInvoicePaymentStatus($input: LnInvoicePaymentStatusInput!) {
    lnInvoicePaymentStatus(input: $input) {
      __typename
      errors {
        message
        __typename
      }
      status
    }
  }
`;
