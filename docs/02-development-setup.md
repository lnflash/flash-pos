# Development Setup

## Prerequisites

### System Requirements
- **Node.js**: >= 18.0.0 (specified in package.json engines)
- **React Native CLI**: Latest version
- **Android Studio**: For Android development
- **Xcode**: For iOS development (macOS only)
- **Java Development Kit**: JDK 11 or newer

### Package Manager
This project uses **Yarn** as the package manager. Install dependencies with:
```bash
yarn install
```

## Environment Configuration

### Required Environment Variables

Create a `.env` file in the root directory with the following variables:

```bash
# GraphQL API Endpoints
FLASH_GRAPHQL_URI=https://your-graphql-endpoint/graphql
FLASH_GRAPHQL_WS_URI=wss://your-graphql-endpoint/graphql

# BTCPay Server Configuration
BTC_PAY_SERVER=https://your-btcpay-server
PULL_PAYMENT_ID=your-pull-payment-id

# Additional configuration variables as needed
```

### Environment Variable Usage
Environment variables are imported using `@env` throughout the codebase:

**Files using environment variables:**
- `src/graphql/ApolloClient.ts` - GraphQL endpoints
- `src/screens/Rewards.tsx` - BTCPay Server config
- `src/contexts/Flashcard.tsx` - BTCPay Server config
- `src/screens/Profile.tsx` - Additional config
- `src/screens/Paycode.tsx` - Additional config
- `src/hooks/usePrint.tsx` - Printing config

## Project Structure

```
flash-pos/
├── App.tsx                 # Root application component
├── index.js               # Entry point
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration
├── babel.config.js        # Babel configuration
├── metro.config.js        # Metro bundler configuration
├── jest.config.js         # Jest testing configuration
├── react-native.config.js # React Native configuration
├── .env                   # Environment variables (create this)
├── src/                   # Source code
├── android/               # Android native code
├── ios/                   # iOS native code
├── __tests__/             # Test files
├── patches/               # Package patches
└── docs/                  # Documentation
```

## Development Scripts

### Available Commands
```bash
# Start Metro bundler
yarn start

# Run on Android device/emulator
yarn android

# Run on iOS device/simulator
yarn ios

# Run tests
yarn test

# Lint code
yarn lint

# Build Android APK
yarn apk-android

# Build Android AAB
yarn aab-android

# Apply patches
yarn postinstall
```

## Platform Setup

### Android Development

1. **Install Android Studio** and configure Android SDK
2. **Set up environment variables**:
   ```bash
   export ANDROID_HOME=$HOME/Android/Sdk
   export PATH=$PATH:$ANDROID_HOME/emulator
   export PATH=$PATH:$ANDROID_HOME/tools
   export PATH=$PATH:$ANDROID_HOME/tools/bin
   export PATH=$PATH:$ANDROID_HOME/platform-tools
   ```
3. **Create virtual device** or connect physical device
4. **Run the app**: `yarn android`

### iOS Development (macOS only)

1. **Install Xcode** from Mac App Store
2. **Install CocoaPods**: `sudo gem install cocoapods`
3. **Install iOS dependencies**: `cd ios && pod install`
4. **Run the app**: `yarn ios`

## Dependencies Overview

### Core Dependencies
- **React Native**: 0.76.6 - Core framework
- **TypeScript**: 5.0.4 - Type safety
- **Apollo Client**: 3.12.6 - GraphQL client
- **Redux Toolkit**: 2.5.0 - State management
- **React Navigation**: 7.x - Navigation
- **Styled Components**: 6.1.8 - Styling

### Key Features Dependencies
- **react-native-nfc-manager**: 3.16.1 - NFC functionality
- **react-native-print**: 0.11.0 - Receipt printing
- **react-native-qrcode-svg**: 6.3.14 - QR code generation
- **axios**: 1.7.9 - HTTP requests for BTCPay Server
- **js-lnurl**: 0.6.0 - LNURL protocol support

### Development Dependencies
- **ESLint**: Code linting
- **Jest**: Testing framework
- **Babel**: JavaScript compilation
- **Prettier**: Code formatting
- **Patch Package**: Dependency patching

## Common Setup Issues

### Metro Bundler Issues
```bash
# Clear Metro cache
npx react-native start --reset-cache

# Clean and rebuild
cd android && ./gradlew clean && cd ..
cd ios && xcodebuild clean && cd ..
```

### Node Modules Issues
```bash
# Clean install
rm -rf node_modules yarn.lock
yarn install
```

### Android Build Issues
```bash
# Clean Android build
cd android && ./gradlew clean && cd ..
yarn android
```

### iOS Build Issues
```bash
# Clean iOS build
cd ios && xcodebuild clean && cd ..
cd ios && pod install && cd ..
yarn ios
```

## Development Workflow

### 1. Environment Setup
- Clone repository
- Install dependencies: `yarn install`
- Configure environment variables
- Set up platform tools

### 2. Development
- Start Metro: `yarn start`
- Run on device: `yarn android` or `yarn ios`
- Make changes and see live reload

### 3. Testing
- Run tests: `yarn test`
- Run linter: `yarn lint`
- Test on multiple devices

### 4. Build
- Test builds: `yarn apk-android` or build via Xcode
- Verify all features work in production builds

## IDE Configuration

### VS Code Extensions (Recommended)
- React Native Tools
- TypeScript Importer
- ESLint
- Prettier
- GraphQL
- GitLens

### TypeScript Configuration
The project includes comprehensive TypeScript configuration in `tsconfig.json` with strict type checking enabled.

## Next Steps

After setup, review:
1. [Architecture Documentation](./03-architecture.md)
2. [API Integration Guide](./04-api-integration.md)
3. [Screens & Navigation](./05-screens-navigation.md)