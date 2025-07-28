# Rewards System Documentation

## Overview

The Flash POS rewards system is a comprehensive Bitcoin rewards platform that allows merchants to incentivize customer loyalty through automatic satoshi (sats) rewards. The system integrates with BTCPay Server's Pull Payments API and supports multiple reward scenarios including purchase-based rewards, standalone rewards, external payment rewards, and special event promotions.

## Table of Contents

1. [Core Features](#core-features)
2. [Configuration](#configuration)
3. [Reward Types](#reward-types)
4. [Event Mode](#event-mode)
5. [Security](#security)
6. [Technical Implementation](#technical-implementation)
7. [API Integration](#api-integration)
8. [Testing](#testing)
9. [Troubleshooting](#troubleshooting)

## Core Features

### 1. Dynamic Reward Calculation
- **Percentage-based rewards**: Customers earn a configurable percentage of their purchase amount
- **Minimum/Maximum constraints**: Ensure rewards stay within reasonable bounds
- **Real-time conversion**: Display rewards in both sats and local currency

### 2. Multiple Reward Scenarios
- **Purchase-based rewards**: Automatic rewards on Lightning payments
- **Standalone rewards**: Fixed rewards for NFC card taps
- **External payment rewards**: Rewards for cash/card payments
- **Event promotions**: Temporary promotional campaigns with custom rules

### 3. Security & Fraud Prevention
- **PIN protection**: Secure access to reward configuration
- **Unique customer tracking**: Prevent duplicate rewards
- **Cooldown periods**: Prevent rapid reward claiming
- **Budget controls**: Automatic limits to prevent overspending

### 4. Merchant Configuration
- **Flexible reward rates**: 0-10% of purchase amount
- **Custom limits**: Set minimum and maximum reward amounts
- **Multiple merchant IDs**: Support for different reward pools
- **Event overrides**: Temporary promotional settings

## Configuration

### Environment Variables

```bash
# Basic Reward Configuration
PULL_PAYMENT_ID=your-btcpay-pull-payment-id
DEFAULT_REWARD_RATE=0.02               # 2% default reward rate
MIN_REWARD_SATS=10                     # Minimum 10 sats per reward
MAX_REWARD_SATS=50000                  # Maximum 50,000 sats per reward
STANDALONE_REWARD_SATS=21              # Fixed 21 sats for card taps
REWARDS_ENABLED=true                   # Enable/disable rewards globally

# Event Mode Configuration
EVENT_MODE_ENABLED=false               # Enable event mode feature
DEFAULT_EVENT_REWARD_LIMIT=10000       # Total sats for event
DEFAULT_EVENT_REWARD_RATE=0.05         # 5% event reward rate
DEFAULT_EVENT_CUSTOMER_LIMIT=100       # Max customers for event
DEFAULT_EVENT_MERCHANT_REWARD_ID=      # Event-specific pull payment ID

# Event Controls
EVENT_CUSTOMER_REWARD_LIMIT=1          # Max rewards per customer
EVENT_MIN_PURCHASE_AMOUNT=500          # Minimum purchase for event
EVENT_BUDGET_SATS=100000               # Total event budget
EVENT_BUDGET_WARNING_PERCENT=80        # Warning threshold
```

### Reward Settings Screen

Navigate to **Profile → Reward Settings** to configure:

1. **Rewards System Toggle**: Enable/disable rewards globally
2. **Reward Rate**: Set percentage of purchase to reward (0-10%)
3. **Minimum Reward**: Lowest amount to award (min: 10 sats)
4. **Maximum Reward**: Highest amount to award (max: 50,000 sats)
5. **Standalone Reward**: Fixed amount for NFC taps
6. **Merchant Reward ID**: BTCPay Server Pull Payment ID
7. **Event Mode**: Enable special promotional events

### PIN Security

- First access creates a 4-digit PIN
- PIN required for all configuration changes
- Option to change or remove PIN
- Protects both Reward Settings and Event Settings

## Reward Types

### 1. Purchase-Based Rewards

Automatic rewards calculated as a percentage of Lightning payment amount:

```typescript
// Example: 2% of 10,000 sats purchase
Purchase: 10,000 sats
Reward Rate: 2%
Calculated: 200 sats
Final Reward: 200 sats (within min/max limits)
```

**Features:**
- Automatic calculation on successful payment
- Respects minimum/maximum constraints
- Shows reward rate badge in UI
- Tracks in transaction history

### 2. Standalone Rewards

Fixed rewards for NFC flashcard taps without purchase:

```typescript
// Direct card tap on Rewards screen
Action: NFC tap
Reward: 21 sats (configurable)
No purchase required
```

**Use Cases:**
- Welcome bonuses
- Check-in rewards
- Promotional giveaways
- Customer engagement

### 3. External Payment Rewards

Rewards for cash or card payments:

```typescript
// Cash payment with reward
Payment Method: Cash
Amount: $10.00
Reward: 2% = ~200 sats
Customer taps card to claim
```

**Workflow:**
1. Process cash/card payment
2. Calculate reward amount
3. Navigate to rewards screen
4. Customer taps flashcard
5. Reward credited to card

### 4. Event Mode Rewards

Temporary promotional campaigns with custom rules:

```typescript
// Valentine's Day Special
Event Rate: 5% (overrides normal 2%)
Budget: 100,000 sats total
Customer Limit: 100 customers
Min Purchase: 500 sats
```

**Features:**
- Override normal reward rate
- Set total budget limits
- Limit customers who can participate
- Automatic deactivation at limits
- Real-time progress tracking

## Event Mode

### Overview

Event Mode enables temporary promotional campaigns with enhanced rewards and custom rules. Perfect for holidays, special occasions, or marketing campaigns.

### Configuration

1. **Enable Event Mode**: Toggle in Reward Settings
2. **Access Event Settings**: New menu item in Profile
3. **Configure Event**:
   - Event name and message
   - Custom reward rate (0-100%)
   - Customer limits
   - Budget controls
   - Minimum purchase requirements
   - Optional custom Merchant ID

### Event Management

#### Activation
```
1. Configure all event parameters
2. Tap "Activate Event"
3. Event status shows "ACTIVE"
4. Custom rate applies immediately
```

#### Monitoring
- **Real-time Progress**: Visual progress bars
- **Budget Tracking**: Sats distributed vs total
- **Customer Count**: Unique customers rewarded
- **Warning Indicators**: Orange at 80% threshold
- **Auto-deactivation**: Stops at limits

#### Controls
- **Manual Deactivation**: Stop event early
- **Reset Tracking**: Clear counters
- **PIN Protection**: Secure configuration

### Event Features

1. **Customer Limits**
   - Track unique customers by flashcard ID
   - Configurable per-customer reward limit
   - Prevent duplicate claims

2. **Budget Controls**
   - Total sats budget
   - Auto-stop when exceeded
   - Visual warnings at threshold

3. **Transaction Filters**
   - Minimum purchase amount
   - Payment method restrictions
   - Refund exclusions

4. **Custom Display**
   - Event name for branding
   - Promotional message
   - Progress visibility

## Security

### PIN Protection System

**Features:**
- 4-digit PIN requirement
- Protects sensitive settings
- Change PIN option
- Remove PIN option
- Failed attempt tracking

**Protected Areas:**
- Reward Settings
- Event Settings
- Merchant ID configuration

### Customer Verification

**Tracking Methods:**
- Flashcard ID (primary)
- Prevents duplicate rewards
- Per-customer limits
- Event participation tracking

### Transaction Security

**Validations:**
- Cooldown periods (5 seconds)
- Minimum purchase checks
- Payment method verification
- Refund exclusions
- Budget enforcement

## Technical Implementation

### State Management

```typescript
// Redux Store Structure
{
  reward: {
    // Basic Configuration
    rewardRate: number,
    minimumReward: number,
    maximumReward: number,
    defaultReward: number,
    merchantRewardId: string,
    isEnabled: boolean,
    
    // Event Mode
    eventModeEnabled: boolean,
    eventActive: boolean,
    eventRewardRate: number,
    eventCustomerLimit: number,
    eventBudgetSats: number,
    eventTotalRewardsGiven: number,
    eventCustomersRewarded: number,
    eventRewardedCustomers: string[],
    
    // Display
    eventDisplayName: string,
    eventDisplayMessage: string,
  }
}
```

### Reward Calculation

```typescript
function calculateReward(purchaseAmount?: number, config: RewardConfig) {
  // Use event rate if active
  const rate = config.eventActive ? config.eventRewardRate : config.rewardRate;
  
  // Standalone reward if no purchase
  if (!purchaseAmount) {
    return config.defaultReward;
  }
  
  // Calculate percentage
  const calculated = Math.floor(purchaseAmount * rate);
  
  // Apply constraints
  return Math.max(
    config.minimumReward,
    Math.min(config.maximumReward, calculated)
  );
}
```

### Event Tracking

```typescript
// Track reward given
dispatch(trackEventReward({
  rewardAmount: calculatedAmount,
  customerId: flashcardId
}));

// Auto-deactivation check
if (totalGiven >= budgetLimit || customersRewarded >= customerLimit) {
  dispatch(deactivateEvent());
}
```

## API Integration

### BTCPay Server Pull Payments

**Endpoint**: `POST /api/v1/pull-payments/{pullPaymentId}/payouts`

**Request Body**:
```json
{
  "destination": "LNURL_or_lightning_address",
  "amount": 200,
  "payoutMethodId": "BTC-LN"
}
```

**Validation**:
- Test button for Merchant ID
- Automatic retry on failure
- Error handling and user feedback

### Merchant ID Management

1. **Configuration**: Enter Pull Payment ID in settings
2. **Validation**: Test button verifies ID exists
3. **Event Override**: Optional event-specific ID
4. **Security**: PIN protected configuration

## Testing

### Manual Testing Checklist

- [ ] PIN creation and authentication
- [ ] Reward calculation accuracy
- [ ] Minimum/maximum constraints
- [ ] Event mode activation
- [ ] Customer duplicate prevention
- [ ] Budget limit enforcement
- [ ] Auto-deactivation triggers
- [ ] Progress tracking accuracy
- [ ] External payment flow
- [ ] Merchant ID validation

### Test Scenarios

1. **Basic Reward Flow**
   ```
   - Make 10,000 sat purchase
   - Verify 2% (200 sats) calculated
   - Confirm BTCPay payout created
   - Check transaction history
   ```

2. **Event Mode Test**
   ```
   - Enable and configure event
   - Activate with 5% rate
   - Process purchase
   - Verify event rate applied
   - Check progress updates
   ```

3. **Security Test**
   ```
   - Try accessing without PIN
   - Test invalid PIN
   - Verify cooldown period
   - Test duplicate prevention
   ```

## Troubleshooting

### Common Issues

**Rewards Not Given**
- Check if rewards enabled
- Verify merchant ID valid
- Ensure within budget limits
- Check minimum purchase met
- Verify customer not at limit

**Event Not Working**
- Confirm event mode enabled
- Check event is active
- Verify configuration valid
- Ensure not at limits
- Check filters (min purchase)

**BTCPay Connection Issues**
- Test merchant ID
- Check network connection
- Verify API endpoint
- Review server logs

### Debug Steps

1. **Check Redux State**
   ```javascript
   // In React Native Debugger
   store.getState().reward
   ```

2. **Verify Configuration**
   - All fields populated
   - Valid number ranges
   - Merchant ID tested

3. **Monitor Network**
   - Check API calls in debugger
   - Verify response status
   - Review error messages

### Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "Merchant Reward ID not configured" | Missing ID | Enter valid Pull Payment ID |
| "Minimum purchase of X sats required" | Below event minimum | Increase purchase amount |
| "You have reached the maximum rewards" | Customer limit hit | Customer not eligible |
| "Event budget exhausted" | Budget limit reached | Event auto-deactivated |

## Best Practices

1. **Configuration**
   - Test merchant IDs before enabling
   - Set reasonable min/max limits
   - Use event mode for promotions
   - Monitor budget usage

2. **Security**
   - Always use PIN protection
   - Regularly review settings
   - Monitor for unusual activity
   - Set appropriate limits

3. **Events**
   - Plan budget carefully
   - Set realistic customer limits
   - Test configuration first
   - Monitor progress regularly

4. **Maintenance**
   - Review transaction logs
   - Update rates as needed
   - Clean old event data
   - Document special promotions
