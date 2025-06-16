# Rewards System

## Overview

Flash POS implements a customer loyalty rewards system that automatically distributes Bitcoin rewards when customers tap their NFC flashcards. The system integrates with BTCPay Server's pull payment functionality to provide seamless, automated rewards.

## System Architecture

### Core Components

1. **Rewards Screen** (`src/screens/Rewards.tsx`) - Customer-facing reward interface
2. **RewardsSuccess Screen** (`src/screens/RewardsSuccess.tsx`) - Reward confirmation
3. **BTCPay Server Integration** - Backend reward processing
4. **NFC Integration** - Automatic reward triggering via flashcards
5. **FlashcardProvider** - State management for NFC interactions

### Data Flow

```
Customer Taps Flashcard → NFC Detection → LNURL Extraction → 
BTCPay API Call → Reward Distribution → Success Display
```

## Rewards Screen Implementation

### File: `src/screens/Rewards.tsx`

**Purpose**: Displays reward information and handles automatic reward processing

**Key Features**:
- Fixed 21 sats reward amount
- Animated POS icon with pulse effect
- Real-time currency conversion
- Automatic processing on flashcard detection

**Screen Layout**:
```typescript
<Wrapper>
  <Title>Tap any Flashcard to receive rewards!</Title>
  <Animatable.View animation="pulse" iterationCount="infinite">
    <Image source={Pos} />
  </Animatable.View>
  <Subtitle>{`21 sats (~${formattedCurrency})\nwill be applied to reward balance.`}</Subtitle>
</Wrapper>
```

### Automatic Reward Processing

**Hook Integration** (`src/screens/Rewards.tsx:36-41`):
```typescript
useFocusEffect(
  useCallback(() => {
    if (loading || !lnurl) return;
    onReward();  // Trigger reward processing
  }, [loading, lnurl]),
);
```

**Processing Logic**:
- Triggers when screen is focused AND flashcard LNURL is available
- Prevents multiple processing attempts with loading state
- Automatic execution without user interaction

## BTCPay Server Integration

### Environment Configuration

**Required Variables**:
```bash
BTC_PAY_SERVER=https://your-btcpay-server.com
PULL_PAYMENT_ID=your-pull-payment-id
```

### Pull Payment API

**File**: `src/screens/Rewards.tsx:43-79`

```typescript
const onReward = async () => {
  const requestBody = {
    destination: lnurl,           // Customer's LNURL from flashcard
    amount: 21,                   // Fixed reward amount in sats
    payoutMethodId: 'BTC-LN',     // Lightning Network payout
  };

  const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;

  try {
    const response = await axios.post(url, requestBody);
    console.log('Response from redeeming rewards:', response.data);

    resetFlashcard();  // Clear flashcard state
    
    if (response.data) {
      const displayAmount = 
        balanceInSats !== undefined &&
        satsToCurrency(balanceInSats + 21).formattedCurrency;

      navigation.navigate('RewardsSuccess', {
        rewardSatAmount: 21,
        balance: displayAmount || '',
      });
    } else {
      toastShow({
        message: 'Reward is failed. Please try again.',
        type: 'error',
      });
    }
  } catch (error) {
    console.error('Error redeeming rewards', error);
    toastShow({
      message: 'Reward is failed. Please try again.',
      type: 'error',
    });
  }
};
```

### API Request Structure

**Endpoint**: `POST /api/v1/pull-payments/{PULL_PAYMENT_ID}/payouts`

**Request Body**:
```json
{
  "destination": "lnurl1dp68gurn8ghj7um9dej8xtnrdakj7ctv9eu8j730d3h82unvwqhkwm4z...",
  "amount": 21,
  "payoutMethodId": "BTC-LN"
}
```

**Response**: BTCPay Server payout object with transaction details

## Success Screen Implementation

### File: `src/screens/RewardsSuccess.tsx`

**Purpose**: Confirms successful reward distribution and displays updated balance

**Screen Props**:
```typescript
type Props = StackScreenProps<RootStackType, 'RewardsSuccess'>;

// Route parameters
interface RewardsSuccessParams {
  rewardSatAmount: number;    // Amount of reward (21 sats)
  balance: string;           // Updated total balance
}
```

**Screen Layout**:
```typescript
<Wrapper>
  <InnerWrapper>
    <Title>{balance}</Title>                    {/* Updated balance */}
    <Image source={Reward} />                  {/* Reward icon */}
    <Subtitle>The Reward has been given!</Subtitle>
    <PrimaryAmount>{formattedCurrency}</PrimaryAmount>  {/* Fiat amount */}
    <SecondaryAmount>{`≈ ${rewardSatAmount} sats`}</SecondaryAmount>
  </InnerWrapper>
  <PrimaryButton
    btnText="Done"
    onPress={onDone}  // Navigate back to home
  />
</Wrapper>
```

### Navigation Handling

**Return to Home** (`src/screens/RewardsSuccess.tsx:28-33`):
```typescript
const onDone = () => {
  navigation.reset({
    index: 0,
    routes: [{name: 'Home'}],  // Reset navigation stack
  });
};
```

## NFC Integration

### Flashcard Detection

The rewards system leverages the `FlashcardProvider` for NFC detection and LNURL extraction:

**Detection Flow**:
1. Customer taps flashcard on Rewards screen
2. `FlashcardProvider.handleTag()` processes NFC data
3. LNURL extracted from flashcard NDEF message
4. `getHtml()` function retrieves balance from BTCPay Server
5. LNURL state update triggers `useFocusEffect` callback
6. Automatic reward processing begins

### State Dependencies

**Required FlashcardContext State**:
```typescript
const {satsToCurrency} = useRealtimePrice();
const {loading, balanceInSats, lnurl, resetFlashcard} = useFlashcard();
```

- `loading`: Prevents multiple simultaneous reward attempts
- `balanceInSats`: Current flashcard balance for updated display
- `lnurl`: Customer's Lightning Network URL for reward destination
- `resetFlashcard`: Clears state after reward processing

## Currency Integration

### Real-time Price Conversion

**Hook Usage** (`src/screens/Rewards.tsx:28-34`):
```typescript
const {satsToCurrency} = useRealtimePrice();

const formattedCurrency = useMemo(
  () => satsToCurrency(21).formattedCurrency,
  [satsToCurrency],
);
```

**Display Format**:
- Shows reward amount in local currency
- Updates automatically with Bitcoin price changes
- Format: "21 sats (~$0.01)" (example)

### Balance Calculation

**Updated Balance Display** (`src/screens/Rewards.tsx:58-61`):
```typescript
const displayAmount =
  balanceInSats !== undefined &&
  satsToCurrency(balanceInSats + 21).formattedCurrency;
```

- Adds reward amount to existing balance
- Converts total to display currency
- Passes to success screen for confirmation

## Error Handling

### Network Errors

```typescript
catch (error) {
  console.error('Error redeeming rewards', error);
  toastShow({
    message: 'Reward is failed. Please try again.',
    type: 'error',
  });
}
```

### BTCPay Server Errors

```typescript
if (response.data) {
  // Success flow
} else {
  toastShow({
    message: 'Reward is failed. Please try again.',
    type: 'error',
  });
}
```

### State Validation

```typescript
if (loading || !lnurl) return;  // Prevent processing without valid state
```

## User Experience Flow

### 1. Initial State
- Customer sees Rewards screen with animated POS icon
- Text shows "Tap any Flashcard to receive rewards!"
- Amount display: "21 sats (~$0.01) will be applied to reward balance"

### 2. Flashcard Interaction
- Customer taps NFC flashcard
- Loading indicator appears automatically
- No additional user interaction required

### 3. Processing
- BTCPay Server API call executes
- Reward distributed to customer's Lightning wallet
- Success/error feedback provided

### 4. Confirmation
- Success screen shows updated balance
- Reward amount confirmation
- Professional success presentation
- "Done" button returns to main app

### 5. Error Recovery
- Clear error messages via toast notifications
- Ability to retry reward process
- State reset for fresh attempts

## Configuration and Customization

### Reward Amount

**Current Implementation**: Fixed 21 sats per flashcard tap

**Location**: `src/screens/Rewards.tsx:47`
```typescript
amount: 21,  // Hardcoded reward amount
```

**Potential Enhancements**:
- Variable reward amounts based on purchase value
- Tiered reward system
- Promotional multipliers
- Dynamic pricing based on Bitcoin value

### BTCPay Server Setup

**Requirements**:
1. BTCPay Server instance with Lightning Network support
2. Pull payment configured for rewards distribution
3. Lightning wallet with sufficient balance for rewards
4. API access configured

**Pull Payment Configuration**:
- Payment method: Bitcoin Lightning Network
- Auto-approve payouts: Recommended for seamless experience
- Payout limits: Set appropriate limits for security

## Security Considerations

### 1. API Security

- **HTTPS Only**: All BTCPay Server communications encrypted
- **Environment Variables**: API endpoints and IDs not hardcoded
- **Error Handling**: No sensitive information in error messages

### 2. Reward Limits

- **Fixed Amount**: Prevents manipulation of reward values
- **Single Reward**: State reset prevents multiple rewards per tap
- **Server Validation**: BTCPay Server enforces payout limits

### 3. State Management

```typescript
resetFlashcard();  // Clear state after processing
```

- Prevents state pollution between customers
- Ensures clean state for each interaction
- Reduces potential for exploitation

## Monitoring and Analytics

### Logging

**Reward Processing**:
```typescript
console.log('Response from redeeming rewards:', response.data);
```

**Error Tracking**:
```typescript
console.error('Error redeeming rewards', error);
```

### Metrics

**Potential Tracking**:
- Reward distribution frequency
- Customer engagement rates
- Error rates and types
- Total rewards distributed
- Cost per customer acquisition

## Future Enhancements

### 1. Advanced Reward Logic

- **Purchase-based Rewards**: Reward percentage of purchase amount
- **Loyalty Tiers**: Increasing rewards for frequent customers
- **Time-based Promotions**: Special reward periods
- **Merchant Customization**: Configurable reward amounts

### 2. Analytics Dashboard

- **Merchant Insights**: Customer behavior analytics
- **Reward Optimization**: Data-driven reward strategy
- **ROI Tracking**: Measure reward program effectiveness

### 3. Customer Engagement

- **Push Notifications**: Reward availability alerts
- **Social Sharing**: Encourage reward program promotion
- **Referral Rewards**: Customer acquisition incentives

### 4. Multi-merchant Support

- **Network Effects**: Shared reward programs across merchants
- **Cross-promotion**: Rewards valid at partner locations
- **Merchant Consortium**: Collaborative reward strategies