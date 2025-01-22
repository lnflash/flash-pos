import {gql} from '@apollo/client';

export const LnUsdInvoiceCreateOnBehalfOfRecipient = gql`
  mutation lnUsdInvoiceCreateOnBehalfOfRecipient(
    $input: LnUsdInvoiceCreateOnBehalfOfRecipientInput!
  ) {
    lnUsdInvoiceCreateOnBehalfOfRecipient(input: $input) {
      errors {
        __typename
        message
      }
      invoice {
        __typename
        paymentHash
        paymentRequest
        paymentSecret
        satoshis
      }
      __typename
    }
  }
`;
