# Environment Configuration Guide

## Overview

This guide provides a complete reference for configuring your Flash POS `.env` file, including all settings for the Event Mode Phase 1 implementation.

## Complete .env Template

Create a `.env` file in your project root with the following configuration:

```bash
# ===================================
# CORE API CONFIGURATION
# ===================================

# GraphQL API endpoints
FLASH_GRAPHQL_URI=https://api.your-server.com/graphql
FLASH_GRAPHQL_WS_URI=wss://api.your-server.com/graphql

# Lightning Network configuration
FLASH_LN_ADDRESS_URL=https://ln.your-server.com
FLASH_LN_ADDRESS=your-domain.com

# BTCPay Server configuration
BTC_PAY_SERVER=https://btcpay.your-server.com

# ===================================
# REWARD SYSTEM CONFIGURATION
# ===================================

# Default Pull Payment ID from BTCPay Server
# This is the main reward pool ID
PULL_PAYMENT_ID=your-pull-payment-id-here

# Reward calculation settings
DEFAULT_REWARD_RATE=0.02              # 2% of purchase amount
MIN_REWARD_SATS=10                    # Minimum 10 sats per reward
MAX_REWARD_SATS=50000                 # Maximum 50,000 sats per reward
STANDALONE_REWARD_SATS=21             # Fixed 21 sats for NFC tap rewards

# Global rewards toggle
REWARDS_ENABLED=true                  # Enable/disable entire rewards system

# ===================================
# EVENT MODE CONFIGURATION (PHASE 1)
# ===================================

# Event Mode Feature Toggle
EVENT_MODE_ENABLED=false              # Set to true to enable Event Mode feature

# Default Event Settings
DEFAULT_EVENT_REWARD_LIMIT=10000      # Total sats to give away during event
DEFAULT_EVENT_REWARD_RATE=0.05        # 5% reward rate during events
DEFAULT_EVENT_CUSTOMER_LIMIT=100      # Maximum customers who can participate
DEFAULT_EVENT_MERCHANT_REWARD_ID=     # Optional: Event-specific Pull Payment ID

# Customer Tracking & Limits
EVENT_CUSTOMER_REWARD_LIMIT=1         # Max rewards per individual customer
EVENT_UNIQUE_CUSTOMERS_ONLY=true      # Only count unique customers toward limit
EVENT_TRACK_BY=flashcard              # Customer identification method

# Transaction Filters
EVENT_MIN_PURCHASE_AMOUNT=500         # Minimum purchase to qualify (in sats)
EVENT_ALLOWED_PAYMENT_METHODS=all     # Comma-separated: all,lightning,cash,card
EVENT_EXCLUDE_REFUNDS=true            # Don't give rewards for refunded transactions

# Budget Controls
EVENT_BUDGET_SATS=100000              # Total budget for event rewards
EVENT_STOP_ON_BUDGET_EXCEED=true      # Auto-deactivate when budget exhausted
EVENT_BUDGET_WARNING_PERCENT=80       # Show warning at this percentage (0-100)

# Display Settings
EVENT_DISPLAY_NAME=Special Event      # Customer-facing event name
EVENT_DISPLAY_MESSAGE=Earn extra rewards today!  # Promotional message
EVENT_SHOW_PROGRESS=true              # Show progress bars in Event Settings
```

## Configuration Reference

### Core API Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `FLASH_GRAPHQL_URI` | GraphQL API endpoint | `https://api.example.com/graphql` |
| `FLASH_GRAPHQL_WS_URI` | WebSocket endpoint for subscriptions | `wss://api.example.com/graphql` |
| `FLASH_LN_ADDRESS_URL` | Lightning address server | `https://ln.example.com` |
| `FLASH_LN_ADDRESS` | Domain for Lightning addresses | `example.com` |
| `BTC_PAY_SERVER` | BTCPay Server instance URL | `https://btcpay.example.com` |

### Reward System Settings

| Variable | Description | Default | Valid Range |
|----------|-------------|---------|-------------|
| `PULL_PAYMENT_ID` | BTCPay Pull Payment ID | Required | Valid BTCPay ID |
| `DEFAULT_REWARD_RATE` | Percentage as decimal | `0.02` | 0.0 - 0.1 |
| `MIN_REWARD_SATS` | Minimum reward amount | `10` | 1 - 50000 |
| `MAX_REWARD_SATS` | Maximum reward amount | `50000` | 1 - 1000000 |
| `STANDALONE_REWARD_SATS` | Fixed NFC tap reward | `21` | 1 - 1000 |
| `REWARDS_ENABLED` | Enable rewards globally | `true` | true/false |

### Event Mode Settings

| Variable | Description | Default | Notes |
|----------|-------------|---------|-------|
| `EVENT_MODE_ENABLED` | Enable Event Mode feature | `false` | Requires app restart |
| `DEFAULT_EVENT_REWARD_LIMIT` | Total event budget | `10000` | In satoshis |
| `DEFAULT_EVENT_REWARD_RATE` | Event reward percentage | `0.05` | 5% default |
| `DEFAULT_EVENT_CUSTOMER_LIMIT` | Max participants | `100` | 1 - 10000 |
| `DEFAULT_EVENT_MERCHANT_REWARD_ID` | Event-specific pool | Empty | Optional override |

### Customer Tracking Settings

| Variable | Description | Default | Options |
|----------|-------------|---------|---------|
| `EVENT_CUSTOMER_REWARD_LIMIT` | Per-customer limit | `1` | Any positive integer |
| `EVENT_UNIQUE_CUSTOMERS_ONLY` | Track unique customers | `true` | true/false |
| `EVENT_TRACK_BY` | Identification method | `flashcard` | flashcard only (Phase 1) |

### Transaction Filter Settings

| Variable | Description | Default | Notes |
|----------|-------------|---------|-------|
| `EVENT_MIN_PURCHASE_AMOUNT` | Minimum purchase | `500` | In satoshis |
| `EVENT_ALLOWED_PAYMENT_METHODS` | Allowed methods | `all` | all, lightning, cash, card |
| `EVENT_EXCLUDE_REFUNDS` | Exclude refunds | `true` | true/false |

### Budget Control Settings

| Variable | Description | Default | Notes |
|----------|-------------|---------|-------|
| `EVENT_BUDGET_SATS` | Total event budget | `100000` | Enforced limit |
| `EVENT_STOP_ON_BUDGET_EXCEED` | Auto-deactivate | `true` | Safety feature |
| `EVENT_BUDGET_WARNING_PERCENT` | Warning threshold | `80` | 0-100 |

### Display Settings

| Variable | Description | Default | Max Length |
|----------|-------------|---------|------------|
| `EVENT_DISPLAY_NAME` | Event title | `Special Event` | 50 chars |
| `EVENT_DISPLAY_MESSAGE` | Promotional text | `Earn extra rewards today!` | 100 chars |
| `EVENT_SHOW_PROGRESS` | Show progress bars | `true` | true/false |

## Example Configurations

### Standard Retail Setup
```bash
# Basic 2% rewards on all purchases
DEFAULT_REWARD_RATE=0.02
MIN_REWARD_SATS=10
MAX_REWARD_SATS=1000
STANDALONE_REWARD_SATS=21
EVENT_MODE_ENABLED=false
```

### Coffee Shop with Events
```bash
# 1% regular rewards, events for promotions
DEFAULT_REWARD_RATE=0.01
MIN_REWARD_SATS=5
MAX_REWARD_SATS=500
STANDALONE_REWARD_SATS=10
EVENT_MODE_ENABLED=true
DEFAULT_EVENT_REWARD_RATE=0.03
EVENT_MIN_PURCHASE_AMOUNT=2000  # ~$2 minimum
```

### High-Value Merchant
```bash
# Higher limits for luxury goods
DEFAULT_REWARD_RATE=0.005
MIN_REWARD_SATS=100
MAX_REWARD_SATS=50000
EVENT_MODE_ENABLED=true
DEFAULT_EVENT_REWARD_RATE=0.02
EVENT_MIN_PURCHASE_AMOUNT=10000
EVENT_BUDGET_SATS=1000000
```

## Security Notes

1. **Never commit `.env` to version control** - Add to `.gitignore`
2. **Use strong Pull Payment IDs** - Test before production
3. **Set appropriate limits** - Prevent budget overruns
4. **Monitor event progress** - Check regularly during events
5. **Secure your device** - PIN protect admin access

## Troubleshooting

### Common Issues

**Event Mode not appearing:**
- Ensure `EVENT_MODE_ENABLED=true`
- Restart the app after changing
- Check for typos in boolean values

**Rewards not working:**
- Verify `PULL_PAYMENT_ID` is valid
- Ensure `REWARDS_ENABLED=true`
- Check BTCPay Server connection

**Budget warnings not showing:**
- Verify `EVENT_BUDGET_WARNING_PERCENT` is 0-100
- Check `EVENT_SHOW_PROGRESS=true`

### Validation Rules

- Percentages: Use decimals (0.02 = 2%)
- Amounts: Always in satoshis
- Booleans: Lowercase only (true/false)
- IDs: Alphanumeric with hyphens/underscores

## Migration from Previous Versions

If upgrading from a version without Event Mode:

1. Add all `EVENT_*` variables to your `.env`
2. Set `EVENT_MODE_ENABLED=false` initially
3. Test in development first
4. Enable when ready to use events

## Best Practices

1. **Start Conservative**: Use default values initially
2. **Test Thoroughly**: Verify settings in development
3. **Document Events**: Keep records of special promotions
4. **Regular Reviews**: Update limits based on usage
5. **Backup Configuration**: Keep secure copy of settings 