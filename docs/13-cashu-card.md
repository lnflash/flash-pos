# Cashu NFC Card (spike)

## Status

> **2026-09-26: this document's settlement and NFC sections are superseded by
> [`14-cashu-card-milestone-2026-09-26.md`](./14-cashu-card-milestone-2026-09-26.md)**
> — the first end-to-end customer payment ran on Android, and the charge flow,
> settlement pipeline, and every field-found defect are documented there.

**Hardware-validated on iOS (2026-09-23).** A dev build on an iPhone 13 Pro Max
(iOS 26.5) ran SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE against a loaded
JCOP4 J3R180 card over IsoDep, first session: applet version, balance and the
card's public key all returned and matched the PC-SC reference driver
(`cardctl` in cashu-javacard) read minutes earlier. The ISO-7816 entitlement
and AID list work as declared. Spending and PIN are still unimplemented (see
Known gaps), and Android is unexercised.

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

### Simulator e2e (no card, no reader)

Below the read button, **Card bridge** routes every card APDU (this screen's
read and the production charge and balance paths) to a `cardsim` bridge
instead of NFC: the real applet in jCardSim, from `lnflash/cashu-javacard`
`tools/cardsim`, on `http://127.0.0.1:9876`. Save sets it, Clear goes back to
NFC, and a restart forgets it. Dev builds only: `getCardBridge()` answers
`null` in a release build whatever was set. The Maestro flows set the same
bridge with the deep link `flashpos://dev/card-bridge?url=…`. The run book,
including the local mint and the six flows, is in
[docs/10-testing.md](./10-testing.md#e2e-testing-ecash-card-on-the-ios-simulator).

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

> ✅ **Verified on iOS (2026-09-23).** The entitlement and AID list worked
> against a real card on the first hardware session — both SELECT identifiers
> resolved and the four read APDUs completed over CoreNFC. App Store
> submission is still unexercised.

## Owed change (ENG-630)

A charge's swap mints the customer's change as P2PK proofs locked to their
card and writes them with `LOAD_PROOF`, one slot per power-of-two piece.
Between the swap and the last load the change exists only in the terminal's
memory — a `6A84` (no free slot) on the second piece, a tag lost mid-write or
a killed app would strand mint-signed proofs that only that card can spend.
Two things stand in that window (`src/services/cashuCharge.ts`,
`src/services/cashuSettlement.ts`):

- **Slot pre-flight, before the burn.** `readAndPlan` counts the card's empty
  slots and takes the first plan (cheapest change first) whose change fits
  (`selectFittingPlan`). Change still owed from an earlier charge is counted
  first — as much of it as the card has room for — but the bill wins: when
  no plan fits beside the owed pieces, the bill takes the empties and only
  the owed pieces with room left are written this tap; the rest stays `owed`
  on disk for a later tap and never refuses a charge the card can physically
  take (an exact bill needs no slot, and the full-with-change-owed card
  ENG-630 came from must be able to pay again). `executeCharge` re-checks
  the store before writing owed change, and any piece the store says was
  already attempted is reconciled against the card first (`GET_INFO`, slot
  statuses, `reconcileOwedChange`) — a LOAD whose answer was lost leaves the
  piece on the card and still `owed` on disk, and the card does not dedup —
  so a PIN-flow retry never re-sends a piece the first attempt landed,
  whether the store heard the answer or not. A first attempt skips the
  re-read. A card with no room for the plan's change is refused
  with "this card is full: …" before any `SPEND_PROOF`, and the screen says
  nothing was taken — and nothing else: a spend leaves its slot `spent`, not
  free, and nothing in the app clears spent slots yet (ENG-631).
- **The owed-change store** (`@cashu_owed_change`, a `{v, entries}` envelope
  separate from the settlement queue). `executeCharge` records every minted
  change piece as `owed` **before** the first `LOAD_PROOF`, and marks each
  `written` (with its slot) as the card answers. Whatever is still `owed` is
  written on the card's next tap: `reconcileOwedChange` first reads every
  non-empty slot it was not handed already (`readAndPlan` passes the unspent
  slots it just pulled, so only the spent ones cost an APDU — a lost LOAD
  answer leaves the piece on the card, and the card does not dedup) and marks
  any piece already there, then `writeOwedChange` loads the rest — counting
  each attempt (`markOwedChangeSending`) BEFORE its `LOAD_PROOF` goes out, so
  a `written` mark the keychain refuses after the card answered still reads
  as attempted and the retry reconciles instead of sending a twin. In a
  charge that happens after the PIN verify and before the burn (`LOAD_PROOF`
  is PIN-gated when a PIN is set); on the keypad's balance read a PIN-less card
  takes it in the same session and a PIN card is told what is waiting
  (`CashuCardBalance`). The balance tap is a read: a refused or lost write
  there never vetoes it, the screen opens with what is still waiting.
- **When the record itself did not land** (the keychain refused the write),
  the loads still run — the card is the only home left — and a load that
  then fails is thrown under `writing change to card (unrecorded)`, so the
  screen shows the card's reason and never claims the change is saved.

The store is the customer's money, not the merchant's: `pendingExposure`,
`hasUnsettledForCard` and the settlement banner ignore it by design. An
unreadable store throws rather than answering "nothing owed"; corrupt bytes
are quarantined under `@cashu_owed_change_corrupt:<hash>` and the reader then
answers with the entries that parsed (a store that could not be quarantined
throws) — one bad element must not refuse every Flashcard charge on the
terminal. Only `written` entries are ever evicted, and unknown fields from a
newer build ride through a write untouched. P2PK change for a card that never
returns stays in the store; nothing else can spend it.

## Known gaps

- **Spending is not implemented.** `SPEND_PROOF` (`0xB0 0x20`) burns a slot
  *before* returning the signature, and it is irreversible. Wiring it needs the
  mint round-trip from `cashu-client` and a decision about what happens when the
  card marks a proof spent and the network call then fails.
- **No PIN handling.** `VERIFY_PIN` is unimplemented here. Spending needs no PIN
  by design (bearer semantics) — see `docs/DECISIONS.md#d12` in cashu-javacard —
  but `LOAD_PROOF` does.
- **Hardware validation covers the read path only** (2026-09-23, iOS): the
  write path (`LOAD_PROOF`, `CLEAR_SPENT` — both PIN-gated) and spend
  (`SPEND_PROOF`) have not run from this app.
