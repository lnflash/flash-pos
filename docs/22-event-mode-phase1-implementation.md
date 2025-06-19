# Event Mode Phase 1 Implementation Guide

## Overview

Event Mode is a powerful feature that allows merchants to create temporary promotional events with custom reward rates, customer limits, and budget controls. This document covers the Phase 1 MVP implementation.

## Features Implemented

### 1. Core Event Management
- **Event Mode Toggle**: Enable/disable event mode from Reward Settings
- **Event Settings Screen**: Dedicated screen for configuring event parameters
- **Event Status Display**: Real-time progress tracking with visual indicators
- **Event Activation/Deactivation**: Manual control over event state

### 2. Customer Tracking & Fraud Prevention
- **Per-Customer Limits**: Restrict rewards per individual customer (default: 1)
- **Unique Customer Tracking**: Track customers by flashcard ID
- **Customer Count Limits**: Maximum number of customers who can receive rewards (default: 100)
- **Duplicate Prevention**: Automatic checking to prevent multiple claims

### 3. Transaction Filters
- **Minimum Purchase Amount**: Set minimum purchase requirement (default: 500 sats)
- **Payment Method Filters**: Currently accepts all payment methods
- **Refund Exclusion**: Refunded transactions don't qualify for rewards

### 4. Budget Controls
- **Total Budget Limit**: Set maximum sats to distribute (default: 100,000)
- **Auto-Deactivation**: Event stops when budget is exhausted
- **Warning Threshold**: Visual warnings at 80% budget utilization
- **Real-time Tracking**: Live progress bars for budget and customer counts

### 5. Basic Display Settings
- **Event Name**: Customer-facing event name
- **Event Message**: Promotional message shown to customers
- **Progress Visibility**: Staff can see real-time event progress

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Event Mode Basic Settings
EVENT_MODE_ENABLED=false                    # Enable event mode feature
DEFAULT_EVENT_REWARD_LIMIT=10000           # Total points limit
DEFAULT_EVENT_REWARD_RATE=0.05             # 5% event reward rate
DEFAULT_EVENT_CUSTOMER_LIMIT=100           # Max 100 customers
DEFAULT_EVENT_MERCHANT_REWARD_ID=          # Optional override

# Customer Tracking
EVENT_CUSTOMER_REWARD_LIMIT=1              # Max rewards per customer
EVENT_UNIQUE_CUSTOMERS_ONLY=true           # Track unique customers
EVENT_TRACK_BY=flashcard                   # Tracking method

# Transaction Filters
EVENT_MIN_PURCHASE_AMOUNT=500              # Minimum purchase (sats)
EVENT_ALLOWED_PAYMENT_METHODS=all          # Accept all methods
EVENT_EXCLUDE_REFUNDS=true                 # Exclude refunds

# Budget Controls
EVENT_BUDGET_SATS=100000                   # Total budget in sats
EVENT_STOP_ON_BUDGET_EXCEED=true          # Auto-stop on budget
EVENT_BUDGET_WARNING_PERCENT=80            # Warning at 80%

# Display Settings
EVENT_DISPLAY_NAME=Special Event           # Event name
EVENT_DISPLAY_MESSAGE=Earn extra rewards!  # Event message
EVENT_SHOW_PROGRESS=true                   # Show progress bars
```

## Usage Guide

### 1. Enable Event Mode
1. Navigate to Profile → Reward Settings
2. Toggle "Event Mode" to enabled
3. Event Settings will now appear in Profile menu

### 2. Configure Event
1. Navigate to Profile → Event Settings
2. Set your event parameters:
   - Event Name and Message
   - Event Reward Rate (overrides normal rate)
   - Customer limits (total and per-customer)
   - Budget limit in sats
   - Minimum purchase amount
   - Optional: Event-specific Merchant Reward ID

### 3. Activate Event
1. In Event Settings, tap "Activate Event"
2. Event status changes to "ACTIVE"
3. Progress bars show real-time tracking
4. Event reward rate now applies to all qualifying transactions

### 4. Monitor Progress
- **Rewards Given**: Shows sats distributed vs budget
- **Customers Rewarded**: Shows customer count vs limit
- Progress bars turn orange at 80% (warning threshold)
- Event auto-deactivates when limits are reached

### 5. Manual Controls
- **Deactivate Event**: Stop event before limits reached
- **Reset Tracking**: Clear counters and start fresh
- All settings auto-save when you leave the field

## Security Features

### PIN Protection
- Event Settings require PIN authentication (same as Reward Settings)
- Prevents unauthorized event configuration

### Customer Verification
- Tracks customers by flashcard ID
- Prevents duplicate rewards to same customer
- Configurable per-customer reward limits

### Budget Protection
- Hard stops when budget exceeded
- Cannot exceed configured limits
- Real-time tracking prevents overspending

### Transaction Validation
- Minimum purchase requirements
- Refund exclusion
- Payment method filtering (ready for Phase 2)

## State Management

### Redux State Structure
```typescript
{
  reward: {
    // Existing reward config...
    
    // Event Mode State
    eventModeEnabled: boolean,
    eventRewardLimit: number,
    eventRewardRate: number,
    eventCustomerLimit: number,
    eventMerchantRewardId: string,
    
    // Tracking
    eventTotalRewardsGiven: number,
    eventCustomersRewarded: number,
    eventRewardedCustomers: string[],
    eventActive: boolean,
    
    // Filters & Controls
    eventMinPurchaseAmount: number,
    eventBudgetSats: number,
    // ... other event fields
  }
}
```

### Key Actions
- `setEventModeEnabled`: Toggle event mode
- `updateEventConfig`: Update any event setting
- `activateEvent`: Start event (resets counters)
- `deactivateEvent`: Stop event
- `trackEventReward`: Record reward given
- `resetEventTracking`: Clear all counters

## Technical Implementation

### Reward Calculation Override
When event is active:
- Uses `eventRewardRate` instead of normal `rewardRate`
- Uses `eventMerchantRewardId` if configured
- All other reward rules still apply (min/max)

### Event Validation Flow
1. Check if event is active
2. Validate minimum purchase amount
3. Check customer reward limit
4. Check if customer already rewarded
5. Process reward if all checks pass
6. Track reward and check budget/limits
7. Auto-deactivate if limits reached

### Navigation Flow
```
Profile 
  → Reward Settings 
    → Event Mode Toggle
  → Event Settings (when enabled)
    → Configure all event parameters
    → Activate/Deactivate/Reset
```

## Testing Checklist

- [ ] Event Mode toggle enables/disables Event Settings navigation
- [ ] Event Settings require PIN authentication
- [ ] All fields validate and auto-save correctly
- [ ] Event Merchant Reward ID test button works
- [ ] Event activation resets counters
- [ ] Progress bars update in real-time
- [ ] Customer duplicate prevention works
- [ ] Minimum purchase validation works
- [ ] Budget limits are enforced
- [ ] Auto-deactivation triggers at limits
- [ ] Event reward rate overrides normal rate
- [ ] Reset tracking clears all counters

## Known Limitations (Phase 1)

1. **Single Event Only**: Cannot run multiple events simultaneously
2. **Basic Tracking**: Uses flashcard ID only (no phone/email)
3. **No Scheduling**: Manual activation/deactivation only
4. **Simple Filters**: Basic purchase amount filter only
5. **No Export**: Event data not exportable yet

## Migration Notes

This implementation is backward compatible:
- Existing rewards continue to work normally
- Event mode is disabled by default
- No database migrations required
- All event data stored in Redux state

## Troubleshooting

### Event Not Activating
- Check if Event Mode is enabled in Reward Settings
- Verify event is not already at limits
- Ensure valid configuration (all fields filled)

### Rewards Not Given
- Check minimum purchase amount
- Verify customer hasn't reached limit
- Ensure budget not exhausted
- Check event is actually active

### Progress Not Updating
- Verify event tracking is working
- Check Redux DevTools for state updates
- Ensure trackEventReward action dispatching

## Next Steps (Phase 2 & 3)

Phase 2 will add:
- Time-based scheduling
- Advanced display options
- Email/SMS notifications
- Basic analytics

Phase 3 will add:
- Tiered rewards
- A/B testing
- Webhooks
- Advanced analytics
- Offline mode 