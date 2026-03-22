<p align="center">
  <img src="src/assets/images/flash.png" alt="Flash POS Logo" width="120" />
</p>

<h1 align="center">Flash POS</h1>

<p align="center">
  A Bitcoin Lightning point-of-sale app for merchants.<br/>
  Accept payments via QR code, NFC flashcards, and Lightning invoices.
</p>

<p align="center">
  <a href="https://github.com/lnflash/flash-pos/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"/></a>
  <a href="https://reactnative.dev/"><img src="https://img.shields.io/badge/React%20Native-0.76-blue" alt="React Native"/></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0-blue" alt="TypeScript"/></a>
</p>

---

## What is Flash POS?

Flash POS is a cross-platform (iOS & Android) point-of-sale application built with React Native. It lets merchants accept Bitcoin payments over the Lightning Network with near-instant settlement and minimal fees.

### Key Features

- **Lightning Payments** — Generate QR code invoices for customers to scan and pay instantly
- **NFC Flashcard Support** — Tap-to-pay via NFC-enabled [Cashu](https://cashu.space) flashcards — no customer app required
- **Receipt Printing** — Silent receipt printing via Bluetooth/Wi-Fi thermal printers
- **Rewards System** — Automatic customer loyalty rewards (configurable sats-per-tap via BTCPay Server)
- **Multi-Currency** — Real-time BTC ↔ fiat price conversion (JMD, USD, and more)
- **Transaction History** — Full payment history with search and filtering
- **Merchant Paycodes** — Static payment codes for unattended/self-service setups

## Quick Start

### Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| Node.js | ≥ 18 | [Install](https://nodejs.org/) |
| Yarn | Latest | `npm install -g yarn` |
| Android Studio | Latest | For Android builds — [Setup guide](https://reactnative.dev/docs/environment-setup) |
| Xcode | Latest | For iOS builds (macOS only) |
| JDK | 11+ | Required by Android Studio |

> **Tip:** Follow the official [React Native Environment Setup](https://reactnative.dev/docs/environment-setup) until the "Creating a new application" step.

### 1. Clone & Install

```bash
git clone https://github.com/lnflash/flash-pos.git
cd flash-pos
yarn install
```

### 2. Configure Environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Required variables:

```env
# GraphQL API (Flash backend)
FLASH_GRAPHQL_URI=https://api.flashapp.me/graphql
FLASH_GRAPHQL_WS_URI=wss://api.flashapp.me/graphql

# Lightning address
FLASH_LN_ADDRESS_URL=https://ln.flashapp.me

# BTCPay Server (for rewards)
BTC_PAY_SERVER=https://btcpay.example.com
PULL_PAYMENT_ID=your-pull-payment-id
```

See [`.env.example`](.env.example) for the full list of configurable options.

### 3. Run on Android

```bash
# Start Metro bundler (in one terminal)
yarn start

# Run on Android (in another terminal)
yarn android
```

Requires an Android emulator running or a physical device connected via USB with debugging enabled.

### 4. Run on iOS (macOS only)

```bash
# Install CocoaPods dependencies
cd ios && pod install && cd ..

# Run on iOS simulator
yarn ios
```

### Build Commands

```bash
yarn apk-android      # Build Android APK (release)
yarn aab-android      # Build Android AAB (Play Store)
yarn lint             # Run ESLint
yarn test             # Run Jest tests
```

## Supported Hardware

### NFC Readers (Built-in)
Flash POS uses the device's built-in NFC antenna (available on most modern phones) to read Cashu flashcards. No external reader is required.

| Feature | Status |
|---------|--------|
| Android NFC (NFC-A/B/F) | ✅ Supported |
| iOS NFC (Core NFC) | ✅ Supported |
| Cashu JavaCard flashcards | ✅ Supported ([spec](https://github.com/lnflash/cashu-javacard)) |

### Receipt Printers
The app supports silent printing via the [react-native-print](https://github.com/christopherdro/react-native-print) library.

| Printer Type | Connection | Status |
|-------------|------------|--------|
| ESC/POS thermal printers | Bluetooth | ✅ Supported |
| Star Micronics | Bluetooth/Wi-Fi | ✅ Supported |
| AirPrint compatible | Network | ✅ Supported (iOS) |

## Project Structure

```
flash-pos/
├── src/
│   ├── components/     # Reusable UI components
│   ├── screens/        # Main app screens (Keypad, Invoice, Rewards, etc.)
│   ├── contexts/       # React Context providers (NFC, auth)
│   ├── hooks/          # Custom hooks (usePrint, usePriceConversion)
│   ├── store/          # Redux state management
│   ├── graphql/        # Apollo client, queries, mutations
│   ├── utils/          # Utility functions
│   ├── types/          # TypeScript type definitions
│   └── assets/         # Images, fonts, icons
├── android/            # Android native modules
├── ios/                # iOS native modules
├── docs/               # Detailed documentation (see below)
└── patches/            # Package patches (patch-package)
```

## Documentation

Detailed docs are in the [`docs/`](docs/) folder:

| Document | Description |
|----------|-------------|
| [Project Overview](docs/01-project-overview.md) | What Flash POS does and why |
| [Development Setup](docs/02-development-setup.md) | Full dev environment guide |
| [Architecture](docs/03-architecture.md) | Code structure and patterns |
| [API Integration](docs/04-api-integration.md) | GraphQL backend integration |
| [Screens & Navigation](docs/05-screens-navigation.md) | App screens and flow |
| [NFC Integration](docs/06-nfc-integration.md) | Flashcard NFC protocol |
| [Rewards System](docs/07-rewards-system.md) | BTCPay-based loyalty rewards |
| [Printing System](docs/08-printing-system.md) | Receipt printing setup |
| [State Management](docs/09-state-management.md) | Redux architecture |
| [Testing](docs/10-testing.md) | Test strategy and setup |
| [Deployment](docs/11-deployment.md) | Release builds and store submission |
| [Security](docs/12-security.md) | Security considerations |

## Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create a branch**: `git checkout -b feat/your-feature`
3. **Set up** your dev environment (see [Quick Start](#quick-start))
4. **Make your changes** and test on both Android and iOS
5. **Run linting**: `yarn lint`
6. **Submit a PR** against the `main` branch

### Guidelines

- Follow the existing code style (ESLint + Prettier configured)
- Write TypeScript — no plain JS
- Test on a physical device when touching NFC or printing features
- Add/update docs in `docs/` for new features

### Bounties

Some issues have 💰 bounties funded via [Algora](https://algora.io). Look for issues labeled `💰 bounty` in the [issue tracker](https://github.com/lnflash/flash-pos/issues?q=is%3Aissue+is%3Aopen+label%3A%22%F0%9F%92%B0+bounty%22).

## Related Projects

| Project | Description |
|---------|-------------|
| [Flash](https://github.com/lnflash/flash) | Backend GraphQL API |
| [Flash Mobile](https://github.com/lnflash/flash-mobile) | Customer-facing mobile wallet |
| [Cashu JavaCard](https://github.com/lnflash/cashu-javacard) | NFC flashcard applet |
| [Flash Mint](https://forge.flashapp.me) | Cashu mint (Nutshell 0.18.0) |

## License

See [LICENSE](LICENSE) for details.
