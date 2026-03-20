# Flash POS

> ⚡ A Bitcoin Lightning Point-of-Sale app for merchants — powered by [Flash](https://getflash.io)

Flash POS is a React Native mobile application that enables merchants to accept Bitcoin Lightning payments quickly and privately. Built for the Caribbean and beyond.

## Screenshots

| Payment Screen | Transaction History | Settings |
|---|---|---|
| ![Payment](docs/screenshots/payment.png) | ![History](docs/screenshots/history.png) | ![Settings](docs/screenshots/settings.png) |

> 📸 Screenshots coming soon — see the `/docs/screenshots` folder.

## Features

- ⚡ Accept Bitcoin Lightning payments via QR code
- 💵 USD / local currency display with real-time conversion
- 📋 Full transaction history with search
- 🖨️ Receipt printer support (ESC/POS thermal printers)
- 📲 NFC tap-to-pay support (where available)
- 🔒 Non-custodial — you hold your keys
- 🌐 Works offline for invoicing (pays settle when connected)

## Supported Hardware

### Receipt Printers
- Any ESC/POS compatible thermal printer (Bluetooth or USB)
- Tested with: EPSON TM-T20, Star TSP100, MUNBYN printers
- Connect via Bluetooth settings before launching the app

### NFC Readers
- Android devices with NFC hardware enabled
- iOS devices with NFC entitlement (iPhone 7+)
- Supports Lightning NFC cards (BOLT card compatible)

### Mobile Devices
- Android 8.0+ (API level 26+)
- iOS 13.0+
- Recommended: Any mid-range or better smartphone from 2019 onwards

## Local Development Setup

### Prerequisites

- Node.js 18+ and Yarn
- React Native CLI: `npm install -g @react-native-community/cli`
- For iOS: Xcode 14+ and CocoaPods (`gem install cocoapods`)
- For Android: Android Studio with SDK 33+, Java 11+

### Installation

```bash
# Clone the repository
git clone https://github.com/lnflash/flash-pos.git
cd flash-pos

# Install dependencies
yarn install

# Copy environment config
cp .env.example .env
# Edit .env with your Flash API credentials
```

### iOS

```bash
# Install CocoaPods dependencies
cd ios && pod install && cd ..

# Start Metro bundler
yarn start

# Run on iOS simulator (new terminal)
yarn ios

# Run on physical device
yarn ios --device
```

### Android

```bash
# Start Metro bundler
yarn start

# Run on Android emulator or connected device
yarn android
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```env
FLASH_API_URL=https://api.flashapp.me
FLASH_WS_URL=wss://ws.flashapp.me
# Add your credentials from the Flash developer portal
```

## Getting Started for Contributors

Welcome! We appreciate contributions of all kinds.

1. **Fork** this repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/flash-pos.git`
3. **Create a branch**: `git checkout -b feature/your-feature-name`
4. **Make your changes** and test thoroughly on both iOS and Android
5. **Commit** with a clear message: `git commit -m 'feat: add your feature'`
6. **Push** and open a Pull Request against `main`

Please read [CONTRIBUTING.md](https://github.com/lnflash/.github/blob/main/CONTRIBUTING.md) before submitting.

### Running Tests

```bash
yarn test
yarn lint
```

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation changes
- `chore:` — maintenance tasks

## Bounty Program

This project participates in the Flash Bounty Program. Open issues labeled `💰 bounty` are available for contributors to claim. Payment is in Bitcoin via Lightning on merge.

See [CONTRIBUTING.md](https://github.com/lnflash/.github/blob/main/CONTRIBUTING.md) for details.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Built with ❤️ by the [Flash](https://getflash.io) team and contributors.
