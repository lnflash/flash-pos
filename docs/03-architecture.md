# Architecture

## Overview

Flash POS follows a modern React Native architecture with clear separation of concerns, type safety, and scalable patterns. The application uses a layered architecture approach with reactive state management and GraphQL for API communication.

## Architecture Layers

```
┌─────────────────────────────────────────┐
│                 UI Layer                │
│         (Screens + Components)          │
├─────────────────────────────────────────┤
│              Business Logic             │
│          (Hooks + Contexts)             │
├─────────────────────────────────────────┤
│             State Management            │
│            (Redux + Apollo)             │
├─────────────────────────────────────────┤
│               Data Layer                │
│          (GraphQL + REST APIs)          │
├─────────────────────────────────────────┤
│             Native Layer                │
│         (NFC + Printer Modules)         │
└─────────────────────────────────────────┘
```

## Core Architecture Patterns

### 1. Component Architecture

**Atomic Design Principles**
```
src/components/
├── buttons/          # Basic button components
├── keypad/          # Number input components  
├── invoice/         # Invoice-related components
├── flashcardBalance/ # Flashcard UI components
└── modals/          # Modal components
```

**Component Patterns Used:**
- **Functional Components**: All components use React hooks
- **Styled Components**: CSS-in-JS for styling
- **Type Safety**: Full TypeScript integration
- **Composition**: Reusable component building blocks

### 2. State Management Architecture

**Redux Toolkit Pattern**
```typescript
// Store Structure
src/store/
├── index.ts          # Store configuration
├── hooks.ts          # Typed hooks (useAppSelector, useAppDispatch)
├── reducers.ts       # Root reducer
└── slices/
    ├── amountSlice.ts    # Payment amount state
    ├── invoiceSlice.ts   # Invoice generation state
    └── userSlice.ts      # User profile state
```

**State Persistence**
- **Redux Persist**: Automatic state persistence to AsyncStorage
- **Selective Persistence**: Only `user` and `amount` slices are persisted
- **Rehydration**: Automatic state restoration on app startup

### 3. Navigation Architecture

**React Navigation v7 Structure**
```typescript
// Navigation Hierarchy
Root Navigator (Stack)
├── Auth Screen
├── Home Navigator (Tabs)
│   ├── Keypad Tab
│   ├── Rewards Tab  
│   ├── Paycode Tab
│   └── Profile Tab
├── Invoice Screen
├── Success Screen
├── FlashcardBalance Screen
└── RewardsSuccess Screen
```

**Navigation Patterns:**
- **Type-safe Navigation**: Full TypeScript route definitions
- **Deep Linking Support**: URL-based navigation
- **Modal Presentations**: Stack-based modal screens
- **Tab Persistence**: Tab state maintained across navigation

### 4. Data Flow Architecture

**Unidirectional Data Flow**
```
UI Components → Actions → Reducers → State → UI Components
     ↓              ↑
GraphQL Queries ← Apollo Client ← Network Layer
```

**API Data Flow:**
1. Component dispatches action or calls hook
2. Hook/action triggers GraphQL query/mutation
3. Apollo Client manages network request
4. Response updates Apollo cache
5. Component re-renders with new data

## Technology Stack Integration

### 1. React Native Foundation
- **Version**: 0.76.6
- **TypeScript**: Full type safety
- **Hot Reloading**: Development efficiency
- **Platform Abstraction**: Single codebase for iOS/Android

### 2. State Management Stack
```typescript
// Redux Toolkit Configuration
export const store = configureStore({
  reducer: persistedReducer,
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});
```

### 3. GraphQL Integration
```typescript
// Apollo Client Setup
const client = new ApolloClient({
  link: split(
    ({query}) => {
      const definition = getMainDefinition(query);
      return definition.kind === 'OperationDefinition' && 
             definition.operation === 'subscription';
    },
    wsLink,    // WebSocket for subscriptions
    httpLink,  // HTTP for queries/mutations
  ),
  cache: new InMemoryCache(),
});
```

### 4. Styling Architecture
```typescript
// Styled Components Pattern
const StyledButton = styled.TouchableOpacity<{variant: 'primary' | 'secondary'}>`
  background-color: ${({variant}) => 
    variant === 'primary' ? '#007856' : '#ffffff'};
  padding: 16px;
  border-radius: 8px;
`;
```

## Context Architecture

### 1. Provider Hierarchy
```typescript
// App.tsx Provider Nesting
<Provider store={store}>
  <PersistGate persistor={persistor}>
    <ApolloProvider client={client}>
      <ActivityIndicatorProvider>
        <FlashcardProvider>
          <Layout />
        </FlashcardProvider>
      </ActivityIndicatorProvider>
    </ApolloProvider>
  </PersistGate>
</Provider>
```

### 2. Context Responsibilities
- **ActivityIndicatorProvider**: Global loading states
- **FlashcardProvider**: NFC card management and state
- **Redux Provider**: Global application state
- **Apollo Provider**: GraphQL client and cache

## Custom Hooks Architecture

### 1. Data Hooks
```typescript
// Custom hooks pattern
export const useFlashcard = () => {
  const context = useContext(FlashcardContext);
  if (!context) {
    throw new Error('useFlashcard must be used within FlashcardProvider');
  }
  return context;
};
```

### 2. Hook Categories
- **useFlashcard**: NFC card state and operations
- **useRealtimePrice**: Bitcoin price conversion
- **useDisplayCurrency**: Currency formatting
- **useActivityIndicator**: Loading state management
- **usePrint**: Receipt printing functionality
- **useNfc**: NFC hardware management

## Native Module Integration

### 1. Android Native Modules
```kotlin
// PrinterModule.java
@ReactModule(name = PrinterModule.NAME)
public class PrinterModule extends ReactContextBaseJavaModule {
  public static final String NAME = "PrinterModule";
  
  @ReactMethod
  public void printSilently(String content, Promise promise) {
    // Native printing implementation
  }
}
```

### 2. iOS Native Modules
- Similar structure for iOS printing capabilities
- Platform-specific implementations
- Unified JavaScript interface

## Security Architecture

### 1. Environment Variables
- **Secure Storage**: Sensitive configuration in environment variables
- **Build-time Injection**: Variables embedded during build process
- **No Hardcoded Secrets**: All API keys and URLs externalized

### 2. Network Security
- **HTTPS Only**: All API communications over HTTPS
- **GraphQL Security**: Query validation and rate limiting
- **Error Handling**: Secure error messages without sensitive data exposure

## Performance Architecture

### 1. Optimization Strategies
- **React.memo**: Component memoization where appropriate
- **useMemo/useCallback**: Expensive computation caching
- **Apollo Cache**: Intelligent GraphQL response caching
- **Image Optimization**: Optimized assets and lazy loading

### 2. Bundle Optimization
- **Metro Configuration**: Optimized bundling
- **Tree Shaking**: Unused code elimination
- **Asset Linking**: Efficient asset management

## Error Handling Architecture

### 1. Error Boundaries
- **Component-level**: Local error containment
- **Global Handler**: Application-wide error management
- **User Feedback**: Toast notifications for user-facing errors

### 2. Network Error Handling
```typescript
// Apollo Error Link
const errorLink = onError(({graphQLErrors, networkError}) => {
  if (graphQLErrors) {
    graphQLErrors.forEach(({message, path}) => {
      console.warn(`[GraphQL error]: Message: ${message}, Path: ${path}`);
    });
  }
  if (networkError) {
    console.log(`[Network error]: ${networkError}`);
  }
});
```

## Testing Architecture

### 1. Testing Strategy
- **Unit Tests**: Component and utility function testing
- **Integration Tests**: Feature workflow testing
- **E2E Tests**: Full application flow testing
- **Native Module Tests**: Platform-specific functionality testing

### 2. Testing Tools
- **Jest**: Test runner and assertion library
- **React Native Testing Library**: Component testing utilities
- **Mock Services**: GraphQL and native module mocking

## Deployment Architecture

### 1. Build Configuration
- **Environment-specific Builds**: Development, staging, production
- **Platform Builds**: Separate Android/iOS build processes
- **Code Signing**: Platform-specific signing configurations

### 2. CI/CD Integration
- **Automated Testing**: Pre-deployment test execution
- **Build Automation**: Automated platform builds
- **Deployment Pipelines**: Staged deployment processes