# Deployment

## Overview

Flash POS deployment involves building native Android and iOS applications with proper configuration, signing, and distribution setup. This guide covers the complete deployment process from development to production.

## Build Configuration

### Environment Setup

**Production Environment Variables** (`.env.production`):
```bash
# Production GraphQL endpoints
FLASH_GRAPHQL_URI=https://api-prod.flash.com/graphql
FLASH_GRAPHQL_WS_URI=wss://api-prod.flash.com/graphql

# Production BTCPay Server
BTC_PAY_SERVER=https://btcpay-prod.flash.com
PULL_PAYMENT_ID=prod-pull-payment-id

# Production configuration
NODE_ENV=production
DEBUG=false
```

**Staging Environment Variables** (`.env.staging`):
```bash
# Staging GraphQL endpoints
FLASH_GRAPHQL_URI=https://api-staging.flash.com/graphql
FLASH_GRAPHQL_WS_URI=wss://api-staging.flash.com/graphql

# Staging BTCPay Server
BTC_PAY_SERVER=https://btcpay-staging.flash.com
PULL_PAYMENT_ID=staging-pull-payment-id

# Staging configuration
NODE_ENV=staging
DEBUG=true
```

### Build Scripts

**Package.json Build Commands**:
```json
{
  "scripts": {
    "android": "react-native run-android",
    "ios": "react-native run-ios",
    "aab-android": "cd android && ./gradlew bundleRelease && cd ..",
    "apk-android": "cd android && ./gradlew app:assembleRelease && cd ..",
    "build:ios": "cd ios && xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Release -sdk iphoneos",
    "build:android:staging": "cd android && ./gradlew assembleStaging && cd ..",
    "build:android:production": "cd android && ./gradlew assembleRelease && cd ..",
    "postinstall": "patch-package"
  }
}
```

## Android Deployment

### Gradle Configuration

**android/app/build.gradle**:
```gradle
android {
    compileSdkVersion rootProject.ext.compileSdkVersion

    defaultConfig {
        applicationId "com.flash_pos"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        multiDexEnabled true
    }

    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (project.hasProperty('FLASH_UPLOAD_STORE_FILE')) {
                storeFile file(FLASH_UPLOAD_STORE_FILE)
                storePassword FLASH_UPLOAD_STORE_PASSWORD
                keyAlias FLASH_UPLOAD_KEY_ALIAS
                keyPassword FLASH_UPLOAD_KEY_PASSWORD
            }
        }
    }

    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.release
            minifyEnabled enableProguardInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
        staging {
            initWith release
            applicationIdSuffix '.staging'
            versionNameSuffix '-staging'
        }
    }
}
```

### Keystore Setup

**Generate Production Keystore**:
```bash
# Generate production keystore
keytool -genkeypair -v -storetype PKCS12 -keystore flash_pos-upload-key.keystore -alias flash_pos-upload-key -keyalg RSA -keysize 2048 -validity 10000

# Move keystore to android/app/
mv flash_pos-upload-key.keystore android/app/
```

**Gradle Properties** (`android/gradle.properties`):
```properties
# Production signing configuration
FLASH_UPLOAD_STORE_FILE=flash_pos-upload-key.keystore
FLASH_UPLOAD_KEY_ALIAS=flash_pos-upload-key
FLASH_UPLOAD_STORE_PASSWORD=your_store_password
FLASH_UPLOAD_KEY_PASSWORD=your_key_password

# Build optimization
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.enableJetifier=true
```

### Android Build Process

**Development Build**:
```bash
# Debug APK
cd android
./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

**Staging Build**:
```bash
# Staging APK
cd android
./gradlew assembleStaging
# Output: android/app/build/outputs/apk/staging/app-staging.apk
```

**Production Build**:
```bash
# Production APK
cd android
./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release.apk

# Production AAB (for Play Store)
./gradlew bundleRelease
# Output: android/app/build/outputs/bundle/release/app-release.aab
```

### ProGuard Configuration

**android/app/proguard-rules.pro**:
```proguard
# React Native
-keep class com.facebook.react.** { *; }
-keep class com.swmansion.reanimated.** { *; }
-keep class com.th3rdwave.safeareacontext.** { *; }

# Flash POS specific
-keep class com.flash_pos.printer.** { *; }

# GraphQL
-keep class com.apollographql.** { *; }

# NFC
-keep class android.nfc.** { *; }

# Keep native module interfaces
-keep class * extends com.facebook.react.bridge.ReactContextBaseJavaModule { *; }
-keep class * extends com.facebook.react.bridge.BaseJavaModule { *; }
```

## iOS Deployment

### Xcode Configuration

**Info.plist Configuration**:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<dict>
    <key>CFBundleDisplayName</key>
    <string>Flash POS</string>
    <key>CFBundleIdentifier</key>
    <string>com.flash.pos</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    
    <!-- NFC Capability -->
    <key>NFCReaderUsageDescription</key>
    <string>This app uses NFC to read flashcard payments</string>
    
    <!-- Network Security -->
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSExceptionDomains</key>
        <dict>
            <key>api.flash.com</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <false/>
                <key>NSExceptionMinimumTLSVersion</key>
                <string>TLSv1.2</string>
            </dict>
        </dict>
    </dict>
</dict>
```

### iOS Build Configurations

**Xcode Build Settings**:
- **Development**: Debug configuration with development API endpoints
- **Staging**: Release configuration with staging API endpoints  
- **Production**: Release configuration with production API endpoints

**Build Configuration Files**:
```
ios/
├── Config/
│   ├── Development.xcconfig
│   ├── Staging.xcconfig
│   └── Production.xcconfig
```

**Development.xcconfig**:
```
#include "Pods/Target Support Files/Pods-flash_pos/Pods-flash_pos.debug.xcconfig"

FLASH_API_URL = https://api-dev.flash.com
FLASH_ENVIRONMENT = development
CODE_SIGN_IDENTITY = iPhone Developer
PROVISIONING_PROFILE_SPECIFIER = Flash POS Development
```

**Production.xcconfig**:
```
#include "Pods/Target Support Files/Pods-flash_pos/Pods-flash_pos.release.xcconfig"

FLASH_API_URL = https://api.flash.com
FLASH_ENVIRONMENT = production
CODE_SIGN_IDENTITY = iPhone Distribution
PROVISIONING_PROFILE_SPECIFIER = Flash POS Production
```

### Code Signing

**Automatic Code Signing** (Development):
```
Team: Flash Development Team
Bundle Identifier: com.flash.pos.dev
Provisioning Profile: Automatic
Signing Certificate: iOS Developer
```

**Manual Code Signing** (Production):
```
Team: Flash LLC
Bundle Identifier: com.flash.pos
Provisioning Profile: Flash POS Production
Signing Certificate: iOS Distribution
```

### iOS Build Process

**Development Build**:
```bash
# Debug build for simulator
cd ios
xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Debug -sdk iphonesimulator
```

**Production Build**:
```bash
# Production build for device
cd ios
xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Release -sdk iphoneos

# Archive for App Store
xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Release -archivePath flash_pos.xcarchive archive
```

## App Store Deployment

### Android Play Store

**Upload Process**:
1. Build production AAB: `./gradlew bundleRelease`
2. Test AAB on internal testing track
3. Upload to Play Console
4. Complete store listing information
5. Submit for review

**Play Store Listing Requirements**:
- App name: "Flash POS"
- Short description: "Bitcoin point-of-sale with NFC flashcard support"
- Full description: Detailed app functionality
- Screenshots: Required for phones and tablets
- Feature graphic: 1024x500 banner image
- App icon: 512x512 PNG

**Release Track Strategy**:
```
Internal Testing → Closed Testing → Open Testing → Production
```

### iOS App Store

**App Store Connect Setup**:
1. Create app record in App Store Connect
2. Configure app information and metadata
3. Upload build via Xcode or Application Loader
4. Submit for review

**App Store Review Guidelines Compliance**:
- **Financial Apps**: Comply with financial app requirements
- **NFC Usage**: Clearly describe NFC functionality
- **Bitcoin/Crypto**: Follow cryptocurrency app guidelines
- **User Privacy**: Complete privacy policy requirements

**TestFlight Distribution**:
```bash
# Archive and upload to TestFlight
cd ios
xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Release archive -archivePath flash_pos.xcarchive

# Upload via Xcode Organizer or altool
xcrun altool --upload-app --type ios --file flash_pos.ipa --username your@email.com --password app-specific-password
```

## CI/CD Pipeline

### GitHub Actions Workflow

**.github/workflows/deploy.yml**:
```yaml
name: Deploy
on:
  push:
    branches: [main, staging]
    tags: ['v*']

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: yarn install
      
      - name: Run tests
        run: yarn test:ci
      
      - name: Lint code
        run: yarn lint

  build-android:
    needs: test
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Setup Java
        uses: actions/setup-java@v3
        with:
          java-version: '11'
          distribution: 'adopt'
      
      - name: Install dependencies
        run: yarn install
      
      - name: Setup Android keystore
        run: |
          echo "${{ secrets.ANDROID_KEYSTORE }}" | base64 -d > android/app/flash_pos-upload-key.keystore
      
      - name: Build Android AAB
        env:
          FLASH_UPLOAD_STORE_PASSWORD: ${{ secrets.KEYSTORE_PASSWORD }}
          FLASH_UPLOAD_KEY_PASSWORD: ${{ secrets.KEY_PASSWORD }}
        run: |
          cd android
          ./gradlew bundleRelease
      
      - name: Upload to Play Store
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT }}
          packageName: com.flash_pos
          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
          track: production

  build-ios:
    needs: test
    runs-on: macos-latest
    if: startsWith(github.ref, 'refs/tags/v')
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: yarn install
      
      - name: Install CocoaPods
        run: |
          cd ios
          pod install
      
      - name: Build iOS
        run: |
          cd ios
          xcodebuild -workspace flash_pos.xcworkspace -scheme flash_pos -configuration Release -sdk iphoneos archive -archivePath flash_pos.xcarchive
      
      - name: Export IPA
        run: |
          cd ios
          xcodebuild -exportArchive -archivePath flash_pos.xcarchive -exportPath . -exportOptionsPlist ExportOptions.plist
      
      - name: Upload to App Store
        env:
          APP_STORE_CONNECT_API_KEY: ${{ secrets.ASC_API_KEY }}
        run: |
          xcrun altool --upload-app --type ios --file ios/flash_pos.ipa --apiKey $APP_STORE_CONNECT_API_KEY
```

### Environment Secrets

**GitHub Secrets Configuration**:
```
# Android
ANDROID_KEYSTORE: Base64 encoded keystore file
KEYSTORE_PASSWORD: Keystore password
KEY_PASSWORD: Key password
PLAY_SERVICE_ACCOUNT: Google Play service account JSON

# iOS
ASC_API_KEY: App Store Connect API key
IOS_CERTIFICATE: iOS distribution certificate
IOS_PROVISIONING_PROFILE: Production provisioning profile

# API Configuration
PRODUCTION_GRAPHQL_URI: Production GraphQL endpoint
PRODUCTION_BTCPAY_SERVER: Production BTCPay server URL
```

## Over-the-Air Updates

### CodePush Integration (Optional)

**Setup CodePush**:
```bash
# Install CodePush CLI
npm install -g code-push-cli

# Create CodePush app
code-push app add flash-pos-android android react-native
code-push app add flash-pos-ios ios react-native
```

**CodePush Configuration**:
```javascript
// App.js
import codePush from 'react-native-code-push';

const App = () => {
  // App content
};

const codePushOptions = {
  checkFrequency: codePush.CheckFrequency.ON_APP_RESUME,
  installMode: codePush.InstallMode.ON_NEXT_RESUME,
};

export default codePush(codePushOptions)(App);
```

**Deploy Updates**:
```bash
# Deploy to staging
code-push release-react flash-pos-android android --deployment-name Staging

# Deploy to production
code-push release-react flash-pos-android android --deployment-name Production
```

## Monitoring and Analytics

### Production Monitoring

**Error Tracking** (Sentry Integration):
```typescript
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'your-sentry-dsn',
  environment: __DEV__ ? 'development' : 'production',
});

// Capture errors
Sentry.captureException(error);

// Add breadcrumbs
Sentry.addBreadcrumb({
  message: 'Payment initiated',
  level: 'info',
});
```

**Analytics** (Firebase/Custom):
```typescript
import analytics from '@react-native-firebase/analytics';

// Track payment events
analytics().logEvent('payment_initiated', {
  amount: paymentAmount,
  currency: selectedCurrency,
});

// Track NFC interactions
analytics().logEvent('nfc_card_tapped', {
  screen: currentScreen,
  balance: cardBalance,
});
```

### Performance Monitoring

**Flipper Integration** (Development):
```bash
# Install Flipper plugins
yarn add --dev react-native-flipper

# Enable in debug builds
if (__DEV__) {
  require('react-native-flipper').default.addPlugin(/* ... */);
}
```

**Bundle Analysis**:
```bash
# Analyze bundle size
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output bundle.js --assets-dest assets/

# Generate source map for analysis
npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output bundle.js --sourcemap-output bundle.map
```

## Security Considerations

### Production Security

**API Security**:
- Use HTTPS for all API communications
- Implement certificate pinning
- Validate all server responses
- Use secure environment variable management

**App Security**:
- Enable ProGuard/R8 code obfuscation
- Implement root/jailbreak detection
- Secure keystore and certificate management
- Remove debug logs in production builds

**Data Protection**:
- Encrypt sensitive data at rest
- Use secure storage for credentials
- Implement proper session management
- Follow OWASP mobile security guidelines

### Compliance

**Financial Regulations**:
- Implement KYC/AML compliance if required
- Follow regional cryptocurrency regulations
- Maintain transaction audit logs
- Implement proper data retention policies

**Privacy Compliance**:
- Implement GDPR compliance (if applicable)
- Provide clear privacy policy
- Allow user data deletion
- Minimize data collection

## Rollback Strategy

### Emergency Rollback

**Play Store Rollback**:
1. Navigate to Play Console
2. Go to Release Management → App Releases
3. Select previous version and promote to production

**App Store Rollback**:
1. Contact Apple Developer Support
2. Request previous version restoration
3. Submit expedited review if necessary

**CodePush Rollback**:
```bash
# Rollback to previous version
code-push rollback flash-pos-android Production

# Disable problematic release
code-push patch flash-pos-android Production --disabled
```

### Version Management

**Semantic Versioning**:
```
MAJOR.MINOR.PATCH-BUILD
1.0.0-1     # Initial release
1.0.1-2     # Bug fix
1.1.0-3     # New feature
2.0.0-4     # Breaking change
```

**Build Number Strategy**:
- Increment build number for each deployment
- Use timestamp-based build numbers for CI/CD
- Maintain version mapping documentation

## Post-Deployment

### Launch Checklist

**Pre-Launch**:
- [ ] All tests passing
- [ ] Performance benchmarks met
- [ ] Security audit completed
- [ ] Store listings approved
- [ ] Production environment tested

**Launch Day**:
- [ ] Monitor crash reports
- [ ] Check user feedback
- [ ] Monitor server performance
- [ ] Verify payment processing
- [ ] Monitor NFC functionality

**Post-Launch**:
- [ ] Collect user feedback
- [ ] Monitor analytics
- [ ] Plan first update
- [ ] Document issues and improvements
- [ ] Update documentation