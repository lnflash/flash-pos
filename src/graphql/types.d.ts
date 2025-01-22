export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;

export type Scalars = {
  ID: string;
  String: string;
  Boolean: boolean;
  Int: number;
  Float: number;
  /** An Opaque Bearer token */
  AuthToken: string;
  /** (Positive) Cent amount (1/100 of a dollar) */
  CentAmount: number;
  /** An alias name that a user can set for a wallet (with which they have transactions) */
  ContactAlias: string;
  /** A CCA2 country code (ex US, FR, etc) */
  CountryCode: string;
  /** Display currency of an account */
  DisplayCurrency: string;
  /** Email address */
  EmailAddress: string;
  /** An id to be passed between registrationInitiate and registrationValidate for confirming email */
  EmailRegistrationId: string;
  EndpointId: string;
  /** Url that will be fetched on events for the account */
  EndpointUrl: string;
  /** Feedback shared with our user */
  Feedback: string;
  /** Hex-encoded string of 32 bytes */
  Hex32Bytes: string;
  Language: string;
  LnPaymentPreImage: string;
  /** BOLT11 lightning invoice payment request with the amount included */
  LnPaymentRequest: string;
  LnPaymentSecret: string;
  /** A bech32-encoded HTTPS/Onion URL that can be interacted with automatically by a WALLET in a standard way such that a SERVICE can provide extra services or a better experience for the user. Ref: https://github.com/lnurl/luds/blob/luds/01.md  */
  Lnurl: string;
  /** Text field in a lightning payment transaction */
  Memo: string;
  /** (Positive) amount of minutes */
  Minutes: string;
  NotificationCategory: string;
  /** An address for an on-chain bitcoin destination */
  OnChainAddress: string;
  OnChainTxHash: string;
  /** An authentication code valid for a single use */
  OneTimeAuthCode: string;
  PaymentHash: string;
  /** Phone number which includes country code */
  Phone: string;
  /** Non-fractional signed whole numeric value between -(2^53) + 1 and 2^53 - 1 */
  SafeInt: number;
  /** (Positive) Satoshi amount */
  SatAmount: number;
  /** (Positive) amount of seconds */
  Seconds: number;
  /** An amount (of a currency) that can be negative (e.g. in a transaction) */
  SignedAmount: number;
  /** A string amount (of a currency) that can be negative (e.g. in a transaction) */
  SignedDisplayMajorAmount: string;
  /** Timestamp field, serialized as Unix time (the number of seconds since the Unix epoch) */
  Timestamp: number;
  /** A time-based one-time password */
  TotpCode: string;
  /** An id to be passed between set and verify for confirming totp */
  TotpRegistrationId: string;
  /** A secret to generate time-based one-time password */
  TotpSecret: string;
  /** Unique identifier of a user */
  Username: string;
  /** Unique identifier of a wallet */
  WalletId: string;
};

export type LnUsdInvoiceCreateOnBehalfOfRecipientInput = {
  /** Amount in USD cents. */
  readonly amount: Scalars['CentAmount'];
  readonly descriptionHash?: InputMaybe<Scalars['Hex32Bytes']>;
  /** Optional invoice expiration time in minutes. */
  readonly expiresIn?: InputMaybe<Scalars['Minutes']>;
  /** Optional memo for the lightning invoice. Acts as a note to the recipient. */
  readonly memo?: InputMaybe<Scalars['Memo']>;
  /** Wallet ID for a USD wallet which belongs to the account of any user. */
  readonly recipientWalletId: Scalars['WalletId'];
};

export type LnInvoicePaymentStatusInput = {
  readonly paymentRequest: Scalars['LnPaymentRequest'];
};
