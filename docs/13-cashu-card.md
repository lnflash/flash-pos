# Cashu NFC Card (spike)

## Status

**Spike — no card has run this yet.** The protocol layer is fully unit-tested
against a fake card; nothing here has touched physical silicon. Treat a green
test suite as evidence about the *code*, not about the *card*.

## What this is

An offline bearer ecash card. The card holds Cashu proofs in its own secure
element and unlocks them by signing a BIP-340 Schnorr witness on-chip. No phone,
no account, and no internet on the customer side.

This is a different thing from the existing Flashcard/BoltCard path in
`src/contexts/Flashcard.tsx`, and the difference matters:

| | Flashcard (BoltCard) | Cashu card |
|---|---|---|
| Chip | NTAG 424 DNA | JavaCard 3.0.5+ secure element |
| NFC layer | NDEF text record | ISO 7816 APDUs over IsoDep |
| What the card holds | An LNURLW pointer | The money itself |
| Needs the internet at tap | Yes | No |

Related repos:

- [`lnflash/cashu-javacard`](https://github.com/lnflash/cashu-javacard) — the
  applet, the APDU spec (`spec/APDU.md`), and `tools/cardctl` (the Python
  reference driver this module mirrors).
- [`lnflash/cashu-client`](https://github.com/lnflash/cashu-client) — mint
  protocol in TypeScript: swap, melt, P2PK witnesses, DLEQ.

## Layout

| File | Role |
|---|---|
| `src/services/cashuCard.ts` | APDU protocol. **Transport-agnostic** — no NFC import, so it is testable anywhere. |
| `src/services/cashuCardNfc.ts` | `react-native-nfc-manager` IsoDep transport + session lifecycle. |
| `src/screens/CashuCardDebug.tsx` | Bring-up harness. Dev builds only. |

The split is deliberate: every byte of protocol logic is exercised in CI with a
fake transceiver, and only the thin transport needs hardware.

## A stranded session breaks BoltCard payments — read this before extending

An open IsoDep session does not just leak: it silently swallows taps on the live
payment path. The mechanism:

1. `NfcManager.requestTechnology(NfcTech.IsoDep)` sets a pending `techRequest`
   in the native module. On Android it **never times out** — it stays pending
   until a tag enters the field.
2. While it is pending, the native `parseNfcIntent` claims every discovered tag
   for that session and returns early *without* emitting
   `NfcManagerDiscoverTag`.
3. `FlashcardProvider` (`src/contexts/Flashcard.tsx`, mounted around the whole
   tree in `App.tsx`) listens on exactly that event. No event, no `handleTag` —
   the merchant's BoltCard tap does nothing, anywhere in the app.

So: start a read on the bring-up screen, don't tap, navigate away, and card
payments stop working until the app restarts.

Two defences, both required:

- `withCardSession` wraps the read in `try/finally` around
  `cancelCardSession()`. This covers the read completing or failing.
- `cancelCardSession()` is also exported for callers to invoke directly, because
  that `finally` **cannot run** while the request is still pending. Any screen
  that can start a session must cancel it on unmount (`CashuCardDebug` does) and
  should offer a visible Cancel control while a read is in flight.

Note we are **not** in Android reader mode. `FlashcardProvider` already calls
`registerTagEvent()` with no options at app start, so `isReaderModeEnabled` is
false and `NfcManagerAndroid.requestTechnology` skips its own registration —
`enableReaderMode` is never called. The tap suppression above comes from the
pending `techRequest`, not from reader mode.

That distinction matters if Flash POS ever also wants to accept taps from Cashu
*phone* wallets (HCE/NDEF, as [Numo](https://github.com/cashubtc/Numo) does):
true reader mode and Host Card Emulation genuinely are mutually exclusive on
Android, so adopting reader mode later would add a second, separate constraint
on top of this one.

## Running it on hardware

1. Build and install the applet (from the `cashu-javacard` checkout):

   ```bash
   ant -f applet/build.xml cap
   gp -install applet/target/cashu-javacard-0.1.0.cap
   ```

2. Confirm the card answers over a contact/PC-SC reader first — it isolates card
   problems from phone problems:

   ```bash
   cd tools/cardctl && python3 cardctl.py selftest
   ```

3. Run a **dev** build of Flash POS and open **Profile → Settings → Cashu card
   (dev)**. Both the row and the route are gated on `__DEV__`, so the screen is
   absent from release builds and unreachable in production.

   `RootStackType` declares `CashuCardDebug` unconditionally, so
   `navigation.navigate('CashuCardDebug')` typechecks in a release build but
   fails at runtime with an unhandled `NAVIGATE` action. Gate any other call
   site on `__DEV__`, the way `src/screens/Profile.tsx` does.

4. Tap. A pubkey on screen means the applet is installed, the AID selected over
   NFC, and the card's crypto answered.

The screen runs **SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE** only. Nothing
is written and no proof is spent, so it is safe against a loaded card.

### Reading the error box

`react-native-nfc-manager` constructs every one of its error classes with no
arguments, so `error.message` is always empty and the class *is* the diagnosis.
`describeCardFailure` maps them (`UserCancel` → "Read cancelled",
`RadioDisabled` → "NFC is turned off", `TagConnectionLost`/`TagNotConnected` →
"Card left the field", plus `Timeout`, `SessionInvalidated`, `SystemBusy` and
others), so "the radio is off" and "the card moved" are distinguishable on the
first hardware session. An unmapped class falls back to its own name rather than
a generic sentence.

A cancel shows no error at all, on either platform, but for two different
reasons — and both are needed:

- **Android** — the in-app **Cancel read** button sets a flag the screen checks
  before painting the box.
- **iOS** — that button is unreachable. `requestTechnology` presents a modal
  system scanning sheet over the app, so the only cancel available is the
  sheet's own, which rejects with `UserCancel` without touching the screen's
  flag. `isUserCancel(err)` catches that path.

Suppressing on the flag alone leaves a false "Read cancelled" failure on iOS —
the exact platform where the operator has no other way to cancel.

## Platform requirements

**Android** — nothing extra; IsoDep needs no manifest entry.

**iOS** — ISO 7816 requires the AID to be declared up front:

```xml
<key>com.apple.developer.nfc.readersession.iso7816.select-identifiers</key>
<array>
    <string>D2760000850102</string>      <!-- package AID -->
    <string>D276000085010201</string>    <!-- applet AID -->
</array>
```

Already added to `ios/flash_pos/Info.plist`. iOS will only `SELECT` identifiers
on this list — an unlisted AID fails at `requestTechnology`, not at SELECT, so
the error will not look like a card problem.

Both forms are declared because `selectApplet()` tries the 7-byte package AID
first (prefix match, matching `cardctl`) and falls back to the full 8-byte
applet AID for cards that do not support partial selection.

> ⚠️ **Unverified on iOS.** The entitlement is declared but has not been
> exercised against a real card or an App Store submission. Validate on a device
> before assuming iOS parity.

## Known gaps

- **Spending is not implemented.** `SPEND_PROOF` (`0xB0 0x20`) burns a slot
  *before* returning the signature, and it is irreversible. Wiring it needs the
  mint round-trip from `cashu-client` and a decision about what happens when the
  card marks a proof spent and the network call then fails.
- **No PIN handling.** `VERIFY_PIN` is unimplemented here. Spending needs no PIN
  by design (bearer semantics) — see `docs/DECISIONS.md#d12` in cashu-javacard —
  but `LOAD_PROOF` does.
- **No hardware validation of any kind.** See the status note at the top.
