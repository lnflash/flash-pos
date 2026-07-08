fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Push a new beta build to TestFlight

### ios release

```sh
[bundle exec] fastlane ios release
```

Deploy a new version to the App Store

### ios setup_signing

```sh
[bundle exec] fastlane ios setup_signing
```

Setup code signing using match

----


## Android

### android beta

```sh
[bundle exec] fastlane android beta
```

Deploy a new beta version to Google Play Internal Testing

### android release

```sh
[bundle exec] fastlane android release
```

Deploy a new version to Google Play Production

### android promote_to_beta

```sh
[bundle exec] fastlane android promote_to_beta
```

Promote internal testing to beta

### android build_apk

```sh
[bundle exec] fastlane android build_apk
```

Build APK for testing

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
