# Release Checklist

Run this before every production or store-submission build.

- [ ] All tests pass (`yarn test --runInBand`)
- [ ] Typecheck passes (`yarn typecheck`)
- [ ] Lint passes (`yarn lint --max-warnings 99999`)
- [ ] No secrets tracked in git (`git ls-files | grep -iE "keystore|\.env$"`)
- [ ] `.env` configured with correct endpoints for target environment
- [ ] `REWARDS_ENABLED` set correctly for this release
- [ ] `DEBUG_MODE` is `false` for production
- [ ] Android signing credentials in `~/.gradle/gradle.properties` (not in repo)
- [ ] iOS signing configured in Xcode (correct team + provisioning profile)
- [ ] Version number bumped in `android/app/build.gradle` and `ios/flash_pos.xcodeproj`
- [ ] Bundle/AAB built successfully (`yarn aab-android`)
- [ ] App installs and basic smoke test passes (keypad, invoice, payment flow)
- [ ] Rewards flow tested (if enabled)
- [ ] NFC card scan tested (if hardware available)
- [ ] Receipt printing tested (if hardware available)
- [ ] No `console.log` in production build
