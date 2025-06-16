# Rewards System v2 - Purchase-Based Rewards Implementation Plan

## Overview

This document outlines the step-by-step implementation plan for upgrading the Flash POS rewards system from fixed 21 sats rewards to a flexible purchase-based rewards system. This enhancement will allow merchants to offer percentage-based rewards tied to actual purchase amounts.

## Current State Analysis

### Existing System Features
- ✅ Fixed 21 sats rewards per flashcard tap
- ✅ BTCPay Server integration for reward distribution
- ✅ NFC flashcard integration
- ✅ Real-time currency conversion
- ✅ Success confirmation screens
- ✅ Error handling and state management

### Limitations to Address
- ❌ Fixed reward amount regardless of purchase value
- ❌ No merchant customization of reward rates
- ❌ No connection between POS transactions and rewards
- ❌ No purchase context in reward flow

## Implementation Goals

### Primary Objectives
1. **Purchase-Linked Rewards**: Calculate rewards as percentage of purchase amount
2. **Merchant Configuration**: Allow customizable reward rates
3. **Contextual Rewards**: Show purchase details in reward confirmation
4. **Backward Compatibility**: Maintain standalone rewards functionality
5. **Enhanced UX**: Improve customer understanding of reward value

### Success Metrics
- Rewards scale with purchase amounts
- Merchants can configure reward percentages
- Customer sees clear purchase-to-reward relationship
- Existing NFC flashcard flow remains functional

## Technical Architecture Changes

### 1. Navigation Enhancement
**Affected Files:**
- `src/types/navigation.ts` (if exists)
- `src/screens/Keypad.tsx`
- `src/screens/Rewards.tsx`
- `src/screens/RewardsSuccess.tsx`

**Changes:**
- Add purchase context to navigation parameters
- Pass purchase amount from POS to Rewards screen
- Support both purchase-based and standalone reward flows

### 2. State Management Updates
**Affected Files:**
- `src/store/slices/` (new reward configuration slice)
- `src/contexts/Flashcard.tsx` (if needed)

**Changes:**
- Add reward configuration to Redux state
- Store merchant reward rate preferences
- Track purchase context for reward calculations

### 3. Business Logic Enhancement
**Affected Files:**
- `src/screens/Rewards.tsx`
- `src/screens/RewardsSuccess.tsx`

**Changes:**
- Dynamic reward calculation based on purchase amount
- Fallback to fixed rewards for standalone usage
- Enhanced success screen with purchase context

## Step-by-Step Implementation Plan

### Phase 1: Foundation Setup (Days 1-2)

#### Step 1.1: Create Reward Configuration System
**File:** `src/store/slices/rewardSlice.ts`

```typescript
interface RewardState {
  rewardRate: number;           // Percentage (e.g., 0.02 for 2%)
  minimumReward: number;        // Minimum sats to award
  maximumReward: number;        // Maximum sats to award
  defaultReward: number;        // Fallback for standalone rewards
  isEnabled: boolean;           // Global reward system toggle
}
```

**Tasks:**
- [ ] Create Redux slice for reward configuration
- [ ] Add default reward settings
- [ ] Implement reward rate persistence
- [ ] Add validation for reward rate limits

#### Step 1.2: Update Navigation Types
**File:** `src/types/navigation.ts` (create if doesn't exist)

```typescript
type RewardsScreenParams = {
  purchaseAmount?: number;      // Optional for backward compatibility
  purchaseCurrency?: string;    // Currency of purchase
  transactionId?: string;       // Link to transaction
};

type RewardsSuccessParams = {
  rewardSatAmount: number;
  balance: string;
  purchaseAmount?: number;      // Show purchase context
  purchaseCurrency?: string;
  rewardRate?: number;          // Show percentage earned
};
```

**Tasks:**
- [ ] Define navigation parameter types
- [ ] Update existing screen prop types
- [ ] Ensure backward compatibility

#### Step 1.3: Environment Configuration
**File:** `.env` or configuration

```bash
# Reward system configuration
DEFAULT_REWARD_RATE=0.02        # 2% default
MIN_REWARD_SATS=1              # Minimum 1 sat
MAX_REWARD_SATS=1000           # Maximum 1000 sats
STANDALONE_REWARD_SATS=21      # Current fixed amount
```

**Tasks:**
- [ ] Add reward configuration variables
- [ ] Document configuration options
- [ ] Set reasonable defaults

### Phase 2: Core Logic Implementation (Days 3-4)

#### Step 2.1: Enhanced Reward Calculation Logic
**File:** `src/utils/rewardCalculations.ts` (new file)

```typescript
interface RewardCalculation {
  rewardAmount: number;
  rewardRate?: number;
  purchaseAmount?: number;
  calculationType: 'purchase-based' | 'standalone';
}

export const calculateReward = (
  purchaseAmount?: number,
  rewardRate: number = 0.02,
  fallbackAmount: number = 21
): RewardCalculation => {
  if (!purchaseAmount) {
    return {
      rewardAmount: fallbackAmount,
      calculationType: 'standalone'
    };
  }

  const calculatedReward = Math.floor(purchaseAmount * rewardRate);
  
  return {
    rewardAmount: Math.max(calculatedReward, 1), // Minimum 1 sat
    rewardRate,
    purchaseAmount,
    calculationType: 'purchase-based'
  };
};
```

**Tasks:**
- [ ] Create reward calculation utility
- [ ] Add minimum/maximum reward constraints
- [ ] Handle edge cases (zero amounts, etc.)
- [ ] Add comprehensive unit tests

#### Step 2.2: Update Rewards Screen
**File:** `src/screens/Rewards.tsx`

**Key Changes:**
```typescript
const Rewards: React.FC<Props> = ({route}) => {
  const {purchaseAmount, purchaseCurrency} = route.params || {};
  const {rewardRate, defaultReward} = useAppSelector(state => state.reward);
  
  const rewardCalculation = useMemo(() => 
    calculateReward(purchaseAmount, rewardRate, defaultReward),
    [purchaseAmount, rewardRate, defaultReward]
  );

  const formattedCurrency = useMemo(
    () => satsToCurrency(rewardCalculation.rewardAmount).formattedCurrency,
    [rewardCalculation.rewardAmount, satsToCurrency],
  );

  // Update BTCPay API call
  const onReward = async () => {
    const requestBody = {
      destination: lnurl,
      amount: rewardCalculation.rewardAmount, // Dynamic amount
      payoutMethodId: 'BTC-LN',
    };
    // ... rest of API logic
  };
```

**Tasks:**
- [ ] Accept navigation parameters for purchase context
- [ ] Implement dynamic reward calculation
- [ ] Update UI to show purchase-based vs standalone rewards
- [ ] Update BTCPay Server API call with calculated amount

#### Step 2.3: Enhanced Success Screen
**File:** `src/screens/RewardsSuccess.tsx`

**Key Changes:**
```typescript
const RewardsSuccess: React.FC<Props> = ({route}) => {
  const {
    rewardSatAmount, 
    balance, 
    purchaseAmount, 
    purchaseCurrency,
    rewardRate
  } = route.params;

  const renderRewardContext = () => {
    if (purchaseAmount && rewardRate) {
      return (
        <PurchaseContext>
          You earned {(rewardRate * 100).toFixed(1)}% on your 
          {purchaseCurrency}{purchaseAmount} purchase!
        </PurchaseContext>
      );
    }
    return <StandaloneContext>Standalone reward earned!</StandaloneContext>;
  };
```

**Tasks:**
- [ ] Add purchase context display
- [ ] Show reward percentage when applicable
- [ ] Maintain clean UI for standalone rewards
- [ ] Add appropriate styling for new elements

### Phase 3: Navigation Integration (Days 5-6)

#### Step 3.1: Update Keypad Screen Integration
**File:** `src/screens/Keypad.tsx`

**Key Changes:**
```typescript
const navigateToRewards = () => {
  const purchaseData = {
    purchaseAmount: amountInSats,
    purchaseCurrency: currency,
    transactionId: generateTransactionId(), // if needed
  };
  
  navigation.navigate('Rewards', purchaseData);
};
```

**Tasks:**
- [ ] Identify reward navigation trigger points
- [ ] Pass purchase context from POS flow
- [ ] Ensure amount conversion accuracy
- [ ] Add transaction linking if needed

#### Step 3.2: Invoice Integration (if applicable)
**File:** `src/screens/Invoice.tsx`

**Considerations:**
- Should rewards be offered during invoice creation?
- Post-payment reward flow integration
- Lightning payment success → reward flow

**Tasks:**
- [ ] Analyze invoice-to-reward flow requirements
- [ ] Implement post-payment reward triggers
- [ ] Handle payment confirmation → reward flow

### Phase 4: Merchant Configuration (Days 7-8)

#### Step 4.1: Profile Screen Enhancement
**File:** `src/screens/Profile.tsx`

**New Section:**
```typescript
<RewardConfigSection>
  <SectionTitle>Reward Settings</SectionTitle>
  <ConfigRow>
    <Label>Reward Rate (%)</Label>
    <NumberInput 
      value={rewardRate * 100}
      onChangeText={updateRewardRate}
      placeholder="2.0"
    />
  </ConfigRow>
  <ConfigRow>
    <Label>Minimum Reward (sats)</Label>
    <NumberInput 
      value={minimumReward}
      onChangeText={updateMinimumReward}
      placeholder="1"
    />
  </ConfigRow>
</RewardConfigSection>
```

**Tasks:**
- [ ] Add reward configuration UI to Profile screen
- [ ] Implement input validation
- [ ] Add save/reset functionality
- [ ] Show preview of reward amounts

#### Step 4.2: Settings Persistence
**File:** `src/store/slices/rewardSlice.ts`

**Actions to implement:**
```typescript
updateRewardRate(state, action) {
  state.rewardRate = Math.max(0, Math.min(0.1, action.payload)); // 0-10%
}

updateMinimumReward(state, action) {
  state.minimumReward = Math.max(1, action.payload);
}

resetToDefaults(state) {
  return initialState;
}
```

**Tasks:**
- [ ] Implement settings persistence
- [ ] Add validation constraints
- [ ] Create reset functionality
- [ ] Add settings export/import

### Phase 5: UI/UX Enhancement (Days 9-10)

#### Step 5.1: Rewards Screen UI Updates
**File:** `src/screens/Rewards.tsx`

**UI Enhancements:**
- Dynamic messaging based on context
- Purchase amount display when applicable
- Reward rate visualization
- Enhanced animations

**Tasks:**
- [ ] Create contextual reward messaging
- [ ] Add purchase amount display
- [ ] Implement reward rate visualization
- [ ] Enhance existing animations

#### Step 5.2: Success Screen Polish
**File:** `src/screens/RewardsSuccess.tsx`

**New Components:**
- Purchase summary card
- Reward calculation breakdown
- Percentage earned badge
- Enhanced success animations

**Tasks:**
- [ ] Design purchase context components
- [ ] Add reward breakdown visualization
- [ ] Implement success state enhancements
- [ ] Ensure responsive design

### Phase 6: Testing & Validation (Days 11-12)

#### Step 6.1: Unit Testing
**Files to test:**
- `src/utils/rewardCalculations.ts`
- `src/store/slices/rewardSlice.ts`
- Reward calculation logic

**Test Cases:**
```typescript
describe('Reward Calculations', () => {
  test('calculates percentage-based rewards correctly', () => {
    const result = calculateReward(1000, 0.02); // $10 * 2%
    expect(result.rewardAmount).toBe(20); // 20 sats
  });

  test('applies minimum reward constraint', () => {
    const result = calculateReward(10, 0.02); // Very small purchase
    expect(result.rewardAmount).toBeGreaterThanOrEqual(1);
  });

  test('falls back to standalone rewards', () => {
    const result = calculateReward(undefined, 0.02, 21);
    expect(result.rewardAmount).toBe(21);
    expect(result.calculationType).toBe('standalone');
  });
});
```

**Tasks:**
- [ ] Write comprehensive unit tests
- [ ] Test edge cases and error conditions
- [ ] Validate reward calculation accuracy
- [ ] Test state management logic

#### Step 6.2: Integration Testing
**Test Scenarios:**
- Purchase → Rewards → Success flow
- Standalone rewards flow (backward compatibility)
- Configuration changes affecting calculations
- BTCPay Server integration with variable amounts

**Tasks:**
- [ ] Test complete user flows
- [ ] Validate BTCPay Server integration
- [ ] Test navigation parameter passing
- [ ] Verify backward compatibility

#### Step 6.3: User Acceptance Testing
**Test Cases:**
- Merchant configures 3% reward rate
- Customer makes $20 purchase → receives ~60 sats reward
- Standalone flashcard tap → receives default reward
- Success screen shows correct purchase context

**Tasks:**
- [ ] Create UAT test plan
- [ ] Test with various purchase amounts
- [ ] Validate merchant configuration workflow
- [ ] Test error handling scenarios

## Risk Assessment & Mitigation

### Technical Risks
1. **Breaking Changes**: Existing reward flow disruption
   - **Mitigation**: Maintain backward compatibility, gradual rollout

2. **BTCPay Server Limits**: Variable amounts hitting API limits
   - **Mitigation**: Implement reward amount validation, rate limiting

3. **State Management**: Complex reward configuration state
   - **Mitigation**: Comprehensive testing, clear state structure

### Business Risks
1. **Reward Economics**: Merchants setting unsustainable rates
   - **Mitigation**: Implement reasonable defaults and limits

2. **Customer Confusion**: Complex reward calculations
   - **Mitigation**: Clear UI messaging, simple percentage display

## Success Criteria & Metrics

### Functional Requirements
- [ ] Purchase-based rewards calculate correctly
- [ ] Merchant can configure reward rates
- [ ] Backward compatibility maintained
- [ ] BTCPay Server integration works with variable amounts
- [ ] Success screen shows purchase context

### Performance Requirements
- [ ] Reward calculation < 100ms
- [ ] Navigation parameter passing reliable
- [ ] State updates don't cause UI lag
- [ ] BTCPay API calls remain under timeout limits

### User Experience Requirements
- [ ] Intuitive merchant configuration
- [ ] Clear customer reward understanding
- [ ] Smooth purchase-to-reward flow
- [ ] Professional success confirmation

## Deployment Strategy

### Phase 1: Internal Testing
- Deploy to staging environment
- Test with various purchase amounts
- Validate merchant configuration workflows

### Phase 2: Beta Release
- Limited merchant pilot program
- Gather feedback on reward rates and UX
- Monitor BTCPay Server performance

### Phase 3: Full Release
- Gradual rollout to all merchants
- Monitor reward distribution metrics
- Gather customer feedback

### Rollback Plan
- Maintain ability to revert to fixed rewards
- Environment flag for feature toggle
- Database migration rollback procedures

## Future Considerations

### Phase 3 Enhancements (Post-V2)
1. **Loyalty Tiers**: Progressive reward rates
2. **Time-based Promotions**: Special event multipliers
3. **Analytics Dashboard**: Reward program insights
4. **Multi-merchant Networks**: Shared reward programs

### Technical Debt
1. **Refactor Navigation**: Centralized parameter management
2. **Enhanced Testing**: E2E test automation
3. **Performance Optimization**: Reward calculation caching
4. **API Improvements**: Better error handling and retry logic

## Documentation Updates Required

### User Documentation
- [ ] Update merchant onboarding guide
- [ ] Create reward configuration tutorial
- [ ] Update customer-facing materials

### Technical Documentation
- [ ] Update API documentation
- [ ] Revise architecture diagrams
- [ ] Update deployment procedures

### Training Materials
- [ ] Merchant training on reward configuration
- [ ] Support team training on new features
- [ ] Customer education materials

## Conclusion

This implementation plan provides a comprehensive roadmap for upgrading the Flash POS rewards system to support purchase-based rewards while maintaining backward compatibility. The phased approach ensures minimal disruption to existing functionality while delivering significant value to merchants and customers.

The estimated timeline is 12 days of focused development, followed by testing and gradual deployment. Success will be measured by merchant adoption of configurable reward rates and increased customer engagement through purchase-linked rewards. 