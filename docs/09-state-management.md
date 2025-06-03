# State Management

## Overview

Flash POS uses Redux Toolkit with Redux Persist for comprehensive state management. The architecture provides type-safe, predictable state updates with automatic persistence for critical user data.

## Redux Store Architecture

### Store Configuration

**File**: `src/store/index.ts`

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import {configureStore} from '@reduxjs/toolkit';
import {persistStore, persistReducer} from 'redux-persist';

const persistConfig = {
  key: 'root',
  storage: AsyncStorage,
  whitelist: ['user', 'amount'],  // Only persist these slices
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);
```

### Type-Safe Store Hooks

**File**: `src/store/hooks.ts`

```typescript
import {useDispatch, useSelector, TypedUseSelectorHook} from 'react-redux';
import type {RootState, AppDispatch} from './index';

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

// Type-safe store interface
export type AppThunk<ReturnType = void> = ThunkAction<
  ReturnType,
  RootState,
  unknown,
  Action<string>
>;
```

## State Slices

### 1. User Slice

**File**: `src/store/slices/userSlice.ts`

**Purpose**: Manages merchant authentication and profile data

**State Structure**:
```typescript
interface UserState {
  username: string | null;     // Authenticated merchant username
  profile?: UserProfile;       // Extended profile information
  isAuthenticated: boolean;    // Authentication status
}

interface UserProfile {
  displayName: string;
  businessName?: string;
  contactInfo?: ContactInfo;
  preferences?: UserPreferences;
}
```

**Actions**:
```typescript
export const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUsername: (state, action: PayloadAction<string>) => {
      state.username = action.payload;
      state.isAuthenticated = true;
    },
    updateProfile: (state, action: PayloadAction<Partial<UserProfile>>) => {
      state.profile = { ...state.profile, ...action.payload };
    },
    logout: (state) => {
      state.username = null;
      state.profile = undefined;
      state.isAuthenticated = false;
    },
  },
});
```

**Usage Example**:
```typescript
const ProfileScreen = () => {
  const {username, profile} = useAppSelector(state => state.user);
  const dispatch = useAppDispatch();

  const updateBusinessName = (name: string) => {
    dispatch(updateProfile({ businessName: name }));
  };

  return (
    <View>
      <Text>Welcome, {username}</Text>
      {/* Profile editing interface */}
    </View>
  );
};
```

### 2. Amount Slice

**File**: `src/store/slices/amountSlice.ts`

**Purpose**: Manages payment amount input and currency selection

**State Structure**:
```typescript
interface AmountState {
  amount: string;              // Current payment amount as string
  currency: CurrencyCode;      // Selected display currency
  lastEnteredAmount?: string;  // Previous amount for quick access
  inputHistory: string[];      // Recent amount entries
}

type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CAD' | 'AUD';
```

**Actions**:
```typescript
export const amountSlice = createSlice({
  name: 'amount',
  initialState,
  reducers: {
    setAmount: (state, action: PayloadAction<string>) => {
      state.lastEnteredAmount = state.amount;
      state.amount = action.payload;
      
      // Add to history if valid amount
      if (action.payload && parseFloat(action.payload) > 0) {
        state.inputHistory.unshift(action.payload);
        state.inputHistory = state.inputHistory.slice(0, 10); // Keep last 10
      }
    },
    setCurrency: (state, action: PayloadAction<CurrencyCode>) => {
      state.currency = action.payload;
    },
    clearAmount: (state) => {
      state.amount = '';
    },
    appendDigit: (state, action: PayloadAction<string>) => {
      // Handle number pad input
      const digit = action.payload;
      if (digit === '.' && state.amount.includes('.')) return;
      
      state.amount += digit;
    },
    removeLastDigit: (state) => {
      state.amount = state.amount.slice(0, -1);
    },
  },
});
```

**Keypad Integration**:
```typescript
const NumPad = () => {
  const {amount} = useAppSelector(state => state.amount);
  const dispatch = useAppDispatch();

  const handleDigitPress = (digit: string) => {
    dispatch(appendDigit(digit));
  };

  const handleBackspace = () => {
    dispatch(removeLastDigit());
  };

  const handleClear = () => {
    dispatch(clearAmount());
  };

  return (
    <KeypadGrid>
      {/* Number buttons */}
      <KeypadButton onPress={() => handleDigitPress('1')}>1</KeypadButton>
      {/* Additional keypad buttons */}
    </KeypadGrid>
  );
};
```

### 3. Invoice Slice

**File**: `src/store/slices/invoiceSlice.ts`

**Purpose**: Manages Lightning invoice generation and payment tracking

**State Structure**:
```typescript
interface InvoiceState {
  currentInvoice?: LightningInvoice;
  paymentStatus: PaymentStatus;
  invoiceHistory: LightningInvoice[];
  expirationTime?: number;
  qrCodeData?: string;
}

interface LightningInvoice {
  id: string;
  paymentRequest: string;    // Lightning invoice string
  amount: number;            // Amount in satoshis
  description?: string;      // Payment description
  expiresAt: number;        // Expiration timestamp
  createdAt: number;        // Creation timestamp
  status: InvoiceStatus;
}

type PaymentStatus = 'idle' | 'generating' | 'pending' | 'completed' | 'expired' | 'failed';
type InvoiceStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
```

**Actions**:
```typescript
export const invoiceSlice = createSlice({
  name: 'invoice',
  initialState,
  reducers: {
    generateInvoice: (state, action: PayloadAction<InvoiceParams>) => {
      state.paymentStatus = 'generating';
    },
    setCurrentInvoice: (state, action: PayloadAction<LightningInvoice>) => {
      state.currentInvoice = action.payload;
      state.paymentStatus = 'pending';
      state.qrCodeData = action.payload.paymentRequest;
    },
    updatePaymentStatus: (state, action: PayloadAction<PaymentStatus>) => {
      state.paymentStatus = action.payload;
      
      // Update current invoice status
      if (state.currentInvoice) {
        state.currentInvoice.status = 
          action.payload === 'completed' ? 'paid' : 
          action.payload === 'expired' ? 'expired' : 
          'pending';
      }
    },
    addToHistory: (state, action: PayloadAction<LightningInvoice>) => {
      state.invoiceHistory.unshift(action.payload);
      state.invoiceHistory = state.invoiceHistory.slice(0, 50); // Keep last 50
    },
    clearCurrentInvoice: (state) => {
      state.currentInvoice = undefined;
      state.paymentStatus = 'idle';
      state.qrCodeData = undefined;
    },
  },
});
```

## Redux Persist Integration

### Persistence Configuration

**Selective Persistence**:
```typescript
const persistConfig = {
  key: 'root',
  storage: AsyncStorage,
  whitelist: ['user', 'amount'],  // Only persist these slices
  blacklist: ['invoice'],         // Don't persist temporary invoice data
};
```

**Why Selective Persistence**:
- **User data**: Username and profile should persist between sessions
- **Amount data**: Last entered amounts and currency preference
- **Invoice data**: Temporary and should not persist (security/freshness)

### App Integration

**Provider Setup** (`App.tsx:33-45`):
```typescript
function App(): React.JSX.Element {
  return (
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        {/* App content */}
      </PersistGate>
    </Provider>
  );
}
```

**Loading State Handling**:
```typescript
const AppContent = () => {
  const [isRehydrated, setIsRehydrated] = useState(false);

  useEffect(() => {
    persistor.subscribe(() => {
      setIsRehydrated(true);
    });
  }, []);

  if (!isRehydrated) {
    return <LoadingScreen />;
  }

  return <MainApp />;
};
```

## Integration with GraphQL

### Apollo Cache Integration

**State Synchronization**:
```typescript
// Update Redux state when GraphQL data changes
const PaymentStatusUpdater = () => {
  const dispatch = useAppDispatch();
  
  const { data } = useSubscription(PAYMENT_STATUS_SUBSCRIPTION, {
    onSubscriptionData: ({ subscriptionData }) => {
      const status = subscriptionData.data?.paymentStatus;
      if (status) {
        dispatch(updatePaymentStatus(status));
      }
    },
  });

  return null;
};
```

### Data Flow Patterns

**GraphQL → Redux Flow**:
1. GraphQL query/subscription receives data
2. Component extracts relevant state information
3. Dispatch Redux action with new data
4. Redux state updates trigger re-renders

**Redux → GraphQL Flow**:
1. User interaction triggers Redux action
2. Component reads updated Redux state
3. Use Redux state as GraphQL query variables
4. GraphQL executes with new parameters

## Context Integration

### FlashcardProvider State

**Complementary State Management**:
```typescript
// Context for NFC-specific state
const FlashcardContext = createContext<FlashcardInterface>({
  tag: undefined,              // NFC tag data
  balanceInSats: undefined,    // Current flashcard balance
  transactions: undefined,     // Transaction history
  loading: undefined,          // NFC operation loading state
});

// Redux for app-wide state
const AppState = {
  user: { username: 'merchant123' },
  amount: { amount: '10.50', currency: 'USD' },
  invoice: { paymentStatus: 'pending' },
};
```

**State Boundaries**:
- **Redux**: Persistent, app-wide state
- **Context**: Temporary, feature-specific state
- **GraphQL Cache**: Server-synchronized state

## Performance Optimization

### Selector Optimization

**Memoized Selectors**:
```typescript
import { createSelector } from '@reduxjs/toolkit';

const selectUser = (state: RootState) => state.user;
const selectAmount = (state: RootState) => state.amount;

const selectFormattedAmount = createSelector(
  [selectAmount, selectUser],
  (amount, user) => {
    // Expensive formatting calculation
    return formatCurrencyForUser(amount.amount, amount.currency, user.profile);
  }
);

// Usage in component
const FormattedAmount = () => {
  const formattedAmount = useAppSelector(selectFormattedAmount);
  return <Text>{formattedAmount}</Text>;
};
```

### Component Optimization

**Selective Re-rendering**:
```typescript
const AmountDisplay = React.memo(() => {
  // Only re-render when amount changes
  const amount = useAppSelector(state => state.amount.amount);
  return <Text>{amount}</Text>;
});

const CurrencySelector = React.memo(() => {
  // Only re-render when currency changes
  const currency = useAppSelector(state => state.amount.currency);
  return <CurrencyPicker selectedCurrency={currency} />;
});
```

## Debugging and Development

### Redux DevTools Integration

**Development Setup**:
```typescript
export const store = configureStore({
  reducer: persistedReducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
  devTools: __DEV__, // Enable Redux DevTools in development
});
```

### State Logging

**Action Logging**:
```typescript
const loggerMiddleware: Middleware = store => next => action => {
  if (__DEV__) {
    console.group(`Action: ${action.type}`);
    console.log('Previous State:', store.getState());
    console.log('Action:', action);
  }
  
  const result = next(action);
  
  if (__DEV__) {
    console.log('Next State:', store.getState());
    console.groupEnd();
  }
  
  return result;
};
```

### State Validation

**Runtime Type Checking**:
```typescript
const validateState = (state: RootState): boolean => {
  try {
    // Validate user slice
    if (state.user.username && typeof state.user.username !== 'string') {
      throw new Error('Invalid username type');
    }
    
    // Validate amount slice
    if (state.amount.amount && isNaN(parseFloat(state.amount.amount))) {
      throw new Error('Invalid amount format');
    }
    
    return true;
  } catch (error) {
    console.error('State validation failed:', error);
    return false;
  }
};
```

## Error Handling

### Action Error Handling

**Async Action Error Management**:
```typescript
export const generateInvoiceAsync = createAsyncThunk(
  'invoice/generateInvoice',
  async (params: InvoiceParams, { rejectWithValue }) => {
    try {
      const response = await apolloClient.mutate({
        mutation: GENERATE_INVOICE_MUTATION,
        variables: params,
      });
      
      return response.data.generateInvoice;
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// Handle in slice
extraReducers: (builder) => {
  builder
    .addCase(generateInvoiceAsync.pending, (state) => {
      state.paymentStatus = 'generating';
    })
    .addCase(generateInvoiceAsync.fulfilled, (state, action) => {
      state.currentInvoice = action.payload;
      state.paymentStatus = 'pending';
    })
    .addCase(generateInvoiceAsync.rejected, (state, action) => {
      state.paymentStatus = 'failed';
      state.error = action.payload as string;
    });
}
```

### Persistence Error Handling

**Storage Error Recovery**:
```typescript
const persistConfig = {
  key: 'root',
  storage: AsyncStorage,
  whitelist: ['user', 'amount'],
  transforms: [
    {
      in: (inboundState, key) => {
        // Transform before persisting
        return inboundState;
      },
      out: (outboundState, key) => {
        try {
          // Validate after rehydrating
          return validateStateSlice(outboundState, key) ? outboundState : undefined;
        } catch (error) {
          console.error(`Failed to rehydrate ${key}:`, error);
          return undefined; // Return undefined to use initial state
        }
      },
    },
  ],
};
```

## Testing State Management

### Unit Testing Slices

**Slice Testing Pattern**:
```typescript
import { amountSlice, setAmount, appendDigit } from '../amountSlice';

describe('amountSlice', () => {
  const initialState = {
    amount: '',
    currency: 'USD',
    inputHistory: [],
  };

  it('should handle setAmount', () => {
    const actual = amountSlice.reducer(
      initialState,
      setAmount('10.50')
    );
    
    expect(actual.amount).toEqual('10.50');
    expect(actual.inputHistory).toContain('10.50');
  });

  it('should handle appendDigit', () => {
    const state = { ...initialState, amount: '10' };
    const actual = amountSlice.reducer(state, appendDigit('.'));
    
    expect(actual.amount).toEqual('10.');
  });
});
```

### Integration Testing

**Store Integration Testing**:
```typescript
import { store } from '../store';
import { setUsername } from '../slices/userSlice';

describe('Store Integration', () => {
  it('should update user state', () => {
    store.dispatch(setUsername('testmerchant'));
    
    const state = store.getState();
    expect(state.user.username).toBe('testmerchant');
    expect(state.user.isAuthenticated).toBe(true);
  });
});
```

## Future Enhancements

### 1. Advanced State Management

- **State Machines**: Implement XState for complex state flows
- **Optimistic Updates**: Client-side state updates with server reconciliation
- **Offline Support**: Queue actions for offline scenarios

### 2. Performance Improvements

- **Lazy Loading**: Load slices on demand
- **State Normalization**: Normalize complex nested state structures
- **Virtual State**: Computed state for large datasets

### 3. Developer Experience

- **State Inspector**: Visual state debugging tools
- **Time Travel**: Redux time travel debugging
- **State Snapshots**: Export/import state for testing

### 4. Advanced Persistence

- **Selective Rehydration**: Choose which parts of state to restore
- **Migration System**: Handle state schema changes
- **Encrypted Storage**: Secure sensitive state data