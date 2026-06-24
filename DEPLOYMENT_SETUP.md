# Automated Deployment Setup Guide

This guide will help you set up automated deployment for both iOS (App Store) and Android (Google Play Store) using Fastlane and GitHub Actions.

## Table of Contents
- [Prerequisites](#prerequisites)
- [iOS Setup](#ios-setup)
- [Android Setup](#android-setup)
- [GitHub Secrets Configuration](#github-secrets-configuration)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### 1. Install Fastlane Dependencies

```bash
# Install Ruby dependencies
bundle install
```

### 2. Accounts Required
- **Apple Developer Account** (paid, $99/year)
- **Google Play Developer Account** (one-time $25 fee)
- **GitHub repository** with Actions enabled

## iOS Setup

### Step 1: Apple Developer Account Configuration

1. **Create App in App Store Connect**
   - Go to [App Store Connect](https://appstoreconnect.apple.com)
   - Navigate to "My Apps" → "+" → "New App"
   - Fill in app details with Bundle ID: `com.flash.pos`

2. **Get Your Team IDs**
   ```bash
   # List your teams
   fastlane fastlane-credentials show
   ```
   - Note down your **Team ID** and **iTunes Connect Team ID**

3. **Create App Store Connect API Key**
   - Go to App Store Connect → Users and Access → Keys
   - Click "+" to create a new key
   - Give it "App Manager" role
   - Download the `.p8` file and note the **Key ID** and **Issuer ID**

### Step 2: Set Up Fastlane Match (Code Signing)

Fastlane Match stores your certificates and provisioning profiles in a private Git repository.

1. **Create a Private GitHub Repository**
   - Create a new private repo (e.g., `flash-pos-certificates`)
   - This will store your iOS certificates and profiles

2. **Initialize Match**
   ```bash
   bundle exec fastlane match init
   ```
   - Select "git" as storage mode
   - Enter your certificates repo URL: `https://github.com/YOUR_USERNAME/flash-pos-certificates`

3. **Generate Certificates and Profiles**
   ```bash
   # Generate App Store certificates
   bundle exec fastlane match appstore
   ```
   - Enter your Apple ID when prompted
   - Create a strong passphrase (you'll need this for GitHub secrets)
   - This creates and uploads certificates to your private repo

4. **Create Personal Access Token for Match**
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate new token with `repo` scope
   - Save this token securely

### Step 3: Enable Two-Factor Authentication

1. **Set up 2FA on Apple ID**
   - Go to [appleid.apple.com](https://appleid.apple.com)
   - Enable two-factor authentication if not already enabled

2. **Create App-Specific Password**
   - Go to [appleid.apple.com](https://appleid.apple.com)
   - Sign in → Security → App-Specific Passwords
   - Generate a new password for "Fastlane"
   - Save this password securely

## Android Setup

### Step 1: Google Play Console Configuration

1. **Create App in Google Play Console**
   - Go to [Google Play Console](https://play.google.com/console)
   - Create new app with package name: `com.flash_pos`

2. **Create a Service Account**
   - Go to Google Cloud Console for your project
   - Navigate to "IAM & Admin" → "Service Accounts"
   - Create a new service account (e.g., "fastlane-deployer")
   - Grant it the role: "Service Account User"

3. **Grant API Access in Play Console**
   - Go back to Play Console → Setup → API access
   - Link the service account you created
   - Grant permissions: "Admin" (for full deployment access) or "Release Manager"

4. **Download Service Account JSON Key**
   - In Google Cloud Console → Service Accounts
   - Click on your service account → Keys → Add Key → Create new key
   - Choose JSON format
   - Download and save this file securely
   - **Important:** This file contains sensitive credentials. Never commit it to Git!

### Step 2: Android Keystore Setup

You need a release keystore to sign your Android app.

1. **Generate Keystore (if you don't have one)**
   ```bash
   keytool -genkeypair -v -storetype PKCS12 -keystore release.keystore \
     -alias flash-pos-release \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   - Enter a strong password for the keystore
   - Enter details when prompted
   - Save the keystore file securely

2. **Convert Keystore to Base64**
   ```bash
   # On macOS/Linux
   base64 -i release.keystore -o release.keystore.base64

   # On Windows (PowerShell)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("release.keystore")) | Out-File -Encoding ASCII release.keystore.base64
   ```
   - Save the content of `release.keystore.base64` for GitHub secrets

3. **Upload First APK/AAB Manually**
   - Before automation works, you need to manually upload the first version
   - Build release AAB:
     ```bash
     cd android && ./gradlew bundleRelease
     ```
   - Upload the AAB at `android/app/build/outputs/bundle/release/app-release.aab` to Play Console
   - Complete the store listing and release to Internal Testing

## GitHub Secrets Configuration

Add these secrets to your GitHub repository (Settings → Secrets and variables → Actions → New repository secret):

### iOS Secrets

| Secret Name | Description | Where to Get It |
|------------|-------------|-----------------|
| `APPLE_ID` | Your Apple ID email | Your Apple Developer account |
| `TEAM_ID` | Apple Developer Team ID | App Store Connect → Membership |
| `ITC_TEAM_ID` | iTunes Connect Team ID | Usually same as TEAM_ID |
| `FASTLANE_PASSWORD` | Your Apple ID password | Your Apple ID password |
| `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` | App-specific password | Generated at appleid.apple.com |
| `MATCH_PASSWORD` | Passphrase for match certificates | Created when running `fastlane match init` |
| `MATCH_GIT_BASIC_AUTHORIZATION` | Base64 of `username:token` | See below |

**Creating MATCH_GIT_BASIC_AUTHORIZATION:**
```bash
echo -n "YOUR_GITHUB_USERNAME:YOUR_PERSONAL_ACCESS_TOKEN" | base64
```

### Android Secrets

| Secret Name | Description | Where to Get It |
|------------|-------------|-----------------|
| `GOOGLE_PLAY_JSON_KEY` | Service account JSON content | Copy entire content of downloaded JSON file |
| `ANDROID_KEYSTORE_BASE64` | Base64 encoded keystore | Content of `release.keystore.base64` file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password | Password you set when creating keystore |
| `ANDROID_KEY_ALIAS` | Key alias in keystore | Alias you set (e.g., "flash-pos-release") |
| `ANDROID_KEY_PASSWORD` | Key password | Password for the key (often same as keystore) |

## Usage

### Deploying iOS

#### Option 1: Manual Trigger via GitHub Actions
1. Go to your GitHub repository
2. Click "Actions" → "iOS Deploy" workflow
3. Click "Run workflow"
4. Select lane: `beta` (TestFlight) or `release` (App Store)

#### Option 2: Git Tag (Automated)
```bash
# For beta/TestFlight
git tag ios/v0.3.3-beta.1
git push origin ios/v0.3.3-beta.1

# For production
git tag ios/v0.3.3
git push origin ios/v0.3.3
```

#### Option 3: Local Fastlane
```bash
# TestFlight
bundle exec fastlane ios beta

# App Store
bundle exec fastlane ios release
```

### Deploying Android

#### Option 1: Manual Trigger via GitHub Actions
1. Go to your GitHub repository
2. Click "Actions" → "Android Deploy" workflow
3. Click "Run workflow"
4. Select lane: `beta`, `release`, or `promote_to_beta`

#### Option 2: Git Tag (Automated)
```bash
# For internal testing
git tag android/v0.3.1-beta.1
git push origin android/v0.3.1-beta.1

# For production
git tag android/v0.3.1
git push origin android/v0.3.1
```

#### Option 3: Local Fastlane
```bash
# Internal testing
bundle exec fastlane android beta

# Production (10% rollout)
bundle exec fastlane android release

# Promote internal to beta
bundle exec fastlane android promote_to_beta
```

### Deployment Tracks

**iOS:**
- `beta` lane → TestFlight (for internal/external testing)
- `release` lane → App Store (submitted for review, not auto-released)

**Android:**
- `beta` lane → Internal Testing track
- `promote_to_beta` lane → Beta track (open testing)
- `release` lane → Production track (10% staged rollout)

## Version Management

### iOS
- Version number (e.g., 0.3.3) is in [ios/flash_pos.xcodeproj](ios/flash_pos.xcodeproj)
- Build number is auto-incremented by Fastlane
- Update version manually in Xcode or via:
  ```bash
  bundle exec fastlane run increment_version_number xcodeproj:"ios/flash_pos.xcodeproj"
  ```

### Android
- Version name (e.g., 0.3.1) is in [android/app/build.gradle](android/app/build.gradle#L87)
- Version code is auto-incremented by Fastlane
- Update version name manually in build.gradle

## Troubleshooting

### iOS Issues

**"Could not find or download user credentials"**
- Check your `APPLE_ID` and `FASTLANE_PASSWORD` secrets
- Verify app-specific password is correct

**"No signing certificate found"**
- Run `bundle exec fastlane match appstore` locally first
- Check `MATCH_PASSWORD` and `MATCH_GIT_BASIC_AUTHORIZATION` secrets

**"Provisioning profile doesn't match"**
- Make sure bundle identifier is exactly `com.flash.pos`
- Re-run match: `bundle exec fastlane match appstore --force`

### Android Issues

**"Package not found"**
- Make sure you uploaded the first version manually to Play Console
- Verify package name is `com.flash_pos`

**"Google Play API error"**
- Check service account has correct permissions in Play Console
- Verify `GOOGLE_PLAY_JSON_KEY` secret is correct JSON

**"Failed to sign APK"**
- Verify keystore password and alias are correct
- Check `ANDROID_KEYSTORE_BASE64` is properly encoded

### General

**"Git dirty" error**
- Some lanes require clean git state
- Commit all changes before deploying

**Workflow doesn't trigger**
- Check tag format: `ios/v*` or `android/v*`
- Verify workflows are enabled in repository settings

## Security Best Practices

1. **Never commit sensitive files:**
   - `*.keystore` files
   - Service account JSON files
   - `.p8` API key files
   - Passwords or tokens

2. **Rotate credentials periodically:**
   - App-specific passwords
   - Service account keys
   - Personal access tokens

3. **Limit access:**
   - Use minimum required permissions for service accounts
   - Restrict repository access to deployment secrets

4. **Monitor deployments:**
   - Check GitHub Actions logs regularly
   - Set up notifications for failed workflows

## Next Steps

After setup:
1. Test beta deployments first
2. Verify apps appear in TestFlight/Internal Testing
3. Test the full release process with production
4. Set up automated testing before deployment (optional)
5. Configure automatic changelog generation (optional)

## Support

For issues with:
- **Fastlane:** [fastlane.tools/docs](https://docs.fastlane.tools)
- **GitHub Actions:** [docs.github.com/actions](https://docs.github.com/en/actions)
- **App Store Connect:** [developer.apple.com/support](https://developer.apple.com/support)
- **Google Play Console:** [support.google.com/googleplay](https://support.google.com/googleplay/android-developer)
