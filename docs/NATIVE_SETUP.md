# Native Setup

## React Native 0.77.1

React Native 0.77.1 requires a full native rebuild after dependencies are
installed. Do not rely on an existing DerivedData, Pods, or Gradle build cache
from the 0.76.x app.

For iOS:

```bash
cd ios
pod install
cd ..
```

For Android, clean and rebuild from a fresh Gradle state:

```bash
cd android
./gradlew clean
cd ..
yarn android
```

This app uses `react-native-svg` 15.15.5 with
`patches/react-native-svg+15.15.5.patch`. The patch updates the RN SVG C++
Yoga API usage from `StyleSizeLength` to `StyleLength`, which is required by
React Native 0.77.1. If an iOS build fails around Hermes, Yoga, or
`react-native-svg`, confirm `yarn install` applied patch-package before
re-running `pod install`.

## react-native-keychain

This app stores PIN hashes and NFC flashcard records in iOS Keychain and Android
Keystore through `react-native-keychain`.

After installing dependencies on a fresh checkout, run the normal native install
step for iOS before building:

```bash
cd ios
pod install
cd ..
```

Android uses React Native autolinking; rebuild the app after `yarn install` so
the native module is included.
