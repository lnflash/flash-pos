# Flash POS

Flash POS is a React Native point-of-sale app for accepting Lightning payments and managing Flash merchant workflows on Android and iOS.

## Getting Started

### Prerequisites

- Node.js 18 or newer
- Yarn
- React Native development environment
- Android Studio and Android SDK for Android builds
- Xcode and CocoaPods for iOS builds (macOS only)
- A configured Flash GraphQL API endpoint

Follow the official React Native environment guide before running the app locally:

- https://reactnative.dev/docs/environment-setup

### 1. Install dependencies

```bash
yarn install
```

For iOS, install CocoaPods dependencies after installing JavaScript packages:

```bash
cd ios
pod install
cd ..
```

### 2. Configure environment variables

Copy the example environment file and fill in the values for your Flash backend and BTCPay setup:

```bash
cp .env.example .env
```

Common variables include:

```bash
FLASH_GRAPHQL_URI=https://your-graphql-endpoint/graphql
FLASH_GRAPHQL_WS_URI=wss://your-graphql-endpoint/graphql
BTC_PAY_SERVER=https://your-btcpay-server
PULL_PAYMENT_ID=your-pull-payment-id
```

See [`docs/02-development-setup.md`](docs/02-development-setup.md) and [`docs/environment-configuration.md`](docs/environment-configuration.md) for more detail.

### 3. Start Metro

```bash
yarn start
```

Keep Metro running in its own terminal while you build the app.

### 4. Run the app

Android:

```bash
yarn android
```

iOS:

```bash
yarn ios
```

You can also run the native projects directly from Android Studio or Xcode.

## Main Screens

The app includes screens for payment entry, payment confirmation, transaction history, merchant profile/settings, rewards, NFC reward cards, and printable paycodes.

### Payment

Use the keypad/payment flow to enter a sale amount, generate or pay a Lightning invoice, and confirm successful payment.

Suggested screenshot for maintainers:

```markdown
![Payment screen](docs/screenshots/payment.png)
```

### Transaction History

The transaction history screen helps merchants review completed payments and reward activity.

Suggested screenshot for maintainers:

```markdown
![Transaction history](docs/screenshots/transaction-history.png)
```

### Settings and Profile

Profile, event settings, and rewards settings screens are used to configure merchant/event behavior and reward options.

Suggested screenshot for maintainers:

```markdown
![Settings screen](docs/screenshots/settings.png)
```

> Screenshot note: this repository does not currently include committed screenshots. Add device screenshots under `docs/screenshots/` with the filenames above to make the image links live.

## Supported Hardware

Flash POS depends on the capabilities of the Android/iOS device and configured native modules.

### Android

- Android phone or tablet with Google/Android SDK-compatible build target
- Optional NFC hardware for reward-card flows using `react-native-nfc-manager`
- Optional receipt printer support through the app's native printer module and `react-native-print`

### iOS

- iPhone or iPad supported by the React Native/iOS build target
- Optional NFC support on devices that expose compatible Core NFC behavior
- Optional AirPrint-compatible receipt/document printing through `react-native-print`

### Printers and NFC readers

Printer and NFC support can vary by operating system, device model, and native module configuration. Before deploying to a venue, test the exact device, printer, NFC card, and network combination that will be used in production.

Related docs:

- [`docs/06-nfc-integration.md`](docs/06-nfc-integration.md)
- [`docs/08-printing-system.md`](docs/08-printing-system.md)

## Contributor Quick Start

1. Fork and clone the repository.
2. Install dependencies with `yarn install`.
3. Copy `.env.example` to `.env` and configure local endpoints.
4. Start Metro with `yarn start`.
5. Run `yarn android` or `yarn ios`.
6. Before opening a pull request, run:

```bash
yarn lint
yarn test
```

Useful documentation:

- [`docs/README.md`](docs/README.md)
- [`docs/01-project-overview.md`](docs/01-project-overview.md)
- [`docs/02-development-setup.md`](docs/02-development-setup.md)
- [`docs/03-architecture.md`](docs/03-architecture.md)

## Development Scripts

```bash
yarn start          # Start Metro
yarn android        # Run Android app
yarn ios            # Run iOS app
yarn test           # Run Jest tests
yarn lint           # Run ESLint
yarn apk-android    # Build Android APK
yarn aab-android    # Build Android App Bundle
```

## Troubleshooting

Clear Metro cache:

```bash
npx react-native start --reset-cache
```

Clean Android build:

```bash
cd android
./gradlew clean
cd ..
yarn android
```

Refresh iOS pods:

```bash
cd ios
pod install
cd ..
yarn ios
```

If setup still fails, compare your local environment with the prerequisites in [`docs/02-development-setup.md`](docs/02-development-setup.md).
