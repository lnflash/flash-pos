# External Payment Rewards - Quick Implementation Guide

## 🎯 Summary
Add "Give Points" functionality to Keypad screen, allowing merchants to give Bitcoin rewards for cash/card payments without Lightning transactions.

## ⚡ Quick Implementation Steps

### Step 1: Update Types (5 minutes)
```typescript
// src/types/transaction.d.ts
type TransactionType = 'lightning' | 'rewards-only' | 'standalone';

interface TransactionData {
  // ... existing fields
  transactionType: TransactionType;
  paymentMethod?: string;
}

// src/types/routes.d.ts  
type RewardsScreenParams = {
  // ... existing fields
  isExternalPayment?: boolean;
  paymentMethod?: string;
};
```

### Step 2: Add "Give Points" Button to Keypad (15 minutes)
```typescript
// src/screens/Keypad.tsx - Add after existing onNext function

const onGivePoints = useCallback(() => {
  if (!satAmount || !displayAmount) return;
  
  navigation.navigate('Rewards', {
    purchaseAmount: satAmount,
    purchaseCurrency: currency.id,
    purchaseDisplayAmount: `${currency.symbol}${displayAmount}`,
    isExternalPayment: true,
    paymentMethod: 'external',
  });
}, [satAmount, displayAmount, currency, navigation]);

// In the render section, update button container:
<ButtonContainer>
  <SecondaryButton
    btnText="Give Points"
    onPress={onGivePoints}
    disabled={!displayAmount || displayAmount === '0'}
    btnStyle={{marginRight: 10}}
  />
  <PrimaryButton
    btnText="Next"
    onPress={onNext}
    disabled={!displayAmount || displayAmount === '0'}
  />
</ButtonContainer>
```

### Step 3: Update Rewards Screen for External Payments (10 minutes)
```typescript
// src/screens/Rewards.tsx - Update the title logic

const isPurchaseBased = rewardCalculation.calculationType === 'purchase-based';
const isExternalPayment = route.params?.isExternalPayment;

// Update the title
<Title>
  {isExternalPayment 
    ? 'Claim Bitcoin Rewards for Your Payment!'
    : isPurchaseBased 
      ? 'Claim Your Purchase Reward!' 
      : 'Tap any Flashcard to receive rewards!'
  }
</Title>

// Update purchase context display
{purchaseDisplayAmount && (
  <Animatable.View animation="fadeInDown" duration={800}>
    <PurchaseCard>
      <PurchaseLabel>
        {isExternalPayment ? 'External Payment Amount' : 'Purchase Amount'}
      </PurchaseLabel>
      <PurchaseAmount>{purchaseDisplayAmount}</PurchaseAmount>
      {rewardPercentage && (
        <RewardRateBadge>
          <RewardRateText>{rewardPercentage}% Bitcoin Reward</RewardRateText>
        </RewardRateBadge>
      )}
    </PurchaseCard>
  </Animatable.View>
)}
```

### Step 4: Update Success Screen (10 minutes)
```typescript
// src/screens/RewardsSuccess.tsx - Update success messaging

const isExternalPayment = route.params?.isExternalPayment;

<SuccessSubtitle>
  {isExternalPayment
    ? 'Your Bitcoin reward for external payment has been added'
    : isPurchaseBased 
      ? 'Your purchase reward has been added to your balance'
      : 'Your flashcard reward has been added to your balance'
  }
</SuccessSubtitle>

// Update context title if showing purchase details
<PurchaseContextTitle>
  {isExternalPayment ? 'External Payment Reward Details' : 'Purchase Reward Details'}
</PurchaseContextTitle>
```

### Step 5: Update Transaction Creation (15 minutes)
```typescript
// src/screens/Rewards.tsx - Update the onReward function to create proper transaction

// In the successful response handling:
const transactionData: TransactionData = {
  id: `${route.params?.isExternalPayment ? 'external' : 'lightning'}_${Date.now()}`,
  timestamp: new Date().toISOString(),
  transactionType: route.params?.isExternalPayment ? 'rewards-only' : 'lightning',
  paymentMethod: route.params?.paymentMethod || 'lightning',
  amount: {
    satAmount: purchaseAmount || 0,
    displayAmount: purchaseDisplayAmount?.replace(/[^0-9.]/g, '') || '0',
    currency,
    isPrimaryAmountSats: false,
  },
  merchant: {
    username: 'Flash', // Get from user state
  },
  invoice: {
    paymentHash: '', // Empty for external payments
    paymentRequest: '',
    paymentSecret: '',
  },
  memo: route.params?.isExternalPayment ? 'External payment reward' : undefined,
  status: 'completed',
  reward: {
    rewardAmount: rewardCalculation.rewardAmount,
    rewardRate: rewardCalculation.rewardRate || 0,
    wasMinimumApplied: rewardCalculation.appliedMinimum || false,
    wasMaximumApplied: rewardCalculation.appliedMaximum || false,
    isStandalone: false,
    timestamp: new Date().toISOString(),
  },
};

// Add transaction to history
dispatch(addTransaction(transactionData));
```

### Step 6: Update Transaction History Display (10 minutes)
```typescript
// src/screens/TransactionHistory.tsx - Add transaction type badges

// Add after existing reward badge
{item.transactionType === 'rewards-only' && (
  <TransactionTypeBadge type="external">
    <TransactionTypeBadgeText>💳 External Payment</TransactionTypeBadgeText>
  </TransactionTypeBadge>
)}

{item.transactionType === 'lightning' && (
  <TransactionTypeBadge type="lightning">
    <TransactionTypeBadgeText>⚡ Lightning</TransactionTypeBadgeText>
  </TransactionTypeBadge>
)}

// Add styled components
const TransactionTypeBadge = styled.View<{type: 'external' | 'lightning'}>`
  background-color: ${props => props.type === 'external' ? '#FF9500' : '#007856'};
  border-radius: 8px;
  padding-horizontal: 6px;
  padding-vertical: 2px;
  margin-left: 6px;
`;

const TransactionTypeBadgeText = styled.Text`
  font-size: 10px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
`;
```

### Step 7: Test Implementation (10 minutes)

1. **Enter amount** in Keypad
2. **Press "Give Points"** → Should navigate to Rewards
3. **See external payment context** → Clear messaging about external payment
4. **Tap NFC** → Should distribute reward
5. **Check Success screen** → Should show external payment context
6. **Check Transaction History** → Should show "External Payment" badge

## 🎨 Styling Notes

- **"Give Points" button**: Use SecondaryButton styling to not compete with main flow
- **External payment indicators**: Use orange/gold colors to differentiate from Lightning (green)
- **Clear messaging**: Always indicate when rewards are for external vs Lightning payments

## 🚀 Quick Commands

```bash
# Test the implementation
npm test -- --testPathPattern="reward" --verbose

# Commit your changes
git add .
git commit -m "feat: Add External Payment Rewards - Give Points button for cash/card transactions"
git push origin rewards-v3
```

## ✅ Success Criteria

- ✅ "Give Points" button appears on Keypad
- ✅ Button navigates to Rewards with external payment context
- ✅ Rewards screen shows appropriate messaging
- ✅ Transaction is recorded as "rewards-only" type
- ✅ Transaction History shows external payment badge
- ✅ All existing flows remain unchanged

**Total Implementation Time**: ~75 minutes for basic functionality

This creates a universal Bitcoin rewards system that works with any payment method! 🎉 