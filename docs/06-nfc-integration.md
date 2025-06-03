# NFC Integration

## Overview

Flash POS provides comprehensive NFC (Near Field Communication) integration for flashcard payments and balance management. The NFC system enables seamless customer interactions without requiring app downloads or complex setup.

## NFC Architecture

### Core Components

**Main NFC Provider**: `src/contexts/Flashcard.tsx`
- Centralized NFC state management
- Hardware initialization and error handling
- Tag detection and processing
- LNURL protocol integration

**NFC Hook**: `src/hooks/useNfc.tsx`
- React hook interface for NFC functionality
- Component-level NFC state access

**NFC Manager**: `react-native-nfc-manager@3.16.1`
- Cross-platform NFC hardware interface
- Tag event handling
- Session management

## NFC Hardware Setup

### Initialization Process

**File**: `src/contexts/Flashcard.tsx:56-77`

```typescript
const checkNfc = async () => {
  const isSupported = await NfcManager.isSupported();
  const isEnabled = await NfcManager.isEnabled();

  if (!isSupported) {
    toastShow({
      message: 'NFC is not supported on this device',
      type: 'error',
    });
  } else if (!isEnabled) {
    toastShow({
      message: 'NFC is not enabled on this device.',
      type: 'error',
    });
  } else {
    // NFC IS ENABLED AND SUPPORTED
  }
};
```

### Event Listeners

**Tag Detection Setup**:
```typescript
// Register for tag detection events
NfcManager.setEventListener(NfcEvents.DiscoverTag, (tag: TagEvent) => {
  handleTag(tag);
});

// Handle session closure
NfcManager.setEventListener(NfcEvents.SessionClosed, () => {
  NfcManager.cancelTechnologyRequest();
  NfcManager.unregisterTagEvent();
});

// Start listening for tags
NfcManager.registerTagEvent();
```

## Flashcard Processing

### Tag Data Structure

**NFC Tag Event**:
```typescript
interface TagEvent {
  id: string;                    // Unique tag identifier
  ndefMessage?: NDEFMessage[];   // NDEF data payload
  // Additional platform-specific properties
}

interface NDEFMessage {
  payload: number[];             // Raw payload data
  type: number[];               // NDEF record type
  // Additional NDEF properties
}
```

### Tag Processing Flow

**File**: `src/contexts/Flashcard.tsx:79-104`

```typescript
const handleTag = async (tag: TagEvent) => {
  const currentScreen = navigationRef.getCurrentRoute()?.name;
  
  if (tag && tag.id) {
    const ndefRecord = tag?.ndefMessage?.[0];
    
    if (!ndefRecord) {
      toastShow({message: 'NDEF message not found.', type: 'error'});
      return;
    }

    setLoading(true);
    
    // Decode NDEF payload to text
    const payload = Ndef.text.decodePayload(
      new Uint8Array(ndefRecord.payload),
    );
    
    if (payload.startsWith('lnurlw')) {
      setTag(tag);
      
      // Route based on current screen
      if (currentScreen === 'Invoice') {
        await getPayDetails(payload);  // Payment flow
      } else {
        await getHtml(payload, currentScreen);  // Balance/info flow
      }
    }
    
    setLoading(false);
  }
};
```

## Screen-Specific NFC Behavior

### 1. Invoice Screen Behavior

When a flashcard is tapped on the Invoice screen, the app extracts payment details:

**File**: `src/contexts/Flashcard.tsx:106-132`

```typescript
const getPayDetails = async (payload: string) => {
  try {
    const lnurlParams = await getParams(payload);
    
    if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
      const {k1, callback} = lnurlParams;
      
      console.log('K1>>>>>>>>>>>>>>', k1);
      console.log('CALLBACK>>>>>>>>>>>>>', callback);
      
      setK1(k1);
      setCallback(callback);
    } else {
      toastShow({
        message: `not a properly configured lnurl withdraw tag\n\n${payload}`,
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

### 2. General Screen Behavior

For non-Invoice screens, flashcard tap shows balance and navigates to balance screen:

**File**: `src/contexts/Flashcard.tsx:134-156`

```typescript
const getHtml = async (payload: string, currentScreen?: string) => {
  try {
    const payloadPart = payload.split('?')[1];
    const url = `${BTC_PAY_SERVER}/boltcards/balance?${payloadPart}`;
    const response = await axios.get(url);
    const html = response.data;

    // Extract data from HTML response
    getLnurl(html);
    getBalance(html);
    getTransactions(html);

    // Navigate to balance screen (except when on Rewards screen)
    if (currentScreen !== 'Rewards' && navigationRef.isReady()) {
      navigationRef.navigate('FlashcardBalance');
    }
  } catch (err) {
    toastShow({
      message: 'Unsupported NFC card. Please ensure you are using a flashcard.',
      type: 'error',
    });
  }
};
```

### 3. Rewards Screen Behavior

On the Rewards screen, flashcard tap triggers automatic reward processing:

**File**: `src/screens/Rewards.tsx:36-41`

```typescript
useFocusEffect(
  useCallback(() => {
    if (loading || !lnurl) return;
    onReward();  // Automatic reward processing
  }, [loading, lnurl]),
);
```

## Data Extraction and Parsing

### LNURL Extraction

**File**: `src/contexts/Flashcard.tsx:158-164`

```typescript
const getLnurl = (html: string) => {
  const lnurlMatch = html.match(/href="lightning:(lnurl\w+)"/);
  if (lnurlMatch) {
    console.log('LNURL MATCH>>>>>>>>>>', lnurlMatch[1]);
    setLnurl(lnurlMatch[1]);
  }
};
```

### Balance Parsing

**File**: `src/contexts/Flashcard.tsx:166-175`

```typescript
const getBalance = (html: string) => {
  const balanceMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*SATS<\/dt>/);
  if (balanceMatch) {
    const parsedBalance = balanceMatch[1].replace(/,/g, ''); // Remove commas
    const satoshiAmount = parseInt(parsedBalance, 10);
    
    console.log('SATOSHI AMOUNT>>>>>>>>>>>>>>>', satoshiAmount);
    setBalanceInSats(satoshiAmount);
  }
};
```

### Transaction History Parsing

**File**: `src/contexts/Flashcard.tsx:177-189`

```typescript
const getTransactions = (html: string) => {
  // Extract dates and SATS amounts using regex
  const transactionMatches = [
    ...html.matchAll(
      /<time datetime="(.*?)".*?>.*?<\/time>\s*<\/td>\s*<td.*?>\s*<span.*?>(-?\d{1,3}(,\d{3})*) SATS<\/span>/g,
    ),
  ];
  
  const data = transactionMatches.map(match => ({
    date: match[1],     // ISO datetime
    sats: match[2],     // SATS amount with commas
  }));
  
  setTransactions(data);
};
```

## NFC State Management

### Flashcard Context State

```typescript
interface FlashcardInterface {
  tag?: TagEvent;              // Raw NFC tag data
  k1?: string;                 // LNURL k1 parameter
  callback?: string;           // LNURL callback URL
  lnurl?: string;              // Extracted LNURL
  balanceInSats?: number;      // Flashcard balance
  transactions?: TransactionList; // Transaction history
  loading?: boolean;           // Loading state
  error?: string;              // Error state
  resetFlashcard: () => void;  // State reset function
}
```

### State Reset Function

**File**: `src/contexts/Flashcard.tsx:191-200`

```typescript
const resetFlashcard = () => {
  setTag(undefined);
  setK1(undefined);
  setCallback(undefined);
  setLnurl(undefined);
  setBalanceInSats(undefined);
  setTransactions(undefined);
  setLoading(undefined);
  setError(undefined);
};
```

## LNURL Protocol Integration

### LNURL-Withdraw Support

Flash POS supports the LNURL-withdraw protocol for flashcard payments:

**Protocol Flow**:
1. NFC tag contains LNURLW URL
2. App decodes and validates LNURL
3. Extracts withdrawal parameters (k1, callback)
4. Processes withdrawal request
5. Updates flashcard balance

**Library**: `js-lnurl@0.6.0`

```typescript
import {getParams} from 'js-lnurl';

const lnurlParams = await getParams(payload);
if ('tag' in lnurlParams && lnurlParams.tag === 'withdrawRequest') {
  // Valid LNURL-withdraw request
  const {k1, callback} = lnurlParams;
}
```

## Error Handling

### NFC Hardware Errors

```typescript
// Device capability checks
if (!isSupported) {
  toastShow({
    message: 'NFC is not supported on this device',
    type: 'error',
  });
}

if (!isEnabled) {
  toastShow({
    message: 'NFC is not enabled on this device.',
    type: 'error',
  });
}
```

### Tag Processing Errors

```typescript
// Invalid NDEF data
if (!ndefRecord) {
  toastShow({message: 'NDEF message not found.', type: 'error'});
}

// Unsupported tag format
if (!payload.startsWith('lnurlw')) {
  toastShow({message: 'Unsupported tag format', type: 'error'});
}

// Network errors
catch (err) {
  toastShow({
    message: 'Unsupported NFC card. Please ensure you are using a flashcard.',
    type: 'error',
  });
}
```

## Platform-Specific Considerations

### Android NFC

- **Permissions**: NFC permission declared in AndroidManifest.xml
- **Intent Filters**: NFC intent handling for app launching
- **Background Reading**: NFC reading when app is backgrounded

### iOS NFC

- **Core NFC Framework**: iOS 11+ requirement
- **App Foreground**: NFC reading requires app to be in foreground
- **User Prompt**: iOS shows system NFC scanning prompt

## Security Considerations

### 1. Data Validation

```typescript
// Validate LNURL format
if (payload.startsWith('lnurlw')) {
  // Process valid LNURL
} else {
  // Reject invalid format
}
```

### 2. Network Security

- **HTTPS Only**: All API calls use HTTPS
- **Parameter Validation**: Server-side validation of LNURL parameters
- **Rate Limiting**: Protection against abuse

### 3. Error Information

```typescript
// Avoid exposing sensitive information in errors
toastShow({
  message: 'Unsupported NFC card. Please ensure you are using a flashcard.',
  type: 'error',
});
```

## Testing NFC Integration

### 1. Physical Testing

- **Real NFC Cards**: Test with actual flashcards
- **Multiple Devices**: Test across different Android/iOS devices
- **Edge Cases**: Test with damaged or improperly formatted cards

### 2. Mock Testing

```typescript
// Mock NFC events for testing
const mockTagEvent: TagEvent = {
  id: 'mock-tag-id',
  ndefMessage: [{
    payload: Ndef.text.encodePayload('lnurlw1234567890'),
  }],
};

// Trigger mock event
handleTag(mockTagEvent);
```

### 3. Error Scenario Testing

- **No NFC Hardware**: Test on devices without NFC
- **NFC Disabled**: Test when NFC is turned off
- **Network Failures**: Test API failure scenarios
- **Invalid Cards**: Test with non-flashcard NFC tags

## Performance Optimization

### 1. Event Debouncing

```typescript
// Prevent multiple rapid tag detections
let lastTagTime = 0;
const handleTag = async (tag: TagEvent) => {
  const now = Date.now();
  if (now - lastTagTime < 1000) return; // 1 second debounce
  lastTagTime = now;
  
  // Process tag
};
```

### 2. Memory Management

```typescript
// Clean up NFC resources
useEffect(() => {
  return () => {
    NfcManager.cancelTechnologyRequest();
    NfcManager.unregisterTagEvent();
  };
}, []);
```

### 3. Loading States

```typescript
// Show loading during NFC processing
{loading && <ActivityIndicator />}
```

## Future Enhancements

### 1. Multi-Card Support
- Support for multiple flashcard types
- Card-specific processing logic
- Enhanced card validation

### 2. Advanced LNURL Features
- LNURL-pay support
- LNURL-channel integration
- Extended protocol features

### 3. Offline Capabilities
- Offline balance caching
- Queue pending transactions
- Sync when connection restored