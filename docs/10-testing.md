# Testing

## Overview

Flash POS follows a comprehensive testing strategy covering unit tests, integration tests, and end-to-end testing. The testing approach ensures reliability, maintainability, and quality across all application layers.

## Testing Stack

### Core Testing Tools

- **Jest**: 29.6.3 - Test runner and assertion library
- **React Test Renderer**: 18.3.1 - Component rendering for tests
- **React Native Testing Library**: Component testing utilities
- **TypeScript**: Type checking during tests
- **Mock Services**: GraphQL and native module mocking

### Configuration

**Jest Configuration** (`jest.config.js`):
```javascript
module.exports = {
  preset: 'react-native',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['**/__tests__/**/*.(ts|tsx|js)', '**/*.(test|spec).(ts|tsx|js)'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '\\.(jpg|jpeg|png|gif|eot|otf|webp|svg|ttf|woff|woff2)$': 'identity-obj-proxy',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.{ts,tsx}',
  ],
};
```

**Test Setup** (`jest.setup.js`):
```javascript
import 'react-native-gesture-handler/jestSetup';

// Mock React Native modules
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Mock NFC Manager
jest.mock('react-native-nfc-manager', () => ({
  isSupported: jest.fn(() => Promise.resolve(true)),
  isEnabled: jest.fn(() => Promise.resolve(true)),
  registerTagEvent: jest.fn(),
  unregisterTagEvent: jest.fn(),
  setEventListener: jest.fn(),
}));

// Mock native modules
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return {
    ...RN,
    NativeModules: {
      ...RN.NativeModules,
      PrinterModule: {
        printSilently: jest.fn(() => Promise.resolve()),
      },
    },
  };
});
```

## Unit Testing

### Component Testing

**Example: Button Component Test**
```typescript
// __tests__/components/PrimaryButton.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { PrimaryButton } from '../../src/components';

describe('PrimaryButton', () => {
  it('renders correctly with text', () => {
    const { getByText } = render(
      <PrimaryButton btnText="Test Button" onPress={() => {}} />
    );
    
    expect(getByText('Test Button')).toBeTruthy();
  });

  it('calls onPress when pressed', () => {
    const mockOnPress = jest.fn();
    const { getByText } = render(
      <PrimaryButton btnText="Test Button" onPress={mockOnPress} />
    );
    
    fireEvent.press(getByText('Test Button'));
    expect(mockOnPress).toHaveBeenCalledTimes(1);
  });

  it('applies custom styles correctly', () => {
    const customStyle = { backgroundColor: 'red' };
    const { getByTestId } = render(
      <PrimaryButton 
        btnText="Test" 
        onPress={() => {}} 
        btnStyle={customStyle}
        testID="custom-button"
      />
    );
    
    const button = getByTestId('custom-button');
    expect(button).toHaveStyle(customStyle);
  });
});
```

**Example: NumPad Component Test**
```typescript
// __tests__/components/NumPad.test.tsx
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Provider } from 'react-redux';
import { store } from '../../src/store';
import { NumPad } from '../../src/components';

const renderWithRedux = (component: React.ReactElement) => {
  return render(<Provider store={store}>{component}</Provider>);
};

describe('NumPad', () => {
  beforeEach(() => {
    // Reset store state before each test
    store.dispatch({ type: 'amount/clearAmount' });
  });

  it('renders all number buttons', () => {
    const { getByText } = renderWithRedux(<NumPad />);
    
    for (let i = 0; i <= 9; i++) {
      expect(getByText(i.toString())).toBeTruthy();
    }
    expect(getByText('.')).toBeTruthy();
  });

  it('updates amount when numbers are pressed', () => {
    const { getByText } = renderWithRedux(<NumPad />);
    
    fireEvent.press(getByText('1'));
    fireEvent.press(getByText('2'));
    fireEvent.press(getByText('.'));
    fireEvent.press(getByText('5'));
    
    const state = store.getState();
    expect(state.amount.amount).toBe('12.5');
  });

  it('handles backspace correctly', () => {
    const { getByText, getByTestId } = renderWithRedux(<NumPad />);
    
    fireEvent.press(getByText('1'));
    fireEvent.press(getByText('2'));
    fireEvent.press(getByTestId('backspace-button'));
    
    const state = store.getState();
    expect(state.amount.amount).toBe('1');
  });
});
```

### Hook Testing

**Example: useRealtimePrice Hook Test**
```typescript
// __tests__/hooks/useRealtimePrice.test.tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { MockedProvider } from '@apollo/client/testing';
import { Provider } from 'react-redux';
import { useRealtimePrice } from '../../src/hooks';
import { RealtimePrice } from '../../src/graphql/queries';
import { store } from '../../src/store';

const mocks = [
  {
    request: {
      query: RealtimePrice,
      variables: { currency: 'USD' },
    },
    result: {
      data: {
        realtimePrice: {
          timestamp: '2024-01-01T00:00:00Z',
          btcSatPrice: { base: 100000000, offset: 0 },
          usdCentPrice: { base: 4500000, offset: 2 },
          denominatorCurrency: 'USD',
        },
      },
    },
  },
];

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <Provider store={store}>
    <MockedProvider mocks={mocks} addTypename={false}>
      {children}
    </MockedProvider>
  </Provider>
);

describe('useRealtimePrice', () => {
  it('returns converted currency amount', async () => {
    const { result } = renderHook(() => useRealtimePrice(), { wrapper });

    await waitFor(() => {
      expect(result.current.satsToCurrency).toBeDefined();
    });

    const conversion = result.current.satsToCurrency(21);
    expect(conversion.formattedCurrency).toMatch(/\$0\.01/);
  });

  it('handles loading state correctly', () => {
    const { result } = renderHook(() => useRealtimePrice(), { wrapper });
    
    expect(result.current.loading).toBe(true);
  });
});
```

### Redux Testing

**Example: Amount Slice Test**
```typescript
// __tests__/store/amountSlice.test.ts
import { store } from '../../src/store';
import { 
  setAmount, 
  setCurrency, 
  appendDigit, 
  removeLastDigit,
  clearAmount 
} from '../../src/store/slices/amountSlice';

describe('amountSlice', () => {
  beforeEach(() => {
    store.dispatch(clearAmount());
  });

  describe('setAmount', () => {
    it('should set amount correctly', () => {
      store.dispatch(setAmount('10.50'));
      
      const state = store.getState();
      expect(state.amount.amount).toBe('10.50');
    });

    it('should add valid amounts to history', () => {
      store.dispatch(setAmount('10.50'));
      store.dispatch(setAmount('25.00'));
      
      const state = store.getState();
      expect(state.amount.inputHistory).toEqual(['25.00', '10.50']);
    });
  });

  describe('appendDigit', () => {
    it('should append digits correctly', () => {
      store.dispatch(appendDigit('1'));
      store.dispatch(appendDigit('0'));
      
      const state = store.getState();
      expect(state.amount.amount).toBe('10');
    });

    it('should not allow multiple decimal points', () => {
      store.dispatch(appendDigit('1'));
      store.dispatch(appendDigit('.'));
      store.dispatch(appendDigit('.'));
      
      const state = store.getState();
      expect(state.amount.amount).toBe('1.');
    });
  });

  describe('removeLastDigit', () => {
    it('should remove last character', () => {
      store.dispatch(setAmount('123'));
      store.dispatch(removeLastDigit());
      
      const state = store.getState();
      expect(state.amount.amount).toBe('12');
    });
  });
});
```

## Integration Testing

### Screen Integration Tests

**Example: Keypad Screen Integration Test**
```typescript
// __tests__/screens/Keypad.integration.test.tsx
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { Provider } from 'react-redux';
import { MockedProvider } from '@apollo/client/testing';
import { Keypad } from '../../src/screens';
import { store } from '../../src/store';

const renderWithProviders = (component: React.ReactElement) => {
  return render(
    <Provider store={store}>
      <MockedProvider mocks={[]} addTypename={false}>
        <NavigationContainer>
          {component}
        </NavigationContainer>
      </MockedProvider>
    </Provider>
  );
};

describe('Keypad Screen Integration', () => {
  it('should update amount display when numpad is used', async () => {
    const { getByText, getByTestId } = renderWithProviders(<Keypad />);
    
    // Press numbers on numpad
    fireEvent.press(getByText('1'));
    fireEvent.press(getByText('2'));
    fireEvent.press(getByText('.'));
    fireEvent.press(getByText('5'));
    
    // Check amount display updates
    await waitFor(() => {
      expect(getByTestId('amount-display')).toHaveTextContent('12.5');
    });
  });

  it('should show create invoice button when amount is entered', async () => {
    const { getByText, getByTestId } = renderWithProviders(<Keypad />);
    
    fireEvent.press(getByText('1'));
    fireEvent.press(getByText('0'));
    
    await waitFor(() => {
      const createButton = getByTestId('create-invoice-button');
      expect(createButton).toBeTruthy();
      expect(createButton).not.toBeDisabled();
    });
  });
});
```

### NFC Integration Tests

**Example: Flashcard Provider Integration Test**
```typescript
// __tests__/contexts/Flashcard.integration.test.tsx
import React from 'react';
import { render, act } from '@testing-library/react-native';
import { FlashcardProvider, FlashcardContext } from '../../src/contexts/Flashcard';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock component to test context
const TestComponent = () => {
  const { balanceInSats, loading } = React.useContext(FlashcardContext);
  return (
    <>
      <div testID="balance">{balanceInSats || 0}</div>
      <div testID="loading">{loading ? 'loading' : 'ready'}</div>
    </>
  );
};

describe('FlashcardProvider Integration', () => {
  it('should parse balance from HTML response', async () => {
    const mockHtmlResponse = `
      <dt>Balance</dt>
      <dd>1,000 SATS</dd>
    `;
    
    mockedAxios.get.mockResolvedValueOnce({ data: mockHtmlResponse });
    
    const { getByTestId } = render(
      <FlashcardProvider>
        <TestComponent />
      </FlashcardProvider>
    );
    
    // Simulate NFC tag detection
    const mockPayload = 'lnurlw1dp68gurn8ghj7um9dej8xtnrdakj7ctv9eu8j730d3h82unvwqhkwm4z';
    
    await act(async () => {
      // Trigger handleTag function through context
      // This would normally be triggered by NFC event
    });
    
    expect(getByTestId('balance')).toHaveTextContent('1000');
  });
});
```

## E2E Testing: eCash card on the iOS simulator

The card charge, balance and owed-change paths run end to end on an iOS
simulator with no reader and no card (ENG-634). Three local services stand in
for the hardware and the money:

| Piece | What it is | Where |
|---|---|---|
| Card | The real cashu-javacard applet in jCardSim, served over HTTP (`cardsim`) | `lnflash/cashu-javacard` `tools/cardsim`, port 9876 |
| Mint | Nutshell 0.19.2 on FakeWallet: quotes pay themselves, no fees | port 3338 |
| App | A Debug build with the JS bundle embedded, driven by Maestro | `.maestro/flashcard/` |

The app reaches the card through the **card bridge** (`src/services/cardBridge.ts`):
in a dev build, every card APDU can go to cardsim instead of NFC. It is set by
the deep link `flashpos://dev/card-bridge?url=<bridge>` (Maestro opens it) or
by hand on the eCash card bring-up screen (Profile → Settings → Cashu card
(dev) → Card bridge). With the bridge set, a "tap" is implicit: the card
session opens at once. `getCardBridge()` is `null` in every release build, and
the `flashpos://` scheme is registered only in the Debug configuration
(`ios/scripts/register-dev-url-scheme.sh`, a build phase).

### What the flows prove

Every flow logs in on SAT (a sub-cent SAT bill skips the BTCPay invoice and
opens the card charge directly), charges a 3-sat bill against an 8-sat proof
(change 5 = 4 + 1) and, after the UI step, reads the card's own state from
cardsim (`scripts/assert-state.js`): copy on screen can lie about money, slots
cannot.

| Flow | Card | Proves |
|---|---|---|
| `balance-read` | 8, PIN | Card balance shows "8 sats", nothing written |
| `charge-with-change` | 8, PIN | read → PIN → burn → swap → 4 + 1 written; balance "5 sats" |
| `charge-no-pin` | 8 | one tap, no PIN sheet |
| `full-card-refusal` | 8 + 31 spent | refused before the burn ("The card is full"); the 8 stays unspent |
| `owed-change-next-tap` | 8, then full, then 4 | the change LOAD answers 6A84 after the swap; the 5 sats are kept on the terminal and written first on the next charge (4 + 1, then the 4-sat proof pays the bill exactly) |
| `lost-load-answer` | 8, PIN, `dropLoad=1` | a LOAD whose answer is lost lands once, never twice; the balance shows 4 sats + "Change waiting · 1 sat" |

A PIN card whose change write fails after the swap falls back into the PIN
pose, so those two flows read the reason from the PIN sheet's line
(`pin-error-text`), not the error body. They leave the charge with the stack's
edge swipe: on notched iPhones the header's back arrow sits in the status-bar
band, where a tap goes to the system.

`dropLoad=n` makes the bridge forward the n-th LOAD_PROOF and then report the
tag lost: the transport twin of `loseAnswerOnLoad` in
`__tests__/services/cashuCharge.test.ts`.

### Running it locally

```bash
# 1. The card (cashu-javacard checkout at the ref in .github/workflows/e2e-flashcard.yml)
mvn -B -f tools/cardsim/pom.xml package -DskipTests
java -jar tools/cardsim/target/cardsim.jar --port 9876

# 2. The mint (Python 3.10+; the constraints pin Nutshell's own lockfile)
python3 -m venv /tmp/nutshell && /tmp/nutshell/bin/pip install \
  -c scripts/e2e-flashcard/nutshell-constraints.txt cashu==0.19.2
mkdir -p /tmp/mint && cd /tmp/mint && cat > .env <<'ENV'
MINT_LISTEN_PORT=3338
MINT_PRIVATE_KEY=local-e2e-throwaway
MINT_BACKEND_BOLT11_SAT=FakeWallet
MINT_INPUT_FEE_PPK=0
FAKEWALLET_DELAY_INCOMING_PAYMENT=0
FAKEWALLET_DELAY_OUTGOING_PAYMENT=0
ENV
/tmp/nutshell/bin/mint

# 3. The app, against TEST (never production) and the local mint: in .env set
#    FLASH_GRAPHQL_URI=https://api.test.flashapp.me/graphql
#    FLASH_GRAPHQL_WS_URI=wss://ws.test.flashapp.me/graphql
#    FLASH_LN_ADDRESS_URL=https://test.flashapp.me
#    FLASH_LN_ADDRESS=test.flashapp.me
#    FLASH_CASHU_MINT_URL=http://127.0.0.1:3338
cd ios && pod install && cd ..
xcodebuild -workspace ios/flash_pos.xcworkspace -scheme flash_pos \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath ios/build \
  build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
  PROVISIONING_PROFILE_SPECIFIER= FORCE_BUNDLING=1
xcrun simctl install booted "ios/build/Build/Products/Debug-iphonesimulator/Flash POS.app"

# 4. The flows (maestro 2.10.0 on PATH)
yarn e2e:flashcard --username <TEST merchant>             # all six
yarn e2e:flashcard --username <TEST merchant> --flow charge-with-change
yarn e2e:flashcard --dry-run                              # the plan, no network
```

`FORCE_BUNDLING=1` embeds `main.jsbundle` in the Debug build (still `__DEV__`),
so the app needs no Metro. Sign it ad hoc (`CODE_SIGN_IDENTITY=-`), not
`CODE_SIGNING_ALLOWED=NO`: an unsigned build has no keychain entitlement on the
simulator, the owed-change store reads as unreadable ("owed change store
unreadable: Internal error when a required entitlement isn't present") and
every charge fails closed. `yarn ios` with Metro running works too. Pass
`--device <simulator id>` when more than one simulator is booted.

The runner (`scripts/e2e-flashcard.mjs`) mints each flow's proofs P2PK-locked to
the card exactly as the app rebuilds them (`buildCardP2PKSecret`; the
byte-identity is pinned in `__tests__/scripts/e2eLib.test.ts`), resets the
card (its key survives `/reset`, which the runner checks), posts the starting
fixture, and hands later fixtures to the flow (`FIXTURE_FULL`,
`FIXTURE_AFTER`). Cards and their states are in `scripts/e2e-flashcard/lib.cjs`.

### CI

`.github/workflows/e2e-flashcard.yml` runs the same on `macos-15`: on pull
requests that touch the card path, nightly, and on demand. It is not a required
check. It needs the repository variable `FLASH_POS_E2E_USERNAME`, a merchant
username on the TEST instance. The login and the keypad's price fetch call TEST
read-only; after a charge the app's auto-settlement tries an lnurlp sweep to
`<username>@test.flashapp.me` from the local FakeWallet mint (no real payment).
Maestro's output and the cardsim and mint logs are uploaded as the
`e2e-flashcard` artifact.

### Limits

- iOS only. On Android the keypad keeps a card session armed while focused;
  with the bridge's implicit tap that loop would spin, so the bridge is not
  meant for the emulator yet.
- The flows pin customer-facing copy ("The card is full", "Change waiting · 1
  sat — added on the next charge", "The card stopped responding."). A copy change updates the flow in the same
  PR. The `/state` assertions are the durable half.
- The card key is the same after every `/reset`, and the owed-change store is
  keyed by it: every flow starts with `clearState` and `clearKeychain`.

## Mock Implementations

### GraphQL Mocking

**Apollo Client Mocks**:
```typescript
// __tests__/mocks/apolloMocks.ts
export const realtimePriceMock = {
  request: {
    query: RealtimePrice,
    variables: { currency: 'USD' },
  },
  result: {
    data: {
      realtimePrice: {
        timestamp: '2024-01-01T00:00:00Z',
        btcSatPrice: { base: 100000000, offset: 0 },
        usdCentPrice: { base: 4500000, offset: 2 },
        denominatorCurrency: 'USD',
      },
    },
  },
};

export const generateInvoiceMock = {
  request: {
    query: GENERATE_INVOICE_MUTATION,
    variables: { amount: 1000, currency: 'USD' },
  },
  result: {
    data: {
      generateInvoice: {
        id: 'mock-invoice-id',
        paymentRequest: 'lnbc1000n1p...',
        amount: 1000,
        expiresAt: Date.now() + 600000,
      },
    },
  },
};
```

### Native Module Mocking

**NFC Manager Mock**:
```typescript
// __tests__/mocks/nfcMock.ts
export const mockNfcManager = {
  isSupported: jest.fn(() => Promise.resolve(true)),
  isEnabled: jest.fn(() => Promise.resolve(true)),
  registerTagEvent: jest.fn(),
  unregisterTagEvent: jest.fn(),
  setEventListener: jest.fn(),
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
};

// Simulate NFC tag detection
export const simulateNfcTag = (payload: string) => {
  const mockTag = {
    id: 'mock-tag-id',
    ndefMessage: [{
      payload: new TextEncoder().encode(payload),
    }],
  };
  
  // Trigger event listener
  const listener = mockNfcManager.setEventListener.mock.calls
    .find(call => call[0] === 'DiscoverTag')?.[1];
  
  if (listener) {
    listener(mockTag);
  }
};
```

### Printer Module Mock

**Printer Mock Implementation**:
```typescript
// __tests__/mocks/printerMock.ts
export const mockPrinterModule = {
  printSilently: jest.fn((content: string) => {
    console.log('Mock printing:', content);
    return Promise.resolve();
  }),
  checkPrinterStatus: jest.fn(() => Promise.resolve('ready')),
};

// Simulate print failures
export const simulatePrintFailure = (errorCode: string) => {
  mockPrinterModule.printSilently.mockRejectedValueOnce(
    new Error(`Print failed: ${errorCode}`)
  );
};
```

## Test Coverage

### Coverage Configuration

**Jest Coverage Setup**:
```javascript
module.exports = {
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.stories.{ts,tsx}',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
};
```

### Running Coverage

```bash
# Run tests with coverage
yarn test --coverage

# Generate coverage report
yarn test --coverage --watchAll=false

# Open coverage report
open coverage/lcov-report/index.html
```

## Testing Scripts

### Package.json Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage --watchAll=false",
    "test:ci": "jest --ci --coverage --watchAll=false",
    "test:e2e": "detox test",
    "test:e2e:build": "detox build",
    "test:debug": "jest --detectOpenHandles"
  }
}
```

### CI/CD Integration

**GitHub Actions Example**:
```yaml
name: Test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: yarn install
      
      - name: Run tests
        run: yarn test:ci
      
      - name: Upload coverage
        uses: codecov/codecov-action@v1
```

## Best Practices

### 1. Test Organization

```
__tests__/
├── components/         # Component unit tests
├── screens/           # Screen integration tests
├── hooks/            # Custom hook tests
├── store/            # Redux store tests
├── utils/            # Utility function tests
├── mocks/            # Mock implementations
└── setup.ts          # Test configuration
```

### 2. Test Naming

```typescript
describe('ComponentName', () => {
  describe('when prop is provided', () => {
    it('should render correctly', () => {
      // Test implementation
    });
  });
  
  describe('when user interacts', () => {
    it('should call callback function', () => {
      // Test implementation
    });
  });
});
```

### 3. Assertion Patterns

```typescript
// Good: Specific assertions
expect(getByText('Create Invoice')).toBeVisible();
expect(mockFunction).toHaveBeenCalledWith(expectedArgs);

// Avoid: Generic assertions
expect(component).toBeTruthy();
expect(mockFunction).toHaveBeenCalled();
```

### 4. Async Testing

```typescript
// Use waitFor for async operations
await waitFor(() => {
  expect(getByText('Loading complete')).toBeVisible();
});

// Use findBy for elements that appear asynchronously
const asyncElement = await findByText('Dynamic content');
expect(asyncElement).toBeVisible();
```

## Debugging Tests

### Common Issues and Solutions

1. **Mock not working**: Ensure mocks are hoisted and defined before imports
2. **Async timing issues**: Use waitFor and proper async/await patterns
3. **Redux state persistence**: Reset store state between tests
4. **Native module errors**: Verify all native modules are properly mocked

### Debug Commands

```bash
# Run specific test file
yarn test NumPad.test.tsx

# Run tests in watch mode with coverage
yarn test --watch --coverage

# Debug test with Node inspector
node --inspect-brk node_modules/.bin/jest --runInBand
```