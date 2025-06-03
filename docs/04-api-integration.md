# API Integration

## Overview

Flash POS integrates with multiple APIs and services to provide comprehensive Bitcoin payment functionality. The primary integration is through GraphQL for Lightning Network operations, with additional REST API integrations for BTCPay Server functionality.

## GraphQL Integration

### Apollo Client Configuration

**File**: `src/graphql/ApolloClient.ts`

```typescript
// Dual transport setup
const httpLink = createHttpLink({
  uri: FLASH_GRAPHQL_URI,
});

const wsLink = new GraphQLWsLink(
  createClient({
    url: FLASH_GRAPHQL_WS_URI,
    retryAttempts: 12,
    shouldRetry: () => true, // Force reconnection attempts
  }),
);

// Smart link routing
const link = split(
  ({query}) => {
    const definition = getMainDefinition(query);
    return definition.kind === 'OperationDefinition' && 
           definition.operation === 'subscription';
  },
  wsLink,    // Use WebSocket for subscriptions
  httpLink,  // Use HTTP for queries and mutations
);
```

### Environment Configuration

**Required Environment Variables:**
```bash
FLASH_GRAPHQL_URI=https://your-api.example.com/graphql
FLASH_GRAPHQL_WS_URI=wss://your-api.example.com/graphql
```

### GraphQL Operations

**Queries** (`src/graphql/queries.ts`):

```typescript
// Currency support
export const CurrencyList = gql`
  query currencyList {
    currencyList {
      id
      flag
      name
      symbol
      fractionDigits
    }
  }
`;

// Wallet information
export const AccountDefaultWallets = gql`
  query accountDefaultWallets($username: Username!) {
    accountDefaultWallet(username: $username) {
      id
      walletCurrency
    }
  }
`;

// Real-time pricing
export const RealtimePrice = gql`
  query realtimePriceInitial($currency: DisplayCurrency!) {
    realtimePrice(currency: $currency) {
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
`;
```

**Mutations** (`src/graphql/mutations.ts`):
- Lightning invoice generation
- Payment processing
- Wallet operations

**Subscriptions** (`src/graphql/subscriptions.ts`):
- Real-time payment status updates
- Live price feed updates
- Transaction confirmations

### Error Handling

**GraphQL Error Management:**
```typescript
const errorLink = onError(({graphQLErrors, networkError}) => {
  // Handle GraphQL errors
  if (graphQLErrors) {
    graphQLErrors.forEach(({message, locations, path}) => {
      if (message === 'PersistedQueryNotFound') {
        console.log(`[GraphQL info]: ${message}`);
      } else {
        console.warn(`[GraphQL error]: Message: ${message}, Path: ${path}`);
      }
    });
  }
  
  // Handle network errors
  if (networkError) {
    console.log(`[Network error]: ${networkError}`);
  }
});
```

**Retry Logic:**
```typescript
const retryLink = new RetryLink({
  attempts: {
    max: 5,
  },
});
```

## BTCPay Server Integration

### Configuration

**Environment Variables:**
```bash
BTC_PAY_SERVER=https://your-btcpay-server.com
PULL_PAYMENT_ID=your-pull-payment-id
```

### Rewards API Integration

**File**: `src/screens/Rewards.tsx:43-79`

```typescript
const onReward = async () => {
  const requestBody = {
    destination: lnurl,           // Customer's LNURL
    amount: 21,                   // Fixed 21 sats reward
    payoutMethodId: 'BTC-LN',     // Lightning Network payout
  };

  const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;

  try {
    const response = await axios.post(url, requestBody);
    
    if (response.data) {
      // Navigate to success screen
      navigation.navigate('RewardsSuccess', {
        rewardSatAmount: 21,
        balance: displayAmount,
      });
    }
  } catch (error) {
    toastShow({
      message: 'Reward is failed. Please try again.',
      type: 'error',
    });
  }
};
```

### Flashcard Balance API

**File**: `src/contexts/Flashcard.tsx:134-156`

```typescript
const getHtml = async (payload: string, currentScreen?: string) => {
  try {
    const payloadPart = payload.split('?')[1];
    const url = `${BTC_PAY_SERVER}/boltcards/balance?${payloadPart}`;
    const response = await axios.get(url);
    const html = response.data;

    // Parse HTML response for balance and transactions
    getLnurl(html);
    getBalance(html);
    getTransactions(html);
  } catch (err) {
    toastShow({
      message: 'Unsupported NFC card. Please ensure you are using a flashcard.',
      type: 'error',
    });
  }
};
```

## Custom Hooks for API Integration

### useRealtimePrice Hook

**File**: `src/hooks/useRealtimePrice.tsx`

```typescript
export const useRealtimePrice = () => {
  const {currency} = useAppSelector(state => state.amount);
  
  const {data, loading, error} = useQuery(RealtimePrice, {
    variables: {currency},
    pollInterval: 30000, // Update every 30 seconds
  });

  const satsToCurrency = useCallback((sats: number) => {
    // Convert satoshis to display currency
    const btcAmount = sats / 100000000;
    const fiatAmount = btcAmount * (data?.realtimePrice?.usdCentPrice?.base || 0);
    
    return {
      formattedCurrency: formatCurrency(fiatAmount, currency),
      rawAmount: fiatAmount,
    };
  }, [data, currency]);

  return {
    satsToCurrency,
    loading,
    error,
    currentPrice: data?.realtimePrice,
  };
};
```

### useFlashcard Hook

**File**: `src/hooks/useFlashcard.tsx`

```typescript
export const useFlashcard = () => {
  const context = useContext(FlashcardContext);
  
  if (!context) {
    throw new Error('useFlashcard must be used within FlashcardProvider');
  }
  
  return context;
};
```

## Data Parsing and Processing

### HTML Response Parsing

**Balance Extraction:**
```typescript
const getBalance = (html: string) => {
  const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/);
  if (balanceMatch) {
    const parsedBalance = balanceMatch[1].replace(/,/g, '');
    const satoshiAmount = parseInt(parsedBalance, 10);
    setBalanceInSats(satoshiAmount);
  }
};
```

**LNURL Extraction:**
```typescript
const getLnurl = (html: string) => {
  const lnurlMatch = html.match(/href="lightning:(lnurl\w+)"/);
  if (lnurlMatch) {
    setLnurl(lnurlMatch[1]);
  }
};
```

**Transaction History Parsing:**
```typescript
const getTransactions = (html: string) => {
  const transactionMatches = [
    ...html.matchAll(
      /<time datetime="(.*?)".*?>.*?<\/time>\s*<\/td>\s*<td.*?>\s*<span.*?>(-?\d{1,3}(,\d{3})*) SATS<\/span>/g,
    ),
  ];
  
  const data = transactionMatches.map(match => ({
    date: match[1],
    sats: match[2],
  }));
  
  setTransactions(data);
};
```

## LNURL Protocol Integration

### LNURL-Withdraw Support

**File**: `src/contexts/Flashcard.tsx:106-132`

```typescript
const getPayDetails = async (payload: string) => {
  try {
    const lnurlParams = await getParams(payload);
    
    if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
      const {k1, callback} = lnurlParams;
      
      setK1(k1);
      setCallback(callback);
    } else {
      toastShow({
        message: `not a properly configured lnurl withdraw tag`,
        type: 'error',
      });
    }
  } catch (err) {
    toastShow({
      message: 'Unsupported NFC card. Please ensure you are using a flashcard.',
      type: 'error',
    });
  }
};
```

## API Integration Patterns

### 1. Query Pattern
```typescript
// Component using GraphQL query
const MyComponent = () => {
  const {data, loading, error} = useQuery(MY_QUERY, {
    variables: {param: value},
    errorPolicy: 'all',
  });

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} />;
  
  return <div>{data.field}</div>;
};
```

### 2. Mutation Pattern
```typescript
// Component using GraphQL mutation
const MyComponent = () => {
  const [executeMutation, {loading, error}] = useMutation(MY_MUTATION);

  const handleSubmit = async () => {
    try {
      const result = await executeMutation({
        variables: {input: formData},
      });
      // Handle success
    } catch (err) {
      // Handle error
    }
  };

  return <Form onSubmit={handleSubmit} />;
};
```

### 3. Subscription Pattern
```typescript
// Component using GraphQL subscription
const MyComponent = () => {
  const {data, loading} = useSubscription(MY_SUBSCRIPTION, {
    variables: {id: selectedId},
    onSubscriptionData: ({subscriptionData}) => {
      // Handle real-time updates
    },
  });

  return <RealtimeDisplay data={data} />;
};
```

## Error Handling Strategies

### 1. Network Error Recovery
- **Automatic Retry**: Configured retry logic for transient failures
- **Exponential Backoff**: Progressive delay between retry attempts
- **Circuit Breaker**: Prevent cascading failures

### 2. User Experience
- **Loading States**: Clear loading indicators during API calls
- **Error Messages**: User-friendly error messages
- **Offline Support**: Graceful degradation when network unavailable

### 3. Development Debugging
- **Console Logging**: Structured logging for API interactions
- **Error Tracking**: Comprehensive error reporting
- **Query Inspection**: GraphQL query debugging tools

## Security Considerations

### 1. Authentication
- **API Keys**: Secure storage of authentication credentials
- **Token Management**: Automatic token refresh and expiration handling
- **Request Signing**: Cryptographic request verification where required

### 2. Data Validation
- **Input Sanitization**: All user inputs validated before API calls
- **Response Validation**: API responses validated against expected schemas
- **Type Safety**: TypeScript ensures type-safe API interactions

### 3. Network Security
- **HTTPS Only**: All API communications over encrypted connections
- **Certificate Pinning**: Protection against man-in-the-middle attacks
- **Request Timeouts**: Prevent hanging requests