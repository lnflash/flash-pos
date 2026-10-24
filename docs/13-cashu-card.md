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

- [`cashucard/javacard`](https://github.com/cashucard/javacard) — the
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
  that can start a session must cancel it when it leaves, and should offer a
  visible Cancel control while a read is in flight. Use
  `useCardSessionRelease` (`src/hooks/useCardSessionRelease.ts`): it cancels
  from `beforeRemove`, as the stack lets the screen go, and falls back to an
  unmount cancel only when no `beforeRemove` came first. An unmount cancel
  alone runs too late: the stack unmounts a popped screen at the end of its
  close transition, after the keypad underneath has armed its own request, so
  the cancel would close the keypad's tag mid-read (ENG-704). A screen with its
  own `beforeRemove` listener that can refuse the pop (`CashuCardCharge`) calls
  the returned `release` from its let-through branches only.

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
instead of NFC: the real applet in jCardSim, from `cashucard/javacard`
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
    <string>F043415348554341524401</string>  <!-- 2.0 applet AID: selected first -->
    <string>F0434153485543415244</string>    <!-- 2.0 package AID ("CASHUCARD"): fallback -->
    <!-- … the BoltCard NDEF AIDs … -->
    <string>D2760000850102</string>          <!-- 0.x package AID: detection only -->
    <string>D276000085010201</string>        <!-- 0.x applet AID: detection only -->
    <string>F0464F585943415244</string>      <!-- Foxy 1.x AID: detection only -->
</array>
```

Already added to `ios/flash_pos/Info.plist`. iOS will only `SELECT` identifiers
on this list — an unlisted AID fails at `requestTechnology`, not at SELECT, so
the error will not look like a card problem.

Both forms of each AID are declared because `selectApplet()` tries the full
applet AID first (`F0 CASHUCARD 01`, the one Foxy's wallet selects) and falls
back to the package AID only when the full AID answers `6A82`. The package AID
is a prefix, and on a real J3R180 provisioned as documented (the opener
`F0 CASHUCARD 4D` installed first, then the applet, then the tag) a SELECT by
it reaches the opener, which answers `9000` with no version and `6D00` to the
next command (ENG-681). So a `9000` from the package AID with an empty body
(the opener's only answer) falls through to the old-AID probe instead of
reading as "This card needs an update". A `9000` from it with a `02 xx`
version is the applet; one with any other body (`03 00`, `01 14`, one byte)
is an applet running other software, and still reads as "This card needs an
update".

**Protocol 2.0 (ENG-674).** The terminal speaks the shared Cashu card
protocol 2.0 (cashu-javacard `spec/APDU.md`): the 2.0 applet AID is tried
first. Following cardsim's contract (`tools/cardsim/README.md`, "Old cards"),
any answer to it but `02xx 9000` or `6A82` — another version, an empty body, a
`6E00` or `6999` — is **"This card needs an update"**. A card where neither
2.0 AID reaches the applet (the full AID answers `6A82`, the package AID
`6A82` or a `9000` with an empty body) is asked for the old AIDs (0.x, and Foxy's 1.x
`F0 46 4F 58 59 43 41 52 44`, which `spec/APDU.md` also names); one that
answers is an old card, and the terminal says **"This card needs an update"**
and sends nothing else — no PIN pad, no write, no spend
(`CardNeedsUpdateError`). The old AIDs stay in the list for exactly that:
dropping them would hide an old card from CoreNFC instead of telling its
holder. A card that answers `6A82` to all of them is not an eCash card, and
the BoltCard/LNURLw path reads it. A 0.x card's funds are swept by an
operator (a release precondition), never by this app.

Before anything is planned, `readAndPlan` refuses a card its owner has
locked (`LOCK_CARD`, GET_INFO byte 10: "This card is locked and can't be used
to pay." — it loads nothing more, so a payment's change could never go back
on), a card whose pieces are not format 4 (GET_INFO byte 8, GET_CARD byte 0:
needs an update) and a card whose unit is not sat (GET_CARD byte 2). It plans
from the short listing (`GET_PIECES` P2 = 3, `spec/APDU.md` "Payment Flow")
and reads only the chosen slots whole, by name (P2 = 2), each held to what
the listing said.

On a 2.0 card a payment is ONE NUT-11 SIG_ALL signature (`SPEND_ALL_*`) over
the pieces, the merchant's outputs and the card's own change, which the card
makes for itself (`SPEND_ALL_CHANGE`) and the terminal finishes from the
card's openings (`GET_CHANGE`) after the swap. Before a payment the till
shows the card the Bitcoin tip header (`SET_HEADER`; mempool.space, then
blockstream.info, or the build's optional `FLASH_HEADER_APIS`, read through
`@env-optional` so a build without it still builds), which is the clock the
card's daily limit and no-PIN allowance run on. A balance read checks `AUTH`:
a card that cannot prove its key fails the read.

A charge is never a success without a signature that verifies against the
payment: a SIGN answer that was lost (`needs-card`) or one that does not
verify (`failed`) ends the charge as "Not confirmed yet", never "Paid", and
never offers a re-charge. A swap the mint refuses outright after the card
signed ends as "Not paid — the mint refused it" with Done only: the card has
burned, so "Tap card again" would burn it a second time. Whenever the mint
answers, the cached keysets and fees are refreshed before the card signs,
exact bills included.

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
  already attempted is reconciled against the card first (`GET_CHANGE`,
  `reconcileOwedChange`) — a LOAD whose answer was lost leaves the piece on
  the card and still `owed` on disk — so a PIN-flow retry never re-sends a
  piece the first attempt landed, whether the store heard the answer or not
  (and a 2.0 card answers a LOAD of a piece it already holds with `6A94`,
  which the terminal reads as landed). A first attempt skips the re-read. A
  card with no room for the plan's change is refused with "this card is
  full: …" before it is asked to sign, and the screen says
  nothing was taken — and nothing else: a spend leaves its slot `spent`, not
  free, and nothing in the app clears spent slots yet (ENG-631).
- **The owed-change store** (`@cashu_owed_change`, a `{v, entries}` envelope
  separate from the settlement queue; v2 since protocol 2.0). On a 2.0 card
  the change is the card's own (`SPEND_ALL_CHANGE`): `executeCharge` records
  the mint's half of every change piece — the blinded message `B_`, the blind
  signature `C_` and its DLEQ — as `owed` **before** the first `LOAD_PROOF`,
  then finishes each piece from the card's opening (`GET_CHANGE`: nonce, r,
  date) and loads it with the mint's proof, marking each `written` as the
  card answers. Whatever is still `owed` is finished on the card's next tap:
  `reconcileOwedChange` reads the card's openings — a piece whose opening is
  gone is on the card (the card lets an opening go only once its piece
  lands) and is marked written; the rest are opened (C = C_ − r·K, with the
  mint keys kept on the terminal) — then `writeOwedChange` loads them,
  counting each attempt (`markOwedChangeSending`) BEFORE its `LOAD_PROOF`
  goes out. In a charge that happens after the PIN verify and before the
  burn; on the keypad's balance read a PIN-less card, or one whose GET_INFO
  says the change may go on with no PIN (the tap after a payment), takes it
  in the same session, and any other PIN card is told what is waiting
  (`CashuCardBalance`) — a LOAD the card would refuse for want of the PIN is
  never sent. The balance tap is a read: a refused or lost write there never
  vetoes it, the screen opens with what is still waiting. 0.x change
  (terminal-made SIG_INPUTS pieces) is kept on record and never written to a
  2.0 card.
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

- **Protocol 2.0 on silicon.** The 2.0 card layer (ENG-674) is proven
  against the applet in cardsim (jest's replay of the applet's transcript and
  the simulator e2e) and a local Nutshell 0.20.3; it has not yet run against
  a 2.0 card on silicon from this app.
- **A lost SIGN answer with the card gone.** When SPEND_ALL_SIGN's answer is
  lost and the card cannot even be asked which places are spent, the charge
  fails as not paid, as a lost burn did on 0.x. The burn is the last thing
  the card's commit does, so this needs the card to leave in the few
  milliseconds between the commit and the answer.
- **No till-held owner key.** The till never holds an owner key: owner
  commands (`SET_OWNER`, `ALLOW_LOAD`, `SET_LIMIT`, `REFRESH`) are the
  holder's phone's (flash-mobile).
