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

## Reader mode vs HCE — read this before extending

Android cannot be an NFC reader and a Host Card Emulation target at the same
time. `enableReaderMode` suppresses HCE for the life of the session. Our card is
a passive secure element, so the terminal **must** be the reader.

Consequence: if Flash POS ever also wants to accept taps from Cashu *phone*
wallets (which use HCE/NDEF, as [Numo](https://github.com/cashubtc/Numo) does),
the app has to switch modes explicitly. It cannot serve both at once.

Every session here is wrapped in `try/finally` around
`cancelTechnologyRequest()`. A stranded reader session blocks HCE and every
subsequent tap until the app restarts.

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

3. Run a **dev** build of Flash POS and navigate to `CashuCardDebug`:

   ```js
   navigation.navigate('CashuCardDebug');
   ```

   The screen is registered only under `__DEV__`, so it is absent from release
   builds and unreachable in production.

4. Tap. A pubkey on screen means the applet is installed, the AID selected over
   NFC, and the card's crypto answered.

The screen runs **SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE** only. Nothing
is written and no proof is spent, so it is safe against a loaded card.

## Platform requirements

**Android** — nothing extra. Reader mode needs no manifest entry.

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
