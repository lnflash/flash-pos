# Reward System Configuration Guide

## Overview

Flash POS v2 rewards system allows merchants to configure their customer loyalty program through environment variables. This provides flexibility to customize reward rates, limits, and behavior without code changes.

## Environment Variables

### Required Variables

Add these variables to your `.env` file or environment configuration:

```bash
# Reward System Configuration
DEFAULT_REWARD_RATE=0.02          # Default reward percentage (2%)
MIN_REWARD_SATS=1                 # Minimum reward amount in sats
MAX_REWARD_SATS=1000              # Maximum reward amount in sats  
STANDALONE_REWARD_SATS=21         # Default standalone reward amount
REWARDS_ENABLED=true              # Enable/disable reward system globally
```

### Configuration Details

#### `DEFAULT_REWARD_RATE`
- **Type**: Number (decimal)
- **Range**: 0.00 - 0.10 (0% - 10%)
- **Default**: 0.02 (2%)
- **Description**: Percentage of purchase amount awarded as rewards
- **Examples**:
  - `0.01` = 1% rewards
  - `0.025` = 2.5% rewards  
  - `0.05` = 5% rewards

#### `MIN_REWARD_SATS`
- **Type**: Number (integer)
- **Range**: 1 - 999
- **Default**: 1
- **Description**: Minimum sats awarded even for tiny purchases
- **Use Case**: Ensures customers always get at least some reward

#### `MAX_REWARD_SATS`
- **Type**: Number (integer)  
- **Range**: 1 - 100000
- **Default**: 1000
- **Description**: Maximum sats awarded to limit reward costs
- **Use Case**: Prevents excessive rewards on large purchases

#### `STANDALONE_REWARD_SATS`
- **Type**: Number (integer)
- **Range**: 1 - 10000  
- **Default**: 21
- **Description**: Fixed reward amount for standalone flashcard taps
- **Use Case**: Maintains current system for customers just tapping cards

#### `REWARDS_ENABLED`
- **Type**: Boolean
- **Values**: `true` | `false`
- **Default**: `true`
- **Description**: Global toggle for entire reward system
- **Use Case**: Quickly disable rewards without changing other settings

## Configuration Examples

### Conservative Merchant (Low Risk)
```bash
DEFAULT_REWARD_RATE=0.01          # 1% rewards
MIN_REWARD_SATS=1                 # Minimum 1 sat
MAX_REWARD_SATS=500               # Cap at 500 sats ($0.20 @ $40k BTC)
STANDALONE_REWARD_SATS=10         # Reduced standalone rewards
REWARDS_ENABLED=true
```

### Aggressive Merchant (High Customer Acquisition)
```bash
DEFAULT_REWARD_RATE=0.05          # 5% rewards
MIN_REWARD_SATS=5                 # Minimum 5 sats
MAX_REWARD_SATS=2000              # Cap at 2000 sats ($0.80 @ $40k BTC)
STANDALONE_REWARD_SATS=50         # Higher standalone rewards
REWARDS_ENABLED=true
```

### Promotional Campaign
```bash
DEFAULT_REWARD_RATE=0.10          # 10% rewards (maximum allowed)
MIN_REWARD_SATS=10                # Minimum 10 sats
MAX_REWARD_SATS=5000              # High cap for promotion
STANDALONE_REWARD_SATS=100        # Promotional standalone rewards
REWARDS_ENABLED=true
```

### Disable Rewards
```bash
DEFAULT_REWARD_RATE=0.02          # Settings maintained
MIN_REWARD_SATS=1                 
MAX_REWARD_SATS=1000              
STANDALONE_REWARD_SATS=21         
REWARDS_ENABLED=false             # System disabled
```

## Reward Economics Calculator

### Monthly Cost Estimation

Use this formula to estimate monthly reward costs:

```
Monthly Reward Cost = (Average Transaction Amount × DEFAULT_REWARD_RATE × Number of Transactions) + (Standalone Rewards × Number of Standalone Taps)
```

**Example Calculation:**
- Average transaction: 5000 sats ($2.00 @ $40k BTC)
- Reward rate: 2%
- Monthly transactions: 100
- Standalone taps: 50

```
Monthly Cost = (5000 × 0.02 × 100) + (21 × 50)
             = (10,000) + (1,050)  
             = 11,050 sats (~$4.42 @ $40k BTC)
```

### ROI Considerations

**Benefits of Higher Reward Rates:**
- Increased customer retention
- Higher average transaction amounts
- More frequent visits
- Word-of-mouth marketing
- Bitcoin education and adoption

**Risks of Higher Reward Rates:**
- Higher operational costs
- Potential for abuse
- Cash flow impact
- Price volatility exposure

## Best Practices

### Starting Configuration
1. **Begin Conservative**: Start with 1-2% rewards
2. **Monitor Performance**: Track customer behavior for 2-4 weeks
3. **Adjust Gradually**: Increase rates based on results
4. **Set Reasonable Caps**: Use maximum limits to control costs

### Security Considerations
1. **Rate Limits**: System enforces 0-10% maximum rate
2. **Amount Validation**: All inputs are validated and sanitized
3. **State Management**: Rewards configuration is persisted securely
4. **Error Handling**: Invalid configurations use safe defaults

### Monitoring Recommendations
Track these metrics to optimize your reward program:

- **Reward Distribution Rate**: Percentage of customers claiming rewards
- **Average Reward Amount**: Actual sats distributed per transaction
- **Customer Retention**: Repeat visit frequency
- **Transaction Amount Growth**: Impact on purchase sizes
- **Total Reward Costs**: Monthly reward expenses

## Advanced Configuration

### Runtime Configuration Changes
Merchants can adjust settings through the Profile screen without restarting the app:

1. **Navigate**: Profile → Reward Settings
2. **Adjust**: Reward rate, minimum/maximum amounts
3. **Save**: Settings persist immediately
4. **Test**: Verify changes with small transactions

### Environment vs. Runtime Settings
- **Environment Variables**: Set initial defaults and limits
- **Runtime Settings**: Allow merchant customization within limits
- **Priority**: Runtime settings override environment defaults
- **Persistence**: Runtime changes are saved to device storage

## Troubleshooting

### Common Issues

#### "Rewards system is currently disabled"
- **Cause**: `REWARDS_ENABLED=false` or disabled in Profile
- **Solution**: Set `REWARDS_ENABLED=true` or enable in Profile settings

#### "Reward rate must be between 0% and 10%"
- **Cause**: Invalid `DEFAULT_REWARD_RATE` value
- **Solution**: Set value between 0.00 and 0.10

#### "No rewards showing for purchases"
- **Cause**: Environment variables not loaded or invalid
- **Solution**: Verify .env file exists and values are correct

#### "Minimum reward not being applied"
- **Cause**: `MIN_REWARD_SATS` set incorrectly
- **Solution**: Ensure value is positive integer ≥ 1

### Validation Rules

The system automatically enforces these constraints:

- Reward rate: 0% ≤ rate ≤ 10%
- Minimum reward: ≥ 1 sat
- Maximum reward: ≥ minimum reward
- Default reward: ≥ 1 sat
- Boolean values: Only `true` or `false`

### Support Resources

- **Documentation**: `/docs/07-rewards-system.md` (Current system)
- **Testing**: Use small transactions to verify configuration
- **Logs**: Check console for reward calculation details
- **Backup**: Save working configurations before major changes

## Migration from V1

### For Existing Merchants

If upgrading from the fixed 21-sats system:

1. **Preserve Current Behavior**:
   ```bash
   DEFAULT_REWARD_RATE=0.00          # Disable percentage rewards
   STANDALONE_REWARD_SATS=21         # Keep existing fixed amount
   ```

2. **Gradual Transition**:
   ```bash
   DEFAULT_REWARD_RATE=0.01          # Start with 1%
   STANDALONE_REWARD_SATS=21         # Keep existing for consistency
   ```

3. **Full Migration**:
   ```bash
   DEFAULT_REWARD_RATE=0.02          # 2% purchase-based
   STANDALONE_REWARD_SATS=10         # Reduced since purchase rewards available
   ```

### Compatibility Notes

- **Backward Compatibility**: All existing flashcard flows continue working
- **Default Fallback**: Invalid configurations use safe system defaults
- **Zero Configuration**: System works without any environment variables
- **Gradual Adoption**: Merchants can adopt new features at their own pace 