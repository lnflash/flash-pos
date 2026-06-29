# Dependencies

## Native Binary Dependencies

### `android/app/libs/printer-release.aar`

Status: unverified provenance.

The Android app includes a checked-in printer SDK AAR:

```text
android/app/libs/printer-release.aar
```

Inspection on 2026-06-21 found:

```text
Archive:  android/app/libs/printer-release.aar
  Length      Date    Time    Name
---------  ---------- -----   ----
        0  02-01-1980 00:00   proguard.txt
        0  02-01-1980 00:00   R.txt
      319  02-01-1980 00:00   AndroidManifest.xml
    47098  02-01-1980 00:00   classes.jar
```

Manifest metadata:

```xml
<manifest
    package="com.senraise.printer.sdk"
    android:versionCode="1"
    android:versionName="1.0">
    <uses-sdk
        android:minSdkVersion="16"
        android:targetSdkVersion="29" />
</manifest>
```

The embedded `classes.jar` contains printer SDK classes including:

```text
com/sr/SrPrinter.class
com/senraise/printer/sdk/BuildConfig.class
recieptservice/com/recieptservice/PrinterInterface.class
recieptservice/com/recieptservice/Sendlnterface.class
recieptservice/com/recieptservice/PSAMData.class
```

No Maven POM, Gradle module metadata, vendor signature, license, checksum manifest, or dependency manifest was present in the AAR.

Required follow-up:

- Obtain vendor documentation confirming the SDK source, version, license, checksum, and supported device models.
- Record the expected checksum in release documentation once provenance is verified.
- Prefer a vendor-hosted Maven artifact or reproducible internal artifact repository over a bare checked-in binary if available.
