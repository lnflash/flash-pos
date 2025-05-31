# Printing System

## Overview

Flash POS implements a sophisticated receipt printing system using native Android and iOS modules. The system supports silent printing (without user dialogs) and generates professional receipts with QR codes for transaction verification.

## Architecture

### Native Module Integration

**Android Implementation**:
- `PrinterModule.java` - Native Android printing logic
- `PrinterPackage.java` - React Native bridge
- `PrinterReceiver.java` - Print job status handling

**iOS Implementation**:
- Similar native module structure for iOS
- Platform-specific printing APIs
- Unified JavaScript interface

**React Native Bridge**:
- `usePrint.tsx` - React hook for printing functionality
- Type-safe interface between JavaScript and native code

## Native Android Implementation

### File Structure

```
android/app/src/main/java/com/flash_pos/printer/
├── PrinterModule.java     # Main printing logic
├── PrinterPackage.java    # React Native package
└── PrinterReceiver.java   # Print status receiver
```

### PrinterModule.java

**Key Features**:
- Silent printing without user dialogs
- PDF generation from HTML content
- Print job status monitoring
- Error handling and callbacks

**Native Methods**:
```java
@ReactModule(name = PrinterModule.NAME)
public class PrinterModule extends ReactContextBaseJavaModule {
  public static final String NAME = "PrinterModule";
  
  @ReactMethod
  public void printSilently(String content, Promise promise) {
    // Implementation for silent receipt printing
    // Converts HTML to PDF and sends to default printer
  }
  
  @ReactMethod
  public void checkPrinterStatus(Promise promise) {
    // Check if printer is available and ready
  }
}
```

### Integration Setup

**MainApplication.kt Registration**:
```kotlin
// Register printer package
override fun getReactNativeHost(): ReactNativeHost {
  return object : ReactNativeHost(this) {
    override fun getPackages(): List<ReactPackage> {
      return Arrays.asList<ReactPackage>(
        MainReactPackage(),
        PrinterPackage()  // Register printer package
      )
    }
  }
}
```

## React Native Hook Implementation

### File: `src/hooks/usePrint.tsx`

**Purpose**: Provides JavaScript interface for native printing functionality

**Hook Structure**:
```typescript
export const usePrint = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const printReceipt = useCallback(async (receiptData: ReceiptData) => {
    setIsLoading(true);
    setError(null);

    try {
      // Generate HTML receipt content
      const htmlContent = generateReceiptHTML(receiptData);
      
      // Call native printing module
      await NativeModules.PrinterModule.printSilently(htmlContent);
      
      // Success handling
      toastShow({
        message: 'Receipt printed successfully',
        type: 'success',
      });
    } catch (err) {
      setError(err.message);
      toastShow({
        message: 'Printing failed. Please try again.',
        type: 'error',
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    printReceipt,
    isLoading,
    error,
  };
};
```

## Receipt Generation

### HTML Template Structure

**Receipt Layout**:
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: monospace; width: 80mm; margin: 0; padding: 10px; }
    .header { text-align: center; font-weight: bold; }
    .qr-code { text-align: center; margin: 20px 0; }
    .transaction-details { margin: 15px 0; }
    .footer { text-align: center; font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="header">
    <h2>Flash POS</h2>
    <p>Payment Receipt</p>
  </div>
  
  <div class="transaction-details">
    <p>Date: ${timestamp}</p>
    <p>Amount: ${amount} ${currency}</p>
    <p>Sats: ${satoshiAmount}</p>
    <p>Invoice: ${invoiceId}</p>
  </div>
  
  <div class="qr-code">
    <img src="${qrCodeDataURL}" alt="Payment QR Code" />
  </div>
  
  <div class="footer">
    <p>Thank you for your payment!</p>
    <p>Powered by Lightning Network</p>
  </div>
</body>
</html>
```

### QR Code Integration

**QR Code Generation**:
```typescript
import QRCode from 'react-native-qrcode-svg';

const generateQRCodeDataURL = (data: string): Promise<string> => {
  return new Promise((resolve) => {
    QRCode.toDataURL(data, {
      size: 150,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    }, (dataURL) => {
      resolve(dataURL);
    });
  });
};
```

### Receipt Data Structure

**ReceiptData Interface**:
```typescript
interface ReceiptData {
  timestamp: string;           // Transaction timestamp
  amount: string;             // Payment amount in fiat
  currency: string;           // Display currency code
  satoshiAmount: number;      // Payment amount in satoshis
  invoiceId: string;          // Lightning invoice ID
  paymentHash?: string;       // Payment hash for verification
  merchantName: string;       // Merchant display name
  qrCodeData: string;         // Data for QR code generation
}
```

## Integration with Payment Flow

### Success Screen Integration

**File**: `src/screens/Success.tsx`

```typescript
const Success: React.FC<Props> = ({route}) => {
  const {printReceipt, isLoading: isPrinting} = usePrint();
  const paymentData = route.params;

  const handlePrintReceipt = async () => {
    const receiptData: ReceiptData = {
      timestamp: new Date().toISOString(),
      amount: paymentData.amount,
      currency: paymentData.currency,
      satoshiAmount: paymentData.satoshiAmount,
      invoiceId: paymentData.invoiceId,
      merchantName: paymentData.merchantName,
      qrCodeData: paymentData.invoiceId, // Use invoice ID for QR code
    };

    await printReceipt(receiptData);
  };

  return (
    <View>
      {/* Success screen content */}
      
      <PrimaryButton
        btnText={isPrinting ? "Printing..." : "Print Receipt"}
        onPress={handlePrintReceipt}
        disabled={isPrinting}
      />
    </View>
  );
};
```

### Automatic Printing

**Silent Print After Payment**:
```typescript
// Automatically print receipt after successful payment
useEffect(() => {
  if (paymentStatus === 'completed' && autoprint) {
    handlePrintReceipt();
  }
}, [paymentStatus, autoprint]);
```

## Error Handling

### Native Module Errors

**Common Error Scenarios**:
1. **No Printer Available**: Device doesn't have a configured printer
2. **Printer Offline**: Default printer is not responding
3. **Paper Out**: Printer is out of paper
4. **Permission Denied**: App lacks printing permissions

**Error Handling Pattern**:
```typescript
try {
  await NativeModules.PrinterModule.printSilently(htmlContent);
} catch (error) {
  let userMessage = 'Printing failed. Please try again.';
  
  switch (error.code) {
    case 'NO_PRINTER':
      userMessage = 'No printer found. Please configure a printer.';
      break;
    case 'PRINTER_OFFLINE':
      userMessage = 'Printer is offline. Please check connection.';
      break;
    case 'PERMISSION_DENIED':
      userMessage = 'Printing permission required. Please check settings.';
      break;
    default:
      console.error('Printing error:', error);
  }
  
  toastShow({
    message: userMessage,
    type: 'error',
  });
}
```

### Fallback Strategies

**Alternative Print Methods**:
```typescript
const printWithFallback = async (receiptData: ReceiptData) => {
  try {
    // Try silent printing first
    await NativeModules.PrinterModule.printSilently(htmlContent);
  } catch (error) {
    if (error.code === 'NO_PRINTER') {
      // Fallback to system print dialog
      await RNPrint.print({
        html: htmlContent,
        printerURL: undefined, // Let user choose printer
      });
    } else {
      throw error; // Re-throw other errors
    }
  }
};
```

## Configuration and Customization

### Environment Variables

**Printing Configuration**:
```bash
# Print settings (if needed)
AUTO_PRINT_RECEIPTS=true
DEFAULT_PRINTER_NAME=your-printer-name
RECEIPT_HEADER_TEXT=Flash POS
```

### Printer Settings

**Android Manifest Permissions**:
```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
<!-- Add printing-related permissions as needed -->
```

### Receipt Customization

**Styling Options**:
```typescript
interface ReceiptStyle {
  fontFamily: string;      // Receipt font family
  fontSize: string;        // Base font size
  width: string;          // Receipt width (e.g., '80mm')
  logoUrl?: string;       // Merchant logo URL
  headerText: string;     // Receipt header text
  footerText: string;     // Receipt footer text
}
```

## Testing and Debugging

### Development Testing

**Mock Printing for Testing**:
```typescript
const mockPrintReceipt = async (receiptData: ReceiptData) => {
  if (__DEV__) {
    console.log('Mock printing receipt:', receiptData);
    // Simulate printing delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    return;
  }
  
  // Real printing logic
  await printReceipt(receiptData);
};
```

### Print Preview

**Development Print Preview**:
```typescript
const showPrintPreview = (htmlContent: string) => {
  if (__DEV__) {
    // Show HTML content in WebView for debugging
    console.log('Receipt HTML:', htmlContent);
  }
};
```

### Logging

**Print Job Logging**:
```typescript
const logPrintAttempt = (receiptData: ReceiptData, success: boolean) => {
  console.log('Print attempt:', {
    timestamp: new Date().toISOString(),
    invoiceId: receiptData.invoiceId,
    success,
    printerStatus: 'available', // Get from native module
  });
};
```

## Performance Considerations

### HTML Generation Optimization

**Template Caching**:
```typescript
const receiptTemplateCache = new Map<string, string>();

const generateOptimizedReceipt = (data: ReceiptData): string => {
  const cacheKey = `${data.currency}_${data.merchantName}`;
  
  if (!receiptTemplateCache.has(cacheKey)) {
    const template = generateReceiptTemplate(data);
    receiptTemplateCache.set(cacheKey, template);
  }
  
  return populateTemplate(receiptTemplateCache.get(cacheKey), data);
};
```

### Memory Management

**Large Receipt Handling**:
```typescript
const printLargeReceipt = async (receiptData: ReceiptData) => {
  try {
    const htmlContent = generateReceiptHTML(receiptData);
    
    // Clear any previous print jobs
    await NativeModules.PrinterModule.clearPrintQueue();
    
    // Print current receipt
    await NativeModules.PrinterModule.printSilently(htmlContent);
    
  } finally {
    // Clean up resources
    receiptTemplateCache.clear();
  }
};
```

## Security Considerations

### Data Privacy

**Sensitive Information Handling**:
```typescript
const sanitizeReceiptData = (data: ReceiptData): ReceiptData => {
  return {
    ...data,
    // Remove or mask sensitive information
    paymentHash: data.paymentHash ? 
      data.paymentHash.substring(0, 8) + '...' : undefined,
  };
};
```

### Print Content Validation

**HTML Sanitization**:
```typescript
import DOMPurify from 'isomorphic-dompurify';

const sanitizeHTML = (html: string): string => {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['div', 'p', 'h1', 'h2', 'h3', 'img', 'br'],
    ALLOWED_ATTR: ['src', 'alt', 'class'],
  });
};
```

## Receipt Reprinting System

### Overview

The app now supports reprinting receipts for completed transactions. This feature allows merchants to reprint the last transaction receipt or any previous transaction from the current session.

### Reprint from Success Screen

**Success Screen Integration** (`src/screens/Success.tsx:115-122`):
```typescript
<SecondaryButton
  icon="refresh"
  btnText="Reprint"
  iconColor="#fff"
  textStyle={{color: '#fff'}}
  btnStyle={{borderColor: '#fff', marginTop: 10}}
  onPress={onReprintReceipt}
/>
```

**Last Transaction Reprint Logic**:
```typescript
const onReprintReceipt = () => {
  if (lastTransaction) {
    const receiptData: ReceiptData = {
      id: lastTransaction.id,
      timestamp: lastTransaction.timestamp,
      satAmount: lastTransaction.amount.satAmount,
      displayAmount: lastTransaction.amount.displayAmount,
      currency: lastTransaction.amount.currency,
      isPrimaryAmountSats: lastTransaction.amount.isPrimaryAmountSats,
      username: lastTransaction.merchant.username,
      memo: lastTransaction.memo,
      paymentHash: lastTransaction.invoice.paymentHash,
      status: lastTransaction.status,
    };
    
    printReceipt(receiptData);
  }
};
```

### Transaction History Screen

**File**: `src/screens/TransactionHistory.tsx`

**Features**:
- View all completed transactions from current session
- Reprint receipt for any individual transaction
- Clear transaction history
- Formatted transaction details with timestamps

**Individual Transaction Reprint**:
```typescript
const onReprintTransaction = (transaction: TransactionData) => {
  const receiptData: ReceiptData = {
    id: transaction.id,
    timestamp: transaction.timestamp,
    satAmount: transaction.amount.satAmount,
    displayAmount: transaction.amount.displayAmount,
    currency: transaction.amount.currency,
    isPrimaryAmountSats: transaction.amount.isPrimaryAmountSats,
    username: transaction.merchant.username,
    memo: transaction.memo,
    paymentHash: transaction.invoice.paymentHash,
    status: transaction.status,
  };
  
  printReceipt(receiptData);
};
```

### Transaction Data Storage

**Redux Store Integration** (`src/store/slices/transactionHistorySlice.ts`):
```typescript
interface TransactionHistoryState {
  transactions: TransactionData[];
  lastTransaction?: TransactionData;
  maxTransactions: number; // Default: 50
}
```

**Automatic Transaction Recording**:
- Transactions automatically stored on Success screen mount
- Includes complete payment details, timestamps, and merchant info
- Persisted to AsyncStorage for session continuity
- Limited to 50 recent transactions for performance

### Enhanced Print Functions

**Updated usePrint Hook** (`src/hooks/usePrint.tsx`):

**Receipt Data Interface**:
```typescript
interface ReceiptData {
  id: string;
  timestamp: string;
  satAmount: number;
  displayAmount: string;
  currency: CurrencyItem;
  isPrimaryAmountSats: boolean;
  username: string;
  memo?: string;
  paymentHash: string;
  status: string;
}
```

**Reprint Functions**:
```typescript
const printReceipt = (receiptData: ReceiptData) => {
  // Silent printing with stored transaction data
  PrinterModule.setAlignment(1);
  PrinterModule.setTextBold(true);
  PrinterModule.printText(`Sale completed\n`);
  PrinterModule.printText(`${receiptData.currency.symbol} ${receiptData.displayAmount}\n`);
  // ... rest of receipt formatting
};

const printReceiptHTML = async (receiptData: ReceiptData) => {
  // HTML-based printing for system print dialog
  await RNPrint.print({
    html: generateReceiptHTML(receiptData),
  });
};
```

### Access Points

**1. Success Screen**:
- "Reprint" button immediately available after payment
- Reprints the current transaction receipt

**2. Profile Screen**:
- "Transaction History" option shows transaction count
- Navigates to full transaction history

**3. Transaction History Screen**:
- Individual reprint buttons for each transaction
- "Clear History" option to reset transaction list

### Navigation Integration

**Route Configuration** (`src/types/routes.d.ts`):
```typescript
type RootStackType = {
  // ... existing routes
  TransactionHistory: undefined;
};
```

**Navigation Setup** (`src/routes/index.tsx:68-75`):
```typescript
<Stack.Screen
  name="TransactionHistory"
  component={TransactionHistory}
  options={{
    headerShown: false,
    animation: 'slide_from_right',
  }}
/>
```

## Future Enhancements

### 1. Advanced Printer Support

- **Network Printers**: Support for Wi-Fi and Bluetooth printers
- **Thermal Printers**: Direct integration with thermal receipt printers
- **Multi-printer Support**: Allow selection of specific printers

### 2. Receipt Templates

- **Template Engine**: Advanced template system with variables
- **Merchant Branding**: Custom logos and styling per merchant
- **Multi-language Support**: Localized receipt templates

### 3. Enhanced Print Management

- **Print Queue**: Queue multiple print jobs
- **Print History**: Track printed receipts beyond current session
- **Email Receipts**: Send receipts via email
- **SMS Receipts**: Send receipt summaries via SMS

### 4. Transaction Management

- **Export Transactions**: Export transaction history to CSV/JSON
- **Search & Filter**: Search transactions by amount, date, or memo
- **Transaction Categories**: Organize transactions by type or category
- **Bulk Operations**: Bulk reprint or export multiple transactions

### 5. Analytics

- **Print Success Rates**: Monitor printing reliability
- **Usage Analytics**: Track printing frequency and patterns
- **Cost Analysis**: Estimate printing costs and supplies usage
- **Reprint Statistics**: Track most reprinted transactions