# Release Signing

Android release signing credentials must not be committed to this repository.

## Required files and values

Keep the release keystore outside git. For local release builds, place the keystore at:

```text
android/app/release.keystore
```

The file is ignored by `.gitignore`. Do not force-add it.

Set signing values in `~/.gradle/gradle.properties`:

```properties
MYAPP_UPLOAD_STORE_FILE=release.keystore
MYAPP_UPLOAD_KEY_ALIAS=your-key-alias
MYAPP_UPLOAD_STORE_PASSWORD=your-store-password
MYAPP_UPLOAD_KEY_PASSWORD=your-key-password
```

CI release builds should provide the same names as secrets or environment variables, and should materialize the keystore from a protected secret before running Gradle.

Release builds fail when the key alias or passwords are missing. Generated release outputs under `android/app/release/` are ignored and should be rebuilt when needed.
