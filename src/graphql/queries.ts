import {gql} from '@apollo/client';

export const CurrencyList = gql`
  query currencyList {
    currencyList {
      __typename
      id
      flag
      name
      symbol
      fractionDigits
    }
  }
`;

export const AccountDefaultWallets = gql`
  query accountDefaultWallets($username: Username!) {
    accountDefaultWallet(username: $username) {
      __typename
      id
      walletCurrency
    }
  }
`;
