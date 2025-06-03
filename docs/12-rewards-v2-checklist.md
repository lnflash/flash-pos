# Rewards V2 Development Checklist

## Phase 1: Foundation Setup ✅❌

### Step 1.1: Reward Configuration System
- [ ] Create `src/store/slices/rewardSlice.ts`
- [ ] Define RewardState interface
- [ ] Implement default reward settings
- [ ] Add reward rate persistence to Redux
- [ ] Add validation for reward rate limits (0-10%)

### Step 1.2: Navigation Types
- [ ] Create/update `src/types/navigation.ts`
- [ ] Define RewardsScreenParams type
- [ ] Define RewardsSuccessParams type
- [ ] Update existing screen prop types
- [ ] Ensure backward compatibility

### Step 1.3: Environment Configuration
- [ ] Add DEFAULT_REWARD_RATE=0.02 to env
- [ ] Add MIN_REWARD_SATS=1 to env
- [ ] Add MAX_REWARD_SATS=1000 to env
- [ ] Add STANDALONE_REWARD_SATS=21 to env
- [ ] Document configuration options

## Phase 2: Core Logic Implementation ✅❌

### Step 2.1: Reward Calculation Logic
- [ ] Create `src/utils/rewardCalculations.ts`
- [ ] Define RewardCalculation interface
- [ ] Implement calculateReward function
- [ ] Add minimum/maximum reward constraints
- [ ] Handle edge cases (zero amounts, etc.)
- [ ] Write comprehensive unit tests

### Step 2.2: Update Rewards Screen
- [ ] Update `src/screens/Rewards.tsx` imports
- [ ] Accept navigation parameters for purchase context
- [ ] Implement dynamic reward calculation with useMemo
- [ ] Update BTCPay Server API call with calculated amount
- [ ] Update UI to show purchase-based vs standalone rewards
- [ ] Test reward calculation accuracy

### Step 2.3: Enhanced Success Screen
- [ ] Update `src/screens/RewardsSuccess.tsx` props
- [ ] Add purchase context display
- [ ] Show reward percentage when applicable
- [ ] Create renderRewardContext function
- [ ] Maintain clean UI for standalone rewards
- [ ] Add appropriate styling for new elements

## Phase 3: Navigation Integration ✅❌

### Step 3.1: Keypad Screen Integration
- [ ] Update `src/screens/Keypad.tsx`
- [ ] Identify reward navigation trigger points
- [ ] Pass purchase context from POS flow
- [ ] Ensure amount conversion accuracy (sats calculation)
- [ ] Add transaction linking if needed
- [ ] Test navigation parameter passing

### Step 3.2: Invoice Integration (Optional)
- [ ] Analyze `src/screens/Invoice.tsx` integration needs
- [ ] Determine post-payment reward flow requirements
- [ ] Implement post-payment reward triggers if needed
- [ ] Handle payment confirmation → reward flow
- [ ] Test invoice-to-reward flow

## Phase 4: Merchant Configuration ✅❌

### Step 4.1: Profile Screen Enhancement
- [ ] Update `src/screens/Profile.tsx`
- [ ] Add RewardConfigSection component
- [ ] Implement reward rate input (percentage)
- [ ] Implement minimum reward input (sats)
- [ ] Add input validation
- [ ] Add save/reset functionality
- [ ] Show preview of reward amounts

### Step 4.2: Settings Persistence
- [ ] Complete `src/store/slices/rewardSlice.ts` actions
- [ ] Implement updateRewardRate action
- [ ] Implement updateMinimumReward action
- [ ] Implement resetToDefaults action
- [ ] Add validation constraints (0-10% rate limit)
- [ ] Test settings persistence

## Phase 5: UI/UX Enhancement ✅❌

### Step 5.1: Rewards Screen UI Updates
- [ ] Create contextual reward messaging
- [ ] Add purchase amount display when applicable
- [ ] Implement reward rate visualization
- [ ] Enhance existing animations
- [ ] Test UI with different screen sizes
- [ ] Update styling for new elements

### Step 5.2: Success Screen Polish
- [ ] Design purchase context components
- [ ] Add reward breakdown visualization
- [ ] Implement percentage earned badge
- [ ] Implement success state enhancements
- [ ] Ensure responsive design
- [ ] Test with various purchase amounts

## Phase 6: Testing & Validation ✅❌

### Step 6.1: Unit Testing
- [ ] Test `src/utils/rewardCalculations.ts`
- [ ] Test `src/store/slices/rewardSlice.ts`
- [ ] Test percentage-based reward calculations
- [ ] Test minimum reward constraints
- [ ] Test standalone reward fallback
- [ ] Test edge cases and error conditions

### Step 6.2: Integration Testing
- [ ] Test Purchase → Rewards → Success flow
- [ ] Test standalone rewards flow (backward compatibility)
- [ ] Test configuration changes affecting calculations
- [ ] Test BTCPay Server integration with variable amounts
- [ ] Test navigation parameter passing
- [ ] Verify all user flows work correctly

### Step 6.3: User Acceptance Testing
- [ ] Test merchant configures 3% reward rate
- [ ] Test $20 purchase → ~60 sats reward calculation
- [ ] Test standalone flashcard tap → default reward
- [ ] Test success screen shows correct purchase context
- [ ] Test error handling scenarios
- [ ] Validate merchant configuration workflow

## Production Readiness ✅❌

### Code Quality
- [ ] All TypeScript types defined
- [ ] No console.log statements in production code
- [ ] Error handling implemented
- [ ] Loading states handled
- [ ] Input validation complete

### Documentation
- [ ] Update existing docs with new features
- [ ] Create merchant configuration guide
- [ ] Update API documentation
- [ ] Create troubleshooting guide

### Performance
- [ ] Reward calculation performance < 100ms
- [ ] Navigation parameter passing reliable
- [ ] State updates don't cause UI lag
- [ ] BTCPay API calls under timeout limits

### Security
- [ ] Reward rate limits enforced (0-10%)
- [ ] Input sanitization implemented
- [ ] No sensitive data in logs
- [ ] API calls properly secured

## Deployment Checklist ✅❌

### Pre-deployment
- [ ] All tests passing
- [ ] Code review completed
- [ ] Environment variables configured
- [ ] BTCPay Server tested with variable amounts
- [ ] Rollback plan prepared

### Deployment
- [ ] Deploy to staging environment
- [ ] Validate all functionality in staging
- [ ] Performance testing completed
- [ ] Security testing completed
- [ ] Deploy to production

### Post-deployment
- [ ] Monitor reward distribution metrics
- [ ] Monitor BTCPay Server performance
- [ ] Monitor error rates
- [ ] Gather merchant feedback
- [ ] Gather customer feedback

## Notes & Issues

### Known Issues
- [ ] Issue 1: [Description]
- [ ] Issue 2: [Description]

### Future Enhancements
- [ ] Loyalty tiers implementation
- [ ] Time-based promotions
- [ ] Analytics dashboard
- [ ] Multi-merchant networks

### Developer Notes
- Remember to maintain backward compatibility
- Test both purchase-based and standalone flows
- Validate BTCPay Server integration thoroughly
- Keep UI simple and intuitive

---

**Total Progress: 0/XX tasks completed (0%)**

**Current Phase: Planning**

**Next Action: Begin Phase 1 - Foundation Setup** 