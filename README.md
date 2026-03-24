<p align="center">
  <img src="src/assets/images/flashcard.png" alt="Flash POS Logo" width="120" />
</p>

<h1 align="center">Flash POS</h1>

<p align="center">
  A mobile point-of-sale app for <strong>Bitcoin Lightning</strong> payments with NFC flashcard support.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React%20Native-0.76-blue" alt="React Native" />
  <img src="https://img.shields.io/badge/TypeScript-5.0-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Platform-Android%20%7C%20iOS-green" alt="Platform" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License" />
</p>

---

## What is Flash POS?

Flash POS is a **React Native point-of-sale application** for merchants who want to accept **Bitcoin Lightning payments**. Customers can pay by scanning a QR code or tapping an **NFC flashcard** — no app download required on the customer side.

**Key capabilities:**

- ⚡ Lightning Network payments (fast, low-fee Bitcoin transactions)
- 📱 NFC flashcard tap-to-pay and tap-to-receive
- 🖨️ Silent receipt printing with QR codes (Android & iOS native modules)
- 🎁 Built-in customer rewards system (21 sats per flashcard tap)
- 💱 Real-time BTC-to-fiat price conversion with multi-currency support
- 📊 Transaction history and merchant profile management

---

## Screenshots

| Keypad (POS) | Invoice QR | Payment Success |
|:---:|:---:|:---:|
| _Enter amount and create invoice_ | _Customer scans to pay_ | _Confirmation with receipt_ |

| Rewards | NFC Balance | Transaction History |
|:---:|:---:|:---:|
| _Earn sats on flashcard taps_ | _Check flashcard balance via NFC_ | _View recent payments_ |

> **Note:** To capture screenshots, run the app on an emulator/simulator and add them to a `screenshots/` directory.

---

## Getting Started

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | ≥ 18.0.0 | [Install](https://nodejs.org) |
| **Yarn** | Latest | `npm install -g yarn` |
| **React Native CLI** | Latest | `npm install -g react-native-cli` |
| **Android Studio** | Latest | For Android development |
| **Xcode** | Latest | For iOS (macOS only) |
| **JDK** | 11+ | Required for Android builds |

### 1. Clone & Install

```bash
git clone https://github.com/lnflash/flash-pos.git
cd flash-pos
yarn install
```

### 2. Configure Environment

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

**Required variables** (see `.env.example` for full list):

```bash
# GraphQL API
FLASH_GRAPHQL_URI=https://api.your-server.com/graphql
FLASH_GRAPHQL_WS_URI=wss://api.your-server.com/graphql

# BTCPay Server (for rewards)
BTC_PAY_SERVER=https://btcpay.your-server.com
PULL_PAYMENT_ID=your-pull-payment-id

# Lightning
FLASH_LN_ADDRESS=your-domain.com
```

### 3. Run the App

Start Metro bundler in one terminal:

```bash
yarn start
```

Then in a second terminal:

**Android:**
```bash
yarn android
```

**iOS (macOS only):**
```bash
cd ios && pod install && cd ..
yarn ios
```

---

## Supported Hardware

| Category | Details |
|---|---|
| **NFC** | Android devices with NFC hardware. iOS devices with Core NFC support (iPhone 7+). Requires NFC-enabled flashcards (JavaCard-based). |
| **Receipt Printers** | Native Android/iOS printing modules. Supports silent (no-dialog) printing. Works with system-compatible thermal printers via platform print APIs. |
| **QR Scanning** | Camera-based QR code scanning for Lightning invoices (device camera required). |

---

## How Payments Work

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  1. Keypad   │────▶│  2. Invoice  │────▶│  3. Payment  │────▶│  4. Success  │
│              │     │              │     │              │     │              │
│ Enter amount │     │ QR generated │     │ Customer     │     │ Receipt      │
│ in fiat/BTC  │     │ displayed    │     │ pays via     │     │ printed      │
│              │     │              │     │ QR or NFC    │     │ (optional)   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### NFC Flashcard Flow

1. **Tap to Pay** — Customer taps their NFC flashcard on the merchant's phone. The card's LNURL-withdraw link is read and a Lightning invoice is generated and paid automatically.
2. **Tap to Check Balance** — Merchant taps a flashcard to view the card's current Bitcoin balance and recent activity.
3. **Tap to Receive** — Customer taps to receive rewards (21 sats per qualifying tap).

---

## App Structure

```
flash-pos/
├── src/
│   ├── screens/          # Main screens (Keypad, Invoice, Rewards, Profile, etc.)
│   ├── components/       # Reusable UI components
│   ├── hooks/            # Custom hooks (useNfc, usePrint, useRealTimePrice)
│   ├── store/            # Redux Toolkit state management
│   ├── graphql/          # Apollo Client, queries, mutations, subscriptions
│   ├── contexts/         # React Context providers (Flashcard NFC, ActivityIndicator)
│   ├── utils/            # Utility functions and toast config
│   ├── types/            # TypeScript type definitions
│   └── assets/           # Images, fonts, icons
├── android/              # Android native code (includes PrinterModule)
├── ios/                  # iOS native code
├── docs/                 # Detailed documentation
└── __tests__/            # Test files
```

### Key Screens

| Screen | Tab | Purpose |
|---|---|---|
| **Keypad** | POS | Enter payment amounts, select currency, create invoices |
| **Rewards** | Rewards | View earned rewards, claim via BTCPay Server |
| **Paycode** | Paycode | Generate static merchant QR codes |
| **Profile** | Settings | Account settings, event mode, support chat |
| **Invoice** | — | Lightning invoice QR display |
| **TransactionHistory** | — | View past payments |

---

## Development

### Available Scripts

```bash
yarn start          # Start Metro bundler
yarn android        # Run on Android device/emulator
yarn ios            # Run on iOS simulator (macOS only)
yarn test           # Run Jest tests
yarn lint           # Run ESLint
yarn apk-android    # Build Android APK
yarn aab-android    # Build Android AAB (for Play Store)
```

### Common Issues

**Metro bundler cache issues:**
```bash
npx react-native start --reset-cache
```

**Android build failures:**
```bash
cd android && ./gradlew clean && cd ..
yarn android
```

**iOS build failures:**
```bash
cd ios && xcodebuild clean && pod install && cd ..
yarn ios
```

**Dependency issues:**
```bash
rm -rf node_modules yarn.lock
yarn install
```

### Tech Stack

- **React Native** 0.76 — Cross-platform mobile framework
- **TypeScript** 5.0 — Type-safe development
- **Apollo Client** — GraphQL with WebSocket subscriptions
- **Redux Toolkit** — State management with persistence
- **React Navigation** v7 — Stack + tab navigation
- **Styled Components** — Theming and styling
- **react-native-nfc-manager** — NFC hardware access

---

## Contributing

We welcome contributions! Please read our [Contributing Guide](https://github.com/lnflash/.github/blob/main/CONTRIBUTING.md) before submitting a PR.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test thoroughly
4. Submit a pull request referencing the relevant issue

---

## Documentation

For detailed technical documentation, see the [`docs/`](docs/) folder:

- [Project Overview](docs/01-project-overview.md)
- [Development Setup](docs/02-development-setup.md)
- [Architecture](docs/03-architecture.md)
- [API Integration](docs/04-api-integration.md)
- [Screens & Navigation](docs/05-screens-navigation.md)
- [NFC Integration](docs/06-nfc-integration.md)
- [Rewards System](docs/07-rewards-system.md)
- [Printing System](docs/08-printing-system.md)
- [State Management](docs/09-state-management.md)
- [Testing](docs/10-testing.md)
- [Deployment](docs/11-deployment.md)
- [Security](docs/12-security.md)

---

## License

This project is private and maintained by [Flash](https://github.com/lnflash).
