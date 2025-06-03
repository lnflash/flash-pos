# Screens & Navigation

## Navigation Structure

Flash POS uses React Navigation v7 with a hybrid stack and tab navigation structure. The navigation is fully type-safe with TypeScript route definitions.

### Navigation Hierarchy

```
Root Stack Navigator
├── Auth Screen (No header)
├── Home Tab Navigator (Custom header)
│   ├── Keypad Tab (POS functionality)
│   ├── Rewards Tab (Customer rewards)
│   ├── Paycode Tab (Merchant QR codes)
│   └── Profile Tab (Settings)
├── Invoice Screen (Modal presentation)
├── Success Screen (Payment confirmation)
├── FlashcardBalance Screen (NFC card details)
└── RewardsSuccess Screen (Reward confirmation)
```

## Screen Documentation

### 1. Auth Screen

**File**: `src/screens/Auth.tsx`  
**Route**: `/Auth`  
**Header**: Hidden

**Purpose**: User authentication and initial setup

**Key Features**:
- Username input and validation
- Initial app setup
- Navigation to main app after authentication

**State Dependencies**:
- `userSlice.username` - Stores authenticated username

**Navigation Logic**:
```typescript
// In routes/index.tsx:25-26
const initialRouteName = username ? 'Home' : 'Auth';
```

### 2. Keypad Screen (POS)

**File**: `src/screens/Keypad.tsx`  
**Route**: `/Home/Keypad` (Tab 1)  
**Icon**: `apps-outline` / `apps`

**Purpose**: Main point-of-sale interface for payment amount entry

**Key Components**:
- `Amount` component - Display entered amount
- `NumPad` component - Number input interface
- Currency selection and conversion
- "Create Invoice" button

**State Dependencies**:
- `amountSlice.amount` - Current payment amount
- `amountSlice.currency` - Selected display currency

**User Flow**:
1. Merchant enters payment amount using numpad
2. Amount displays in both Bitcoin and fiat currency
3. Tap "Create Invoice" to generate Lightning invoice
4. Navigate to Invoice screen

**Key Features**:
- Real-time currency conversion
- Input validation
- Clear/backspace functionality
- Professional POS interface

### 3. Rewards Screen

**File**: `src/screens/Rewards.tsx`  
**Route**: `/Home/Rewards` (Tab 2)  
**Icon**: `diamond-outline` / `diamond`  
**Header**: Hidden

**Purpose**: Customer loyalty rewards via NFC flashcard

**Key Features**:
- Animated POS icon (pulse animation)
- Fixed 21 sats reward amount
- Automatic rewards on flashcard tap
- BTCPay Server integration

**State Dependencies**:
- `FlashcardContext` - NFC card state and balance

**User Flow**:
1. Customer views reward information (21 sats)
2. Customer taps NFC flashcard
3. Automatic reward processing
4. Navigate to RewardsSuccess screen

**NFC Integration**:
- Automatic detection when screen is active
- LNURL processing for flashcard
- Balance updates via BTCPay Server

### 4. Paycode Screen

**File**: `src/screens/Paycode.tsx`  
**Route**: `/Home/Paycode` (Tab 3)  
**Icon**: `qr-code-outline` / `qr-code`  
**Header**: Hidden

**Purpose**: Static merchant QR code for customer payments

**Key Features**:
- Merchant-specific QR code generation
- Static payment code display
- Customer scanning interface

### 5. Profile Screen

**File**: `src/screens/Profile.tsx`  
**Route**: `/Home/Profile` (Tab 4)  
**Icon**: `cog-outline` / `cog`  
**Header**: Hidden

**Purpose**: Merchant settings and configuration

**Key Features**:
- Merchant profile management
- App settings and configuration
- Account information display

### 6. Invoice Screen

**File**: `src/screens/Invoice.tsx`  
**Route**: `/Invoice` (Modal)  
**Header**: Standard navigation header

**Purpose**: Lightning invoice display and payment processing

**Key Components**:
- `InvoiceQRCode` - QR code display for payment
- `ExpireTime` - Invoice expiration countdown
- Payment amount display
- Payment status monitoring

**Key Features**:
- Lightning invoice QR code
- Real-time payment status updates
- Invoice expiration handling
- Payment confirmation

**Navigation Triggers**:
- From Keypad screen via "Create Invoice"
- NFC flashcard tap on Invoice screen triggers payment flow

### 7. Success Screen

**File**: `src/screens/Success.tsx`  
**Route**: `/Success` (Modal)  
**Header**: Standard navigation header

**Purpose**: Payment confirmation and receipt options

**Key Features**:
- Payment success confirmation
- Receipt generation and printing
- Transaction details display
- Return to home navigation

**State Dependencies**:
- Payment details from previous screen
- Printer integration for receipts

### 8. FlashcardBalance Screen

**File**: `src/screens/FlashcardBalance.tsx`  
**Route**: `/FlashcardBalance` (Modal)  
**Header**: Standard navigation header

**Purpose**: NFC flashcard balance and transaction history

**Key Components**:
- `RecentActivity` - Transaction history display
- Balance display in multiple currencies
- Flashcard information

**Key Features**:
- Real-time balance display
- Transaction history
- Multi-currency conversion
- NFC card details

**State Dependencies**:
- `FlashcardContext` - Complete flashcard state

### 9. RewardsSuccess Screen

**File**: `src/screens/RewardsSuccess.tsx`  
**Route**: `/RewardsSuccess` (Modal)  
**Header**: Standard navigation header

**Purpose**: Reward confirmation after successful flashcard tap

**Key Features**:
- Reward amount confirmation (21 sats)
- Updated balance display
- Success animation/indication
- Return to home navigation

**Navigation Parameters**:
```typescript
type RewardsSuccessParams = {
  rewardSatAmount: number;
  balance: string;
};
```

## Navigation Configuration

### Tab Bar Configuration

**File**: `src/routes/HomeTabs.tsx:22-27`

```typescript
const tabs = [
  {label: 'POS', icon: 'apps-outline', iconActive: 'apps'},
  {label: 'Rewards', icon: 'diamond-outline', iconActive: 'diamond'},
  {label: 'Paycode', icon: 'qr-code-outline', iconActive: 'qr-code'},
  {label: 'Profile', icon: 'cog-outline', iconActive: 'cog'},
];
```

**Custom Tab Bar Features**:
- Custom styled tab bar with rounded corners
- Active/inactive icon states
- Background image overlay
- Professional appearance

### Header Configuration

**Standard Header** (`src/routes/index.tsx:32-36`):
```typescript
screenOptions={{
  headerShadowVisible: false,
  headerTitle: `Pay to ${username}`,
  headerTitleStyle: {fontFamily: 'Outfit-Bold'},
  headerTitleAlign: 'center',
}}
```

**Dynamic Header Title**: Shows "Pay to [username]" with merchant name

## Navigation Patterns

### 1. Modal Presentations
- Invoice, Success, FlashcardBalance, RewardsSuccess screens
- Full-screen modal style
- Standard navigation headers with back buttons

### 2. Tab Navigation
- Main app functionality in tabs
- Persistent tab state
- Custom tab bar styling

### 3. Conditional Navigation
```typescript
// Auth flow logic
const initialRouteName = username ? 'Home' : 'Auth';
```

### 4. Programmatic Navigation
```typescript
// From NFC detection
if (currentScreen !== 'Rewards' && navigationRef.isReady()) {
  navigationRef.navigate('FlashcardBalance');
}
```

## Navigation State Management

### 1. Navigation Reference
```typescript
// Global navigation reference
export const navigationRef = createNavigationContainerRef<RootStackType>();
```

### 2. Navigation Context
- Used in `FlashcardProvider` for programmatic navigation
- Enables NFC-triggered navigation from context

### 3. Route Parameters
- Type-safe route parameters with TypeScript
- Parameter validation and passing between screens

## User Experience Patterns

### 1. Progressive Flow
1. **Auth** → **Keypad** → **Invoice** → **Success**
2. **Rewards** → **RewardsSuccess** → **Home**
3. **NFC Detection** → **FlashcardBalance**

### 2. Tab Persistence
- Tab state maintained across navigation
- Quick access to main functionality
- Visual feedback for active tabs

### 3. Modal Interruptions
- Payment flows as modal overlays
- Preserve tab context underneath
- Easy return to main navigation

### 4. NFC-Triggered Navigation
- Automatic screen changes based on NFC detection
- Context-aware navigation (different behavior per screen)
- Seamless user experience

## Accessibility Features

### 1. Navigation Labels
- Proper accessibility labels for all navigation elements
- Screen reader support
- Tab button accessibility

### 2. Focus Management
- Proper focus handling on screen transitions
- Keyboard navigation support
- Focus indicators

## Performance Considerations

### 1. Lazy Loading
- Screens loaded on-demand
- Optimized bundle sizes
- Fast initial app load

### 2. Navigation Optimization
- Efficient tab switching
- Minimal re-renders on navigation
- Optimized animation performance

### 3. Memory Management
- Proper screen cleanup
- State persistence only when needed
- Efficient component lifecycle management