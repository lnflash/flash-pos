# Deployment Quick Start

Quick reference for deploying flash_pos to App Store and Google Play.

## First Time Setup

Before you can use automated deployment, complete the one-time setup:

1. **Install dependencies:**
   ```bash
   bundle install
   ```

2. **Follow the complete setup guide:** [DEPLOYMENT_SETUP.md](DEPLOYMENT_SETUP.md)
   - Configure Apple Developer and Google Play accounts
   - Set up code signing with Fastlane Match
   - Add all required secrets to GitHub

## Daily Usage

### Deploy to TestFlight (iOS Beta)

```bash
npm run deploy:ios:beta
```

Or using Fastlane directly:
```bash
bundle exec fastlane ios beta
```

### Deploy to App Store (iOS Production)

```bash
npm run deploy:ios:release
```

### Deploy to Google Play Internal Testing (Android Beta)

```bash
npm run deploy:android:beta
```

### Deploy to Google Play Production (Android Release)

```bash
npm run deploy:android:release
```

### Promote Android Internal to Beta Track

```bash
npm run deploy:android:promote
```

## Automated Deployment via GitHub Actions

### Using Tags (Recommended)

**iOS:**
```bash
# Beta/TestFlight
git tag ios/v0.3.4-beta.1
git push origin ios/v0.3.4-beta.1

# Production
git tag ios/v0.3.4
git push origin ios/v0.3.4
```

**Android:**
```bash
# Internal Testing
git tag android/v0.3.2-beta.1
git push origin android/v0.3.2-beta.1

# Production
git tag android/v0.3.2
git push origin android/v0.3.2
```

### Using GitHub UI

1. Go to your repository on GitHub
2. Click **Actions** tab
3. Select **iOS Deploy** or **Android Deploy** workflow
4. Click **Run workflow**
5. Choose the lane (beta or release)
6. Click **Run workflow** button

## Pre-Deployment Checklist

Before deploying:

- [ ] All code changes are committed
- [ ] Tests are passing
- [ ] Version numbers are updated (if needed)
- [ ] Changelog is updated
- [ ] App is tested on physical devices

## Version Bumping

### iOS
```bash
# Update version number (e.g., 0.3.3 -> 0.3.4)
# Edit in Xcode or:
bundle exec fastlane run increment_version_number xcodeproj:"ios/flash_pos.xcodeproj"

# Build number is auto-incremented by Fastlane
```

### Android
```bash
# Update versionName in android/app/build.gradle
# versionCode is auto-incremented by Fastlane
```

## Troubleshooting

### Common Issues

**"Ensure git status clean" error:**
```bash
# Commit all changes first
git add .
git commit -m "Your commit message"
```

**"No signing certificate" (iOS):**
```bash
# Set up code signing
npm run setup:ios:signing
```

**Build fails:**
```bash
# iOS: Clean build
cd ios && xcodebuild clean && cd ..
rm -rf ios/Pods ios/Podfile.lock
bundle exec pod install --project-directory=ios

# Android: Clean build
cd android && ./gradlew clean && cd ..
```

## Getting Help

- Full setup guide: [DEPLOYMENT_SETUP.md](DEPLOYMENT_SETUP.md)
- Fastlane docs: https://docs.fastlane.tools
- Check GitHub Actions logs for deployment errors

## Deployment Workflow

```
┌─────────────────┐
│  Code Changes   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Run Tests     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Bump Version   │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌───────┐
│  iOS  │ │Android│
└───┬───┘ └───┬───┘
    │         │
    ▼         ▼
┌──────┐  ┌──────────┐
│ Beta │  │  Beta    │
└───┬──┘  └────┬─────┘
    │          │
    ▼          ▼
┌──────┐  ┌──────────┐
│ Prod │  │  Prod    │
└──────┘  └──────────┘
```
