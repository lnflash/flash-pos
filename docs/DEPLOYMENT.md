# Automated Deployment Architecture

> **Last Updated:** June 24, 2026
> **System Version:** 1.0
> **Platforms:** iOS (TestFlight/App Store), Android (Google Play)

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Tools & Technologies](#tools--technologies)
4. [File Structure](#file-structure)
5. [Deployment Workflows](#deployment-workflows)
6. [Security & Credentials](#security--credentials)
7. [Version Management](#version-management)
8. [Platform Details](#platform-details)
9. [Troubleshooting](#troubleshooting)

---

## Overview

This document describes the complete automated deployment system for flash_pos, a React Native mobile application deployed to both Apple App Store and Google Play Store.

### What We Built

A **fully automated CI/CD pipeline** featuring:
- ✅ One-command local deployments
- ✅ GitHub Actions for cloud-based releases
- ✅ Git tag-based automatic versioning
- ✅ Secure credential management
- ✅ iOS code signing automation (Fastlane Match)
- ✅ Cross-platform unified workflow

### Key Achievements

- **Zero-Touch Deployment**: Single command deploys to app stores
- **Version Automation**: Git tags automatically control app versions
- **Security**: All credentials encrypted and never in code
- **Team-Ready**: Certificate syncing via Match
- **Fully Documented**: Complete setup and usage guides

---

## System Architecture

### High-Level Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Developer Action                      │
│  (./deploy-ios.sh or git tag or GitHub UI)              │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Fastlane Deployment Engine                  │
│  • Validates git state                                   │
│  • Checks for version tags                               │
│  • Increments build numbers                              │
│  • Manages dependencies                                  │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌─────────────────┐           ┌─────────────────┐
│   iOS Build     │           │ Android Build   │
│                 │           │                 │
│ • CocoaPods     │           │ • Gradle        │
│ • Match certs   │           │ • Keystore      │
│ • Xcode build   │           │ • AAB bundle    │
└────────┬────────┘           └────────┬────────┘
         │                             │
         ▼                             ▼
┌─────────────────┐           ┌─────────────────┐
│   TestFlight    │           │  Google Play    │
│   App Store     │           │  Internal/Beta  │
└─────────────────┘           └─────────────────┘
```

### Component Diagram

```
Repository
├── Source Code (React Native)
├── Fastlane Configuration
│   ├── Fastfile (deployment logic)
│   ├── Appfile (app identifiers)
│   └── Matchfile (iOS signing)
├── CI/CD Workflows
│   └── .github/workflows/
│       ├── ios-deploy.yml
│       ├── android-deploy.yml
│       └── build-check.yml
├── Deployment Scripts
│   ├── deploy-ios.sh
│   └── deploy-android.sh
└── Documentation
    ├── docs/ARCHITECTURE.md (this file)
    ├── DEPLOYMENT_SETUP.md
    └── DEPLOYMENT_QUICK_START.md
```

---

## Tools & Technologies

### Core Technologies

| Tool | Purpose | Version | Docs |
|------|---------|---------|------|
| **Fastlane** | Mobile deployment automation | 2.236.1 | [docs.fastlane.tools](https://docs.fastlane.tools) |
| **Fastlane Match** | iOS code signing management | Built-in | [match docs](https://docs.fastlane.tools/actions/match) |
| **GitHub Actions** | CI/CD platform | N/A | [github.com/actions](https://docs.github.com/en/actions) |
| **Ruby** | Fastlane runtime | 3.2+ | [ruby-lang.org](https://www.ruby-lang.org) |
| **Bundler** | Ruby dependency management | Latest | [bundler.io](https://bundler.io) |
| **Gradle** | Android build system | 8.x | [gradle.org](https://gradle.org) |
| **CocoaPods** | iOS dependency management | 1.13+ | [cocoapods.org](https://cocoapods.org) |

### Tool Responsibilities

#### 1. Fastlane (Core Automation)

**What it does:**
- Orchestrates entire deployment process
- Builds iOS and Android apps
- Manages code signing
- Uploads to app stores
- Increments version numbers
- Creates git tags

**Key files:**
- `fastlane/Fastfile` - Deployment lanes (workflows)
- `fastlane/Appfile` - App identifiers and team configuration
- `fastlane/Matchfile` - Code signing configuration

**Custom Functions Created:**
```ruby
version_from_git_tag(platform)     # Extract version from git tags
update_ios_version_from_tag()      # Set iOS version from tag
update_android_version_from_tag()  # Set Android version from tag
increment_android_version_code()   # Increment Android build number
```

#### 2. Fastlane Match (iOS Code Signing)

**What it does:**
- Stores iOS certificates in private Git repository
- Syncs certificates across team members and CI
- Automatically provisions code signing in builds

**Configuration:**
- **Storage:** `github.com/lnflash/flash-pos-certificates` (private)
- **Encryption:** Passphrase-protected
- **Access:** Automatic via `MATCH_PASSWORD` secret

**Workflow:**
```
Developer runs: fastlane match appstore
         ↓
Creates/downloads certificates
         ↓
Stores in encrypted Git repo
         ↓
CI/CD pulls same certificates
         ↓
Everyone uses same signing identity
```

#### 3. GitHub Actions (CI/CD)

**What it does:**
- Runs deployments in cloud
- Triggered by git tags or manual dispatch
- Manages secrets securely
- Provides build logs and artifacts

**Workflows:**

**iOS Deploy** (`.github/workflows/ios-deploy.yml`)
- Triggers: `ios/v*` tags or manual
- Runs on: macOS (Xcode required)
- Lanes: `beta` (TestFlight) or `release` (App Store)

**Android Deploy** (`.github/workflows/android-deploy.yml`)
- Triggers: `android/v*` tags or manual
- Runs on: Ubuntu (faster, cheaper)
- Lanes: `beta` (Internal) or `release` (Production)

**Build Check** (`.github/workflows/build-check.yml`)
- Triggers: Pull requests
- Validates: iOS/Android builds, linting
- Purpose: Pre-merge validation

#### 4. Ruby & Bundler

**What they do:**
- Ruby: Runtime for Fastlane (Ruby-based tool)
- Bundler: Manages Fastlane and plugin versions

**Key files:**
- `Gemfile` - Ruby dependencies
- `Gemfile.lock` - Locked versions

#### 5. Build Systems

**Gradle** (Android)
- Builds Android App Bundles (AAB)
- Manages dependencies
- Signs release builds
- Configured via `android/app/build.gradle`

**Xcode** (iOS via Fastlane)
- Builds iOS app archives
- Links CocoaPods dependencies
- Signs with Match certificates
- Configured via `ios/flash_pos.xcodeproj`

---

## File Structure

### Deployment Files

```
flash_pos/
├── fastlane/
│   ├── Fastfile              # Main deployment logic
│   ├── Appfile               # App identifiers and team info
│   ├── Matchfile             # iOS code signing config
│   └── README.md             # Auto-generated by Fastlane
│
├── .github/workflows/
│   ├── ios-deploy.yml        # iOS CI/CD workflow
│   ├── android-deploy.yml    # Android CI/CD workflow
│   └── build-check.yml       # PR validation workflow
│
├── deploy-ios.sh             # Local iOS deployment script
├── deploy-android.sh         # Local Android deployment script
│
├── .env.fastlane             # Local credentials (git-ignored)
├── .env.fastlane.example     # Credential template
│
├── docs/
│   ├── ARCHITECTURE.md       # This file
│   ├── WORKFLOWS.md          # Detailed workflow documentation
│   └── CHANGELOG.md          # System changes log
│
├── DEPLOYMENT_SETUP.md       # First-time setup guide
├── DEPLOYMENT_QUICK_START.md # Daily usage reference
│
├── Gemfile                   # Ruby dependencies
└── Gemfile.lock              # Locked Ruby versions
```

### Ignored Files (Security)

```
.gitignore includes:
├── .env.fastlane             # Local credentials
├── google-play-key.json      # Google Play service account
├── flash-pos-*.json          # Google service accounts
├── *.keystore                # Android signing keys
├── android/gradle.properties # Android signing config
└── fastlane/report.xml       # Build reports
```

---

## Deployment Workflows

### Fastlane Lanes

#### iOS Lanes

**`ios beta`** - Deploy to TestFlight
```ruby
lane :beta do
  ensure_git_status_clean           # Verify clean git state
  update_ios_version_from_tag       # Set version from git tag
  increment_build_number            # Auto-increment build
  cocoapods                         # Install dependencies
  build_app                         # Build IPA with Match certs
  upload_to_testflight             # Upload to TestFlight
  commit_version_bump              # Commit version changes
  add_git_tag                      # Tag with version+build
end
```

**`ios release`** - Deploy to App Store
- Same as beta but uploads to App Store
- Does NOT auto-submit for review
- Creates version-only git tag

**`ios setup_signing`** - Download Certificates
- Used by CI/CD before building
- Downloads Match certificates
- Readonly mode in CI

#### Android Lanes

**`android beta`** - Deploy to Internal Testing
```ruby
lane :beta do
  ensure_git_status_clean           # Verify clean git state
  update_android_version_from_tag   # Set version from git tag
  increment_android_version_code    # Auto-increment version code
  gradle(task: "bundle")            # Build AAB
  upload_to_play_store(track: "internal")  # Upload
  git_commit                        # Commit version changes
  add_git_tag                       # Tag with version+code
end
```

**`android release`** - Deploy to Production
- Same as beta but uploads to Production
- Uses 10% staged rollout
- Creates version-only git tag

**`android promote_to_beta`** - Promote to Open Testing
- Promotes Internal Testing → Beta track
- No new build, just track change

### Deployment Methods

#### Method 1: Local Scripts (Recommended for Development)

```bash
# iOS
./deploy-ios.sh              # Deploy to TestFlight
./deploy-ios.sh release      # Deploy to App Store

# Android
./deploy-android.sh          # Deploy to Internal Testing
./deploy-android.sh release  # Deploy to Production
./deploy-android.sh promote_to_beta  # Promote to Beta
```

**How it works:**
1. Script loads `.env.fastlane`
2. Exports environment variables
3. Runs `bundle exec fastlane <platform> <lane>`

**When to use:**
- Quick deployments
- Testing changes
- Local development

#### Method 2: NPM Scripts

```bash
npm run deploy:ios:beta
npm run deploy:ios:release
npm run deploy:android:beta
npm run deploy:android:release
```

**When to use:**
- Consistent with npm-based workflows
- Preference for npm over shell scripts

#### Method 3: Git Tags (Automated via GitHub Actions)

```bash
# iOS
git tag ios/v0.4.0
git push origin ios/v0.4.0

# Android
git tag android/v0.4.0
git push origin android/v0.4.0

# Both platforms
git tag v0.4.0
git push origin v0.4.0
```

**How it works:**
1. Tag push triggers GitHub Actions
2. Workflow detects platform from tag
3. Runs deployment automatically
4. Version set from tag automatically

**When to use:**
- Production releases
- Version bumps
- Automated deployments

#### Method 4: GitHub UI (Manual Trigger)

1. Go to repository → Actions
2. Select workflow (iOS Deploy / Android Deploy)
3. Click "Run workflow"
4. Choose lane (beta / release)
5. Click "Run workflow" button

**When to use:**
- Non-technical team members
- Manual control needed
- Troubleshooting

---

## Security & Credentials

### Credential Storage

#### Local Development
**File:** `.env.fastlane` (git-ignored)

**Contents:**
```bash
APPLE_ID=your@email.com
TEAM_ID=ABC123XYZ
FASTLANE_PASSWORD=your-apple-password
FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
MATCH_PASSWORD=match-encryption-password
GOOGLE_PLAY_JSON_KEY_PATH=path/to/key.json
```

**Access:** Loaded by deployment scripts

#### CI/CD (GitHub Actions)
**Storage:** GitHub Secrets (Settings → Secrets → Actions)

**iOS Secrets (7):**
- `APPLE_ID` - Apple ID email
- `TEAM_ID` - Developer team ID
- `ITC_TEAM_ID` - iTunes Connect team ID
- `FASTLANE_PASSWORD` - Apple ID password
- `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` - 2FA bypass
- `MATCH_PASSWORD` - Certificate encryption passphrase
- `MATCH_GIT_BASIC_AUTHORIZATION` - Base64 of username:token

**Android Secrets (5):**
- `GOOGLE_PLAY_JSON_KEY` - Service account JSON content
- `ANDROID_KEYSTORE_BASE64` - Base64-encoded keystore
- `ANDROID_KEYSTORE_PASSWORD` - Keystore password
- `ANDROID_KEY_ALIAS` - Key alias in keystore
- `ANDROID_KEY_PASSWORD` - Key password

**Access:** Injected as environment variables during workflow

#### iOS Certificates (Fastlane Match)
**Storage:** `github.com/lnflash/flash-pos-certificates` (private repo)

**Contents:**
- Distribution certificates
- Provisioning profiles
- Encrypted with passphrase

**Access:**
- Local: `bundle exec fastlane match appstore`
- CI: Automatic via `setup_signing` lane

### Security Best Practices

✅ **DO:**
- Keep `.env.fastlane` git-ignored
- Rotate credentials periodically
- Use app-specific passwords (not main password)
- Restrict GitHub secret access
- Use minimum required permissions

❌ **DON'T:**
- Commit credentials to git
- Share credentials in plain text
- Use same password everywhere
- Give admin access when not needed

---

## Version Management

### Git Tag-Based Versioning

#### How It Works

```ruby
def version_from_git_tag(platform)
  # 1. Try platform-specific tag: ios/v1.2.3
  tag = sh("git describe --tags --match '#{platform}/v*'")

  # 2. If not found, try generic tag: v1.2.3
  if tag.empty?
    tag = sh("git describe --tags --match 'v*'")
  end

  # 3. Extract version number (handles both formats)
  version = tag.match(/v?(\d+\.\d+\.\d+)/)

  # 4. Return version or nil
  version ? version[1] : nil
end
```

#### Tag Format

| Tag Format | iOS Version | Android Version |
|------------|-------------|-----------------|
| `v1.2.3` | 1.2.3 | 1.2.3 |
| `ios/v1.2.3` | 1.2.3 | (unchanged) |
| `android/v1.2.3` | (unchanged) | 1.2.3 |
| No tag | (unchanged) | (unchanged) |

**Priority:** Platform-specific > Generic > Current

#### Build Number Management

**iOS:**
- **Version:** From git tag or manual (e.g., 0.3.3)
- **Build:** Auto-incremented (e.g., 11, 12, 13)
- **Format:** `0.3.3 (11)`

**Android:**
- **versionName:** From git tag or manual (e.g., 0.3.1)
- **versionCode:** Auto-incremented (e.g., 13, 14, 15)
- **Format:** `0.3.1 (13)`

#### Version Bump Workflow

**Scenario 1: TestFlight/Internal Testing (No version change)**
```bash
./deploy-ios.sh    # Build 11 → 0.3.3 (11)
./deploy-ios.sh    # Build 12 → 0.3.3 (12)
./deploy-ios.sh    # Build 13 → 0.3.3 (13)
```

**Scenario 2: Production Release (Version bump)**
```bash
git tag ios/v0.4.0
./deploy-ios.sh release  # Build 14 → 0.4.0 (14)
```

**Scenario 3: Different Versions Per Platform**
```bash
git tag ios/v0.4.0
git tag android/v1.2.0

./deploy-ios.sh      # iOS: 0.4.0
./deploy-android.sh  # Android: 1.2.0
```

---

## Platform Details

### iOS (Apple App Store)

**Bundle Identifier:** `com.flash.pos`

**Distribution:**
- **TestFlight:** Beta testing (via `ios beta` lane)
  - Internal: Up to 100 testers, instant
  - External: Unlimited testers, requires review
- **App Store:** Production (via `ios release` lane)
  - Submitted for review
  - Not auto-released (manual control)

**Code Signing:**
- **Method:** Fastlane Match
- **Certificate:** Distribution certificate
- **Profile:** App Store provisioning profile
- **Storage:** Private Git repository
- **Team ID:** H7UAM79QQP

**Build Process:**
1. CocoaPods install dependencies
2. Match downloads certificates
3. Xcode builds archive
4. Export IPA with App Store profile
5. Upload via App Store Connect API

### Android (Google Play Store)

**Package Name:** `com.flash_pos`

**Distribution:**
- **Internal Testing:** Up to 100 testers (via `android beta` lane)
- **Open Testing (Beta):** Unlimited, opt-in
- **Production:** Public release (via `android release` lane)
  - 10% staged rollout by default

**Signing:**
- **Keystore:** `release.keystore`
- **Alias:** `flash-pos-release`
- **Format:** PKCS12
- **Storage:** Base64 in GitHub Secrets

**Build Process:**
1. Gradle resolves dependencies
2. React Native bundles JavaScript
3. Gradle builds AAB (Android App Bundle)
4. Signs with release keystore
5. Upload via Google Play API

---

## Troubleshooting

### Common Issues

#### Git Repository Dirty
**Error:** "Git repository is dirty!"

**Cause:** Uncommitted changes in working directory

**Solution:**
```bash
git status              # Check what changed
git add .              # Stage all changes
git commit -m "msg"    # Commit changes
```

#### iOS Certificate Issues
**Error:** "No signing certificate found"

**Solution:**
```bash
# Re-run match
bundle exec fastlane match appstore --force

# Verify secrets in GitHub
# Check MATCH_PASSWORD and MATCH_GIT_BASIC_AUTHORIZATION
```

#### Android Upload Failed
**Error:** "Google Play API error"

**Solution:**
- Verify `GOOGLE_PLAY_JSON_KEY` is correct JSON
- Check service account has correct permissions
- Ensure first version uploaded manually

#### Version Already Exists
**Error:** "Version already exists in store"

**Solution:**
- Increment version: `git tag ios/v0.4.1`
- Or just increment build (auto-increments)

### Debug Mode

Enable verbose Fastlane output:
```bash
# Add to .env.fastlane
FASTLANE_VERBOSE=true

# Or run directly
bundle exec fastlane ios beta --verbose
```

### Logs Location

**Local:**
- `fastlane/report.xml` - Detailed report
- `~/Library/Logs/gym/` - iOS build logs

**GitHub Actions:**
- Actions tab → Select workflow run → View logs

---

## Maintenance

### Regular Tasks

**Weekly:**
- Check GitHub Actions workflows are passing
- Review app store feedback

**Monthly:**
- Review credential expiration dates
- Update Fastlane: `bundle update fastlane`

**Quarterly:**
- Rotate app-specific passwords
- Review and update documentation
- Check for iOS certificate expiration

### Updating This Documentation

When making changes to the deployment system:

1. Update relevant sections in this file
2. Update version and "Last Updated" date at top
3. Document breaking changes in CHANGELOG.md
4. Update DEPLOYMENT_SETUP.md if setup changes
5. Commit with message: `docs: update deployment architecture`

---

## Future Enhancements

### Potential Improvements

- [ ] Automated changelog generation from git commits
- [ ] Screenshot automation with Fastlane Snapshot
- [ ] App Store metadata management
- [ ] Slack/Discord notifications on deploy
- [ ] Automatic rollback on failed deploys
- [ ] Pre-deploy automated testing
- [ ] Multi-environment support (staging/production)

### Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-24 | Initial deployment system |

---

**Questions or issues?** See [DEPLOYMENT_SETUP.md](../DEPLOYMENT_SETUP.md) for detailed setup instructions or [DEPLOYMENT_QUICK_START.md](../DEPLOYMENT_QUICK_START.md) for daily usage.
