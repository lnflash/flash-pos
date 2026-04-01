# Screenshots

This directory contains screenshots of the Flash POS app for documentation purposes.

## Required Screenshots

Please add the following screenshots (PNG format, ~400px width recommended):

| Filename | Screen | Description |
|----------|--------|-------------|
| `keypad.png` | Keypad | Main amount entry screen with numpad |
| `invoice.png` | Invoice | QR code display for Lightning payment |
| `success.png` | Success | Payment confirmation screen |
| `rewards.png` | Rewards | Flashcard rewards screen |
| `history.png` | Transaction History | List of recent transactions |
| `settings.png` | Settings/Profile | Merchant settings screen |
| `nfc.png` | NFC Tap | NFC card detection screen |

## How to Capture Screenshots

### Android Emulator
```bash
adb exec-out screencap -p > screenshot.png
```

### iOS Simulator
Press `Cmd + S` or use Device → Screenshot

### Physical Device
Use the device's native screenshot function, then transfer via ADB/Finder.

## Image Guidelines

- **Format**: PNG (preferred) or JPEG
- **Width**: 400-600px for README display
- **Aspect**: Keep original device aspect ratio
- **Content**: Use demo/test data, no real customer info
- **Theme**: Use light theme for better visibility

## Placeholder Notice

⚠️ **TODO**: This directory needs actual screenshots from a running app.

If you're a contributor, please capture these screenshots and submit a PR!
