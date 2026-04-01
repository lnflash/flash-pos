# Flash POS ⚡

A React Native point-of-sale app for Bitcoin Lightning Network payments with NFC flashcard integration.

<p align="center">
  <img src="docs/screenshots/keypad.png" width="200" alt="Keypad Screen" />
  <img src="docs/screenshots/invoice.png" width="200" alt="Invoice QR Code" />
  <img src="docs/screenshots/success.png" width="200" alt="Payment Success" />
</p>

## Features

- ⚡ **Lightning Payments** — Accept Bitcoin via Lightning Network
- 💳 **NFC Flashcards** — Tap-to-pay with Cashu NFC cards
- 🎁 **Rewards System** — Automated customer loyalty rewards
- 🧾 **Receipt Printing** — Silent thermal printer support
- 📱 **Cross-platform** — iOS and Android from single codebase
- 💱 **Multi-currency** — Real-time fiat conversion

## Quick Start

### Prerequisites

| Tool | Version | Install Guide |
|------|---------|---------------|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org/) |
| Yarn | Latest | `npm install -g yarn` |
| Xcode | Latest | Mac App Store (iOS only) |
| Android Studio | Latest | [developer.android.com](https://developer.android.com/studio) |

### Installation

```bash
# Clone the repo
git clone https://github.com/lnflash/flash-pos.git
cd flash-pos

# Install dependencies
yarn install

# iOS only: Install CocoaPods
cd ios && pod install && cd ..

# Copy environment config
cp .env.example .env
# Edit .env with your API endpoints
```

### Running the App

```bash
# Start Metro bundler
yarn start

# Run on Android
yarn android

# Run on iOS
yarn ios
```

## Screenshots

| Keypad | Invoice | Success | Rewards |
|--------|---------|---------|---------|
| ![Keypad](docs/screenshots/keypad.png) | ![Invoice](docs/screenshots/invoice.png) | ![Success](docs/screenshots/success.png) | ![Rewards](docs/screenshots/rewards.png) |

| Transaction History | Settings | NFC Tap |
|---------------------|----------|---------|
| ![History](docs/screenshots/history.png) | ![Settings](docs/screenshots/settings.png) | ![NFC](docs/screenshots/nfc.png) |

## Supported Hardware

### NFC Cards

| Card Type | Status | Notes |
|-----------|--------|-------|
| Cashu JavaCard (Feitian 3.0.4) | ✅ Supported | Recommended |
| Cashu JavaCard (NXP JCOP4) | ✅ Supported | Premium option |
| BoltCard (NTAG 424 DNA) | ⚠️ Planned | Coming soon |

### Receipt Printers

| Printer | Connection | Status |
|---------|------------|--------|
| Epson TM-T20III | USB/Network | ✅ Tested |
| Star Micronics TSP143 | Bluetooth | ✅ Tested |
| Generic ESC/POS | Bluetooth | ✅ Compatible |
| Sunmi Built-in | Native | ✅ Supported |

### Devices

| Device | Status | Notes |
|--------|--------|-------|
| Sunmi V2s | ✅ Recommended | Built-in printer + NFC |
| Sunmi V2 Pro | ✅ Supported | Built-in printer + NFC |
| Android phones (NFC) | ✅ Supported | Requires external printer |
| iPhone (NFC) | ✅ Supported | Requires external printer |

## Environment Configuration

Create a `.env` file based on `.env.example`:

```bash
# API Endpoints
FLASH_GRAPHQL_URI=https://api.flashapp.me/graphql
FLASH_GRAPHQL_WS_URI=wss://api.flashapp.me/graphql

# BTCPay Server (for rewards)
BTC_PAY_SERVER=https://btcpay.your-server.com
PULL_PAYMENT_ID=your-pull-payment-id

# Rewards Configuration
REWARDS_ENABLED=true
DEFAULT_REWARD_RATE=0.02
```

See [Environment Configuration](docs/environment-configuration.md) for all options.

## Documentation

| Document | Description |
|----------|-------------|
| [Project Overview](docs/01-project-overview.md) | High-level architecture |
| [Development Setup](docs/02-development-setup.md) | Detailed setup guide |
| [Architecture](docs/03-architecture.md) | Technical design |
| [API Integration](docs/04-api-integration.md) | GraphQL & APIs |
| [Screens & Navigation](docs/05-screens-navigation.md) | UI documentation |
| [NFC Integration](docs/06-nfc-integration.md) | Flashcard implementation |
| [Rewards System](docs/07-rewards-system.md) | Loyalty features |
| [Printing](docs/08-printing-system.md) | Receipt printing |
| [State Management](docs/09-state-management.md) | Redux architecture |
| [Testing](docs/10-testing.md) | Test guidelines |
| [Deployment](docs/11-deployment.md) | Build & release |
| [Security](docs/12-security.md) | Security features |

## Contributing

We welcome contributions! Here's how to get started:

### First-time Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/flash-pos.git
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/lnflash/flash-pos.git
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

### Development Workflow

```bash
# Sync with upstream
git fetch upstream
git rebase upstream/main

# Make your changes
# ...

# Run tests
yarn test

# Run linter
yarn lint

# Commit your changes
git commit -m "feat: add your feature"

# Push and create PR
git push origin feature/your-feature-name
```

### Code Style

- **TypeScript**: All new code should be typed
- **Linting**: Run `yarn lint` before committing
- **Formatting**: Prettier is configured, run `yarn format`
- **Commits**: Follow [Conventional Commits](https://www.conventionalcommits.org/)

### Pull Request Guidelines

- [ ] Tests pass (`yarn test`)
- [ ] Linter passes (`yarn lint`)
- [ ] TypeScript compiles without errors
- [ ] Screenshots included for UI changes
- [ ] Documentation updated if needed

## Build & Release

### Android

```bash
# Debug APK
yarn android

# Release APK
yarn apk-android
# Output: android/app/build/outputs/apk/release/app-release.apk

# Release AAB (for Play Store)
yarn aab-android
# Output: android/app/build/outputs/bundle/release/app-release.aab
```

### iOS

Build via Xcode:
1. Open `ios/flash_pos.xcworkspace`
2. Select your signing team
3. Product → Archive

## Troubleshooting

### Metro Bundler Issues

```bash
# Reset cache
npx react-native start --reset-cache
```

### Android Build Failures

```bash
# Clean and rebuild
cd android && ./gradlew clean && cd ..
yarn android
```

### iOS Build Failures

```bash
# Reinstall pods
cd ios && rm -rf Pods Podfile.lock && pod install && cd ..
yarn ios
```

### NFC Not Working

- Ensure NFC is enabled in device settings
- Check app has NFC permissions
- Try removing and re-tapping the card

## Related Projects

- [flash-mobile](https://github.com/lnflash/flash-mobile) — Customer wallet app
- [flash](https://github.com/lnflash/flash) — Backend API
- [cashu-javacard](https://github.com/lnflash/cashu-javacard) — NFC card applet

## License

MIT

---

<p align="center">
  <strong>Built with ⚡ by the Flash team</strong>
  <br>
  <a href="https://flashapp.me">flashapp.me</a>
</p>
