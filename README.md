# Flash POS

Flash POS is a merchant point-of-sale app for accepting Lightning payments and, when explicitly enabled, issuing Flash rewards to customers. It is built for iOS and Android with React Native.

## Tech Stack

- React Native 0.76.6
- TypeScript
- Redux Toolkit and redux-persist
- Apollo Client
- GraphQL and GraphQL WebSocket subscriptions
- React Navigation

## Prerequisites

- Node.js 20 or newer
- Yarn 1.x
- Xcode with iOS Simulator support
- Android Studio with an Android SDK and emulator
- CocoaPods

## Setup

```bash
git clone <repo-url>
cd flash-pos
yarn install
cp .env.example .env
cd ios && pod install && cd ..
```

Fill in `.env` with the correct development or production endpoints before starting the app. See [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) for the full environment reference.

## Environment Configuration

Environment values are loaded through `babel-plugin-dotenv-import` and imported from `@env`. The local `.env` file is gitignored and must not be committed.

Use a development `.env` for local testing and a production `.env` only for release builds. The `REWARDS_ENABLED` flag controls whether reward functionality is active; it defaults to `false` in `.env.example` and should only be enabled for releases where rewards are intentionally supported.

## Scripts

```bash
yarn start          # Start Metro
yarn ios            # Build and run iOS
yarn android        # Build and run Android
yarn test           # Run Jest
yarn typecheck      # Run TypeScript checks
yarn lint           # Run ESLint
yarn aab-android    # Build Android release AAB
yarn apk-android    # Build Android release APK
```

## Architecture

- `src/screens`: screen-level user flows, including keypad, invoices, rewards, profile, and support
- `src/routes`: navigation stacks and tab routing
- `src/store`: Redux Toolkit slices, typed hooks, and persistence configuration
- `src/hooks`: shared app behavior for pricing, printing, NFC, activity state, and API flows
- `src/graphql`: Apollo Client setup, GraphQL queries, and mutations
- `src/services`: platform-backed services such as secure storage and flashcard persistence
- `src/components`: reusable UI elements and feature components

## Native Setup

Some dependencies require native linking. In particular, PIN hashes and flashcard records use `react-native-keychain`, so run `pod install` after dependency changes and rebuild the native app. See [docs/NATIVE_SETUP.md](docs/NATIVE_SETUP.md).

## Release Process

Release signing credentials and generated release artifacts must stay outside git. See [docs/RELEASE.md](docs/RELEASE.md) for signing setup and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) before every release.

## Security Notes

- Rewards are feature-flagged behind `REWARDS_ENABLED`.
- PIN records use PBKDF2-SHA256 and platform secure storage instead of reversible local state.
- Android signing credentials must live in `~/.gradle/gradle.properties` or protected CI secrets, not the repository.
- iOS signing must be managed through Xcode using the correct team and provisioning profile.
- `.env`, keystores, and generated release outputs must never be committed.
