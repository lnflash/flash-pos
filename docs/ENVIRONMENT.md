# Environment Configuration

Flash POS reads build-time environment values from `.env` through `babel-plugin-dotenv-import`. Code imports these values from `@env`.

## Local Setup

```bash
cp .env.example .env
```

`.env` is gitignored and must not be committed. Use environment-specific values for development, staging, and production, and keep production values out of local branches unless they are required for a release build.

## Variables

| Variable | Purpose |
| --- | --- |
| `FLASH_GRAPHQL_URI` | HTTPS GraphQL endpoint used by Apollo Client. |
| `FLASH_GRAPHQL_WS_URI` | WebSocket GraphQL endpoint used for subscriptions. |
| `FLASH_LN_ADDRESS_URL` | Lightning address service base URL. |
| `FLASH_LN_ADDRESS` | Lightning address domain displayed or embedded by the app. |
| `BTC_PAY_SERVER` | BTCPay Server base URL for reward-related flows. |
| `PULL_PAYMENT_ID` | Default BTCPay pull payment ID for rewards. |
| `DEFAULT_REWARD_RATE` | Default reward percentage as a decimal, such as `0.02` for 2%. |
| `MIN_REWARD_SATS` | Minimum reward amount in sats. |
| `MAX_REWARD_SATS` | Maximum reward amount in sats. |
| `STANDALONE_REWARD_SATS` | Fixed reward amount for standalone NFC tap rewards. |
| `REWARDS_ENABLED` | Global rewards flag. Defaults to `false`; set to `true` only when reward functionality should be active. |
| `EVENT_MODE_ENABLED` | Enables event-mode reward configuration. |
| `DEFAULT_EVENT_REWARD_LIMIT` | Default total event reward limit in sats. |
| `DEFAULT_EVENT_REWARD_RATE` | Event reward percentage as a decimal. |
| `DEFAULT_EVENT_CUSTOMER_LIMIT` | Default maximum number of event customers. |
| `DEFAULT_EVENT_MERCHANT_REWARD_ID` | Optional event-specific BTCPay pull payment ID. |
| `EVENT_CUSTOMER_REWARD_LIMIT` | Maximum rewards per customer during an event. |
| `EVENT_UNIQUE_CUSTOMERS_ONLY` | Whether event accounting should count unique customers only. |
| `EVENT_TRACK_BY` | Customer tracking method for event rewards. |
| `EVENT_MIN_PURCHASE_AMOUNT` | Minimum qualifying event purchase amount in sats. |
| `EVENT_ALLOWED_PAYMENT_METHODS` | Allowed event payment methods, or `all`. |
| `EVENT_EXCLUDE_REFUNDS` | Whether refunds are excluded from event rewards. |
| `EVENT_BUDGET_SATS` | Event budget cap in sats. |
| `EVENT_STOP_ON_BUDGET_EXCEED` | Whether to stop event rewards when the budget is exceeded. |
| `EVENT_BUDGET_WARNING_PERCENT` | Budget warning threshold from 0 to 100. |
| `EVENT_DISPLAY_NAME` | Event name shown in app UI. |
| `EVENT_DISPLAY_MESSAGE` | Event message shown in app UI. |
| `EVENT_SHOW_PROGRESS` | Whether event progress indicators are shown. |
| `DEBUG_MODE` | Debug behavior flag. Must be `false` for production releases. |

## Release Notes

- Keep `REWARDS_ENABLED=false` unless the release intentionally supports rewards.
- Keep `DEBUG_MODE=false` for production.
- Verify all API and WebSocket endpoints point at the intended target environment before building a release.
- See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for pre-release validation.
