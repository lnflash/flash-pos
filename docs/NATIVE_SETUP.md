# Native Setup

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
