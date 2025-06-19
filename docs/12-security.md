# Security Documentation

## Overview

Flash POS implements multiple layers of security to protect merchant settings, customer data, and prevent fraud. This comprehensive security system includes PIN protection for sensitive areas, secure flashcard tracking, transaction validation, and budget controls.

## Table of Contents

1. [PIN Protection System](#pin-protection-system)
2. [Flashcard Security](#flashcard-security)
3. [Transaction Security](#transaction-security)
4. [Reward System Security](#reward-system-security)
5. [API Security](#api-security)
6. [Best Practices](#best-practices)

## PIN Protection System

### Overview

The PIN system provides secure access control for sensitive merchant settings, particularly the rewards configuration. It uses a 4-digit PIN with secure storage and validation.

### Implementation

**State Management**: `src/store/slices/pinSlice.ts`
- Encrypted PIN storage using Redux Persist
- SHA-256 hashing for PIN comparison
- Session-based authentication state

**UI Component**: `src/components/modals/PinModal.tsx`
- Secure input handling
- Visual feedback for PIN entry
- Support for setup, verify, change, and remove modes

### PIN Lifecycle

#### 1. Initial Setup
```typescript
// First access to protected area
if (!hasPin) {
  showPinModal(mode: 'setup')
  user.enters4DigitPin()
  dispatch(setPin(hashedPin))
}
```

#### 2. Verification Flow
```typescript
// Subsequent access attempts
showPinModal(mode: 'verify')
user.entersPin()
dispatch(authenticatePin(pin))
if (authenticated) navigateToProtectedArea()
```

#### 3. PIN Management
- **Change PIN**: Requires old PIN verification
- **Remove PIN**: Requires current PIN verification
- **Reset**: Only through app data clear

### Protected Areas

1. **Reward Settings** (`/RewardsSettings`)
   - Reward rate configuration
   - Merchant ID setup
   - Enable/disable rewards
   - Event mode toggle

2. **Event Settings** (`/EventSettings`)
   - Event configuration
   - Budget settings
   - Customer limits
   - Special merchant IDs

### Security Features

- **No Network Transmission**: PIN never leaves device
- **Hashed Storage**: SHA-256 hashing before storage
- **Session Management**: Auto-clear on app background
- **Brute Force Protection**: Cooldown after failed attempts
- **No Recovery**: Prevents unauthorized access

## Flashcard Security

### Overview

NFC flashcards are tracked securely to enable features like rewards while preventing fraud and duplicate claims.

### Tracking Mechanism

**Unique Identifier**: LNURL extracted from NFC card
```typescript
// Example LNURL (unique per card)
lnurl1dp68gurn8ghj7um9dej8xtnrdakj7ctv9eu8j730d3h82unvwqhkwm4z...
```

### Security Implementation

#### 1. Customer Identification
```typescript
interface TrackedCustomer {
  id: string;          // LNURL hash
  lastReward: number;  // Timestamp
  rewardCount: number; // Total rewards
}
```

#### 2. Duplicate Prevention
```typescript
// Check if customer already rewarded
if (eventRewardedCustomers.includes(customerId)) {
  const count = getCustomerRewardCount(customerId);
  if (count >= limit) {
    throw new Error('Customer reward limit reached');
  }
}
```

#### 3. Cooldown Enforcement
```typescript
const COOLDOWN_PERIOD = 5000; // 5 seconds
if (Date.now() - lastRewardTime < COOLDOWN_PERIOD) {
  throw new Error('Please wait before claiming another reward');
}
```

### Privacy Considerations

- **No Personal Data**: Only LNURL stored
- **Hashed Storage**: Customer IDs are hashed
- **Local Only**: No server-side tracking
- **Event Scoped**: Tracking resets per event

## Transaction Security

### Overview

Every transaction is validated through multiple security checks to ensure legitimacy and prevent fraud.

### Validation Layers

#### 1. Amount Validation
```typescript
// Minimum purchase requirements
if (purchaseAmount < eventMinPurchaseAmount) {
  throw new Error('Purchase amount below minimum');
}

// Maximum limits
if (rewardAmount > maximumReward) {
  rewardAmount = maximumReward; // Cap at maximum
}
```

#### 2. Payment Method Verification
```typescript
// Check allowed payment methods
const allowedMethods = eventAllowedPaymentMethods.split(',');
if (!allowedMethods.includes(paymentMethod)) {
  throw new Error('Payment method not eligible');
}
```

#### 3. Refund Protection
```typescript
// Exclude refunded transactions
if (transaction.isRefund && eventExcludeRefunds) {
  throw new Error('Refunds not eligible for rewards');
}
```

### Budget Controls

#### Real-time Tracking
```typescript
// Check budget before processing
if (totalRewardsGiven + rewardAmount > budgetLimit) {
  if (stopOnBudgetExceed) {
    deactivateEvent();
    throw new Error('Budget limit reached');
  }
}
```

#### Warning System
```typescript
// Alert at threshold
const budgetUsed = totalRewardsGiven / budgetLimit;
if (budgetUsed >= warningThreshold) {
  showWarning('Budget ' + (budgetUsed * 100) + '% used');
}
```

## Reward System Security

### Merchant ID Validation

#### Configuration Security
1. **Required Validation**: Must test ID before enabling
2. **API Verification**: Real-time check against BTCPay
3. **Visual Confirmation**: ✅/❌ status indicators
4. **Auto-save Protection**: Changes persist immediately

#### Runtime Validation
```typescript
// Before every reward
if (!merchantRewardId || !merchantRewardId.trim()) {
  throw new Error('Merchant Reward ID not configured');
}
```

### Event Mode Security

#### Access Control
- PIN required for all event configuration
- Separate PIN verification for event access
- No bypass mechanisms

#### Limit Enforcement
```typescript
// Multiple limit checks
checkCustomerLimit();
checkBudgetLimit();
checkTimeLimit();     // Phase 2
checkLocationLimit(); // Phase 3
```

### Anti-Fraud Measures

1. **Rate Limiting**
   - 5-second cooldown between rewards
   - Per-customer daily limits
   - Total event participant limits

2. **Amount Validation**
   - Minimum purchase requirements
   - Maximum reward caps
   - Percentage validation (0-100%)

3. **Tracking & Audit**
   - Transaction history logging
   - Reward distribution tracking
   - Event participation records

## API Security

### BTCPay Server Integration

#### Secure Communication
```typescript
// HTTPS only
const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${merchantId}/payouts`;

// Sanitized inputs
const sanitizedId = sanitizeMerchantRewardId(merchantId);
```

#### Input Sanitization
```typescript
export function sanitizeMerchantRewardId(id: string): string {
  // Only alphanumeric, hyphens, and underscores
  const sanitized = id.replace(/[^a-zA-Z0-9-_]/g, '');
  return sanitized.substring(0, 50); // Length limit
}
```

#### Error Handling
- No sensitive data in errors
- Generic user-facing messages
- Detailed logs for debugging

### GraphQL Security

#### Query Protection
- Depth limiting on queries
- Rate limiting per user
- Authentication required

#### Data Validation
- Type checking on all inputs
- Boundary validation
- Injection prevention

## Best Practices

### For Merchants

1. **PIN Management**
   - Use unique 4-digit PIN
   - Change PIN regularly
   - Don't share PIN with staff
   - Remove PIN when not needed

2. **Configuration Security**
   - Test merchant IDs before use
   - Set reasonable limits
   - Monitor event progress
   - Review settings regularly

3. **Event Security**
   - Plan budgets carefully
   - Set appropriate customer limits
   - Monitor in real-time
   - Document all events

### For Developers

1. **Code Security**
   - Never log sensitive data
   - Use environment variables
   - Implement proper error handling
   - Follow least privilege principle

2. **State Management**
   - Clear sensitive data on logout
   - Use secure storage APIs
   - Implement session timeouts
   - Validate all inputs

3. **Testing Security**
   - Test all validation rules
   - Verify limit enforcement
   - Check error scenarios
   - Audit security regularly

### Security Checklist

#### Daily Operations
- [ ] Monitor active events
- [ ] Check unusual activity
- [ ] Review error logs
- [ ] Verify budget usage

#### Weekly Maintenance
- [ ] Review transaction logs
- [ ] Update security settings
- [ ] Check for app updates
- [ ] Audit user access

#### Monthly Security
- [ ] Change PINs
- [ ] Review all settings
- [ ] Update documentation
- [ ] Security training

### Incident Response

#### Suspected Fraud
1. Deactivate event immediately
2. Review transaction logs
3. Identify affected customers
4. Document incident
5. Update security measures

#### PIN Compromise
1. Remove PIN immediately
2. Clear app data if needed
3. Set new PIN
4. Review access logs
5. Update security protocol

#### System Breach
1. Disable rewards system
2. Contact support team
3. Preserve evidence
4. Notify affected parties
5. Implement fixes

## Security Architecture

### Defense in Depth

```
Layer 1: PIN Protection
  ↓
Layer 2: Input Validation  
  ↓
Layer 3: Business Rules
  ↓
Layer 4: API Security
  ↓
Layer 5: Monitoring & Alerts
```

### Data Flow Security

```
User Input → Validation → Sanitization → Business Logic → 
API Call → Response Validation → State Update → UI Update
```

Each step includes security checks and validation to ensure data integrity and prevent exploitation.

## Future Enhancements

### Phase 2 Security
- Biometric authentication option
- Time-based access controls
- Enhanced audit logging
- Multi-factor authentication

### Phase 3 Security
- Hardware security module integration
- Advanced fraud detection
- Machine learning anomaly detection
- Blockchain audit trail 