# Cashu Card POS — Milestone Report (2026-09-26)

**Status: first successful end-to-end customer payment via Cashu card on Android, with the settlement pipeline hardened against every failure mode observed in the field.** This document is the handoff point: everything below was learned by running real hardware (a J3R180 JavaCard with the cashu applet v0.2) against the production mint (forge.flashapp.me), and every defect was fixed with a regression test or a field-verified recovery.

Companion docs: `13-cashu-card.md` (architecture of the card system), `06-nfc-integration.md` (NFC plumbing), and in the sibling repo `cashu-javacard/docs/HARDWARE_TEST_REPORT_2026-09-22.j3r180.md` (applet-side proofs).

---

## 1. What works as of this milestone

- **Two-tap card charge on Android**: Invoice → "Pay by Flashcard" → animated `CardTapSheet` → tap 1 (the router reads *and plans* in its own NFC session) → PIN pad directly → PIN auto-commits 4 digits → tap 2 (PIN verify → burn → mint swap → change write → balance read in one session) → Success screen.
- **The charge survived the real money path**: JMD$1 = 24 sats burned from the card [16+8], mint swap accepted, no change owed, success screen shown.
- **Self-healing settlement**: the drain retries failed entries (bounded), consults the mint's spend-state before resubmitting anything, backs off exponentially under the mint's rate limiter, and the pending-settlement banner now tells the truth (queue / settled / failed counts **and** the failed sat stakes) with working **Settle now** and **Settled elsewhere** operator controls.
- **App integration**: card charges record an `ecash` transaction (🪙 badge in Transaction History), reset the invoice, and pop the stack so Back from Success lands past the QR.
- **The card** holds 29 sats across 5 canonical, mint-verified spendable slots, PIN set (1234), applet v0.2.

## 2. Current state (exact, at handoff)

| Asset | State |
|---|---|
| Flashcard v2 (J3R180) | 29 sat, slots `[2,16,8,2,1]`, all unspent, all canonical secrets, PIN `1234`, reader-verified |
| forge.flashapp.me | Both JMD$1-charge proofs (16+8) **SPENT** (settled by hand, see §5); keyset `0059534ce0bfa19a`, `input_fee_ppk: 0` |
| Pixel (Android, 42201FDJG00048) | App on latest `main`, Metro-connected; settlement queue holds **one `pending` 8-sat entry from the JMD$1 charge** — see §7 open item |
| Max (iOS, 00008110-001E4CC014D8401E) | App on latest `main` via Metro; ledger clean (5 relic entries dismissed via "Settled elsewhere") |
| flash-pos `main` | `cfff018`; 30/30 suites, 495 tests green; tsc + eslint clean; CI green through `cfff018` |
| Tags | none new (last release: `v2.3.1` / `ios/v2.3.1` / `android/v2.3.1`) |

## 3. Defects found and fixed this session

Each entry: symptom → root cause → fix → commit. **Read the root causes before touching these areas again — every one of these was found with real money on real hardware.**

### 3.1 NFC router misrouted every Cashu card to the BoltCard flow — `a86993c`
- **Symptom**: "Pay by Flashcard" → tap the Cashu card → toast "NDEF message not found".
- **Root cause**: the router matched IsoDep via `tag.techTypes.includes('IsoDep')`, but the tag payload shape differs per platform: **Android** fills `techTypes` with fully-qualified class names (`'android.nfc.tech.IsoDep'`), and **iOS** does not populate `techTypes` at all — it sets `tech: 'IsoDep'` (singular; also missing from the library's own TS types). The check never matched, so Cashu cards fell through to the lnurlw handler, which found no NDEF.
- **Fix**: `src/utils/nfcTag.ts` — `isIsoDepTag()` handles both shapes (`tech === 'IsoDep'` for iOS; `techTypes` entries `'IsoDep'`/`'android.nfc.tech.IsoDep'` for Android). The router uses it; the Flashcard context's Android `DiscoverTag` listener is guarded by a `setNfcBusy` flag during router sessions (the reader-mode broadcast reaches both) so nothing double-processes a tap; `handleTag` returns silently for IsoDep tags instead of the misleading NDEF toast.

### 3.2 CI Build Check: Android keystore + iOS simulator destination — `41b6c02`, `134ce6d`
- **Android**: the workflow ran `keytool -genkeypair` on `android/app/debug.keystore`, which is **committed** (`.gitignore` has `!debug.keystore`) and already contains the `androiddebugkey` alias → "alias already exists" on every run. The generation step was removed.
- **iOS**: the build check hard-coded `-destination 'platform=iOS Simulator,name=iPhone 16'`; the runner's `latest-stable` Xcode moved to 26.3, which ships no such device → exit 70 before compiling. Now `-destination 'generic/platform=iOS Simulator'` (build-only check, drift-proof).
- **Lesson**: `latest-stable` Xcode + named simulator destinations will break again on runner updates; keep destinations generic in CI.

### 3.3 THE MONEY BUG: cashu-ts P2PK secrets are not byte-canonical — `5463c26`
- **Symptom**: first production-style charge burned the card, then every settlement swap failed with the mint's "Proofs could not be verified", on retry too. Five proofs (29 sat) were stranded: burned on-card, unspendable.
- **Root cause**: cashu-ts's `OutputData.createSingleP2PKData({pubkey, sigFlag: 'SIG_INPUTS'})` serializes the secret with **`"tags":[]`** (it only emits the sigflag tag for `SIG_ALL`). The spend-time reconstruction, `buildCardP2PKSecret`, always emits `"tags":[["sigflag","SIG_INPUTS"]]`. Different bytes → different `hashToCurve` → a different Y → the mint's issued `C` verifies against a Y the app never submits. **Any change proof minted through the cashu-ts path and written onto a card was born unspendable.** (cashu-client's `buildP2PKSecret` includes the tag, which is why toolchain-minted proofs always worked.)
- **Fix**: `makeCanonicalCardOutput()` in `src/services/cashuMint.ts` blinds the canonical secret bytes directly (via cashu-ts's exported `blindMessage`), and **both** card-bound change writers (`mintChargeChange`, the till-change maker) use it. Pinned by a byte-identity test against `buildCardP2PKSecret`.
- **Invariant to preserve forever**: the secret written onto a card must be byte-identical to what `buildCardP2PKSecret` rebuilds from `(nonce, cardPubkey)`. The card stores only `(keyset, amount, nonce, C)` — the kind/`[0]` element of the secret is *not* recoverable from card data.

### 3.4 The router's tap was wasted (3 taps per PIN'd payment) — `1dbe411`
- The router identified a Cashu card but cancelled the session, forcing the charge screen to re-read. Now the router runs `readAndPlan` **inside its own session** and hands the result to `CashuCardCharge` via navigation params (`preRead`, typed in `src/types/routes.d.ts`); the screen skips session 1 entirely (PIN card → straight to the pad; PIN-less → straight to the finish tap). Errors during the router's read alert on the invoice instead of navigating.

### 3.5 Android UX: silent arming + truncated toast + PIN friction — `69a29fd`
- `CardTapSheet` (src/components/cashu/CardTapSheet.tsx): animated bottom sheet (slide-up, backdrop fade, ripple rings around a card badge, charge amount, Cancel) driven by the router's new `isScanning` state; Android-only (iOS has the system NFC sheet). Replaced the truncating toast.
- PIN auto-commit: a full 4-digit entry auto-fires after a 700 ms settle (typing past 4 cancels; the button remains for 5–8 digit PINs and moved **above** the pad where it is visible).

### 3.6 Exact bills skipped settlement entirely — `d691a72`
- `executeCharge` only swapped when `changeSat > 0`, so an exact-bill charge (JMD$1 = 24 sat = exactly the 16+8 proofs) deferred settlement to the background drain — which failed silently, leaving the merchant's money queued while the mint showed the burned proofs unspent. Now **every online charge settles inline**; only a failed swap on an exact bill defers to the queue (nothing owed back to the card, so the customer's payment stands).

### 3.7 The drain could strand money permanently — `873adb5`, `bae6f82`, `ab27c2d`/`cfff018`
- **Failed entries were never retried**: the drain only attempted `pending`/`submitting`. A 429 mid-burst → `markFailed` → parked forever, invisible in the banner. Fix: failed entries re-attempt on later drains (bounded by `attempts < FAILED_RETRY_MAX = 8`), and the settlement adapter retries a literal HTTP 429 **once** before mapping (mint operation errors like 11002 are deliberately *not* retried there — they are the mint's verdict; `mapSwapError` owns them).
- **The banner under-reported**: it rendered only pending/submitting totals; failed settles were invisible. Now: failed count + **failedSat** (the stakes) + a **Settle now** button + a **"Settled elsewhere"** operator dismissal (`acknowledgeFailed` + `pruneFailed` — the designed retire path that previously had no UI). Exposure counts scope to *unacknowledged* failures only.
- **No retry cadence**: the drain fired only on app-foreground changes; a POS sitting in the foreground for hours stranded entries. Now a self-scheduling loop runs every 20 s **with exponential backoff (20 s → 4 min cap) while runs come back incomplete** — critical, because forge's rate limiter **sustains its block under steady pressure** (a fixed cadence re-arms it every tick; observed live: the throttle never cleared until the pressure stopped). Foreground events still trigger an immediate attempt.
- **Pending entries never got a spend-state check**: a proof settled out-of-band (operator recovery, second terminal) resubmitted into a 11001 that the pending path booked as a *fresh failure*. The drain now asks the mint first for **every** witnessed entry; already-held proofs settle as money-received.
- **Settle now stayed silent** when a run resolved nothing and swept nothing ("nothing settled to sweep" was invisible). It always speaks now.

### 3.8 The card flow was bifurcated from the app — `873adb5`
- A card charge skipped the lightning path's post-payment bookkeeping. Now: `addTransaction` (new `transactionType: 'ecash'`, `paymentMethod: 'card'`, 🪙 "Cashu Card" badge in Transaction History), `resetInvoice()` (the QR screen cannot resurrect a paid bill), and `navigation.pop(2)` + `navigate('Success')` so Back lands past the invoice — mirroring the lightning flow's stack shape.

## 4. Architecture as it stands

### Charge flow (two taps)
```
Invoice "Pay by Flashcard"
  └─ useCardPaymentRouter().routeCardPayment()
       ├─ checks: NFC supported/enabled, satAmount > 0
       ├─ setNfcBusy(true)  (Flashcard context stands down)
       ├─ isScanning(true)  → CardTapSheet slides up (Android)
       ├─ requestTechnology([IsoDep, Ndef]) → getTag()
       ├─ isIsoDepTag(tag)?
       │    ├─ YES → readAndPlan({transceive: nfcTransceiver, amountSat}) IN THIS SESSION
       │    │        → cancelTechnologyRequest → navigate('CashuCardCharge', {preRead})
       │    └─ NO  → handleTag(tag)  (BoltCard lnurlw, in place)
       └─ finally: setNfcBusy(false), isScanning(false), cancelTechnologyRequest()

CashuCardCharge (with preRead — session 1 skipped)
  └─ PIN pad → auto-commit at 4 digits (700 ms settle)
       └─ finish(plan, pin) → withCardSession (session 2):
            verify PIN → burn planned slots (SPEND_PROOF each; entries recorded
            'pending' with witness BEFORE any network) → mintChargeChange
            (ONE atomic swap: burned in → P2PK change to card + merchant take)
            → markEntriesSettled → appendSettledProofsTill → write change
            (LOAD_PROOF per change proof) → read balance
       → Success (pop(2) + navigate) → addTransaction('ecash') → resetInvoice()
       → runAutoSettlement(username) fire-and-forget
```
Without `preRead` (direct navigation), the screen runs its own session-1 `readAndPlan` first — same two-tap shape.

### Settlement queue state machine (`src/services/cashuSettlement.ts`)
```
recordSpend → pending (witness held; durable before any network)
drain claim → submitting  (durably claimed BEFORE the swap; outcome unknown if killed here)
swap OK                  → settled (proofs appended to the till store)
swap 429/5xx/timeout     → submitting (retried; checkState resolves)  [pending if provably unsent]
swap permanent rejection → failed (attempts++; retried by later drains while attempts < 8)
operator reconciliation  → failed + acknowledgedAt → pruned by pruneFailed()
```
- **Single-writer**: every mutation goes through `withQueue` (serialized promise tail).
- **Exposure honesty**: `pendingExposure` throws rather than reporting a clean till it cannot vouch for; the banner renders queue (pending+submitting+needs-card), settled, and unacknowledged-failed legs separately — **never summed across keyset units**.

### The banner (`PendingSettlementBanner.tsx`)
Polls `cashuOutstanding()` every 15 s + on foreground; renders all three legs with sat stakes; **Settle now** runs `runAutoSettlement` synchronously with toasts for every outcome; **"Settled elsewhere"** acknowledges + prunes failed entries (operator assertion that the value was reconciled outside the app).

## 5. Field-verified knowledge (do not re-learn these the hard way)

1. **forge's rate limiter sustains its block under steady pressure.** A fixed retry cadence re-arms it every tick and the throttle never clears (observed live for 3+ minutes). Anything that talks to forge in loops needs exponential backoff with a quiet window. One swap in a quiet window succeeds where six in a burst all die.
2. **Platform tag payloads differ** (iOS `tech: 'IsoDep'` vs Android `techTypes: ['android.nfc.tech.IsoDep']`) — see `src/utils/nfcTag.ts` before writing any tag-shape check.
3. **cashu-ts ≠ cashu-client secret serialization** for P2PK (tags). The canonical form is the tag-bearing one (`buildCardP2PKSecret` ≡ cashu-client `buildP2PKSecret`, pinned by fixture test). cashu-ts factories are only safe for outputs via `makeCanonicalCardOutput`.
4. **The card's PIN is session-scoped**: each PC/SC session (each `cardctl.py` invocation) needs `verify-pin` before any PIN-gated APDU. Two concurrent sessions to the ACR122U steal each other's card ("Card is unpowered") — never interleave subprocess cardctl calls with an open session (the recovery scripts serialize: parse dumps first, then one session for all signing).
5. **`SIGN_ARBITRARY` is the universal recovery tool**: it signs any 32-byte message with the card key without consuming a slot. A burned slot's witness can always be re-produced with it — the signature depends only on (privkey, message). This rescued 29 sat twice.
6. **The mint's swap is NOT atomic in the face of mixed-validity batches**: a batch with one bad proof can consume the good ones before rejecting (observed: 3 proofs marked spent, signatures never returned). Prefer per-proof swaps when any proof's validity is uncertain; the drain settles per-entry for exactly this reason.
7. **Nutshell checkstate takes `Ys`** (hash-to-curve points, hex, no 02-prefix), not secrets; unknown Ys read as UNSPENT — checkstate cannot prove a secret is *known*, only whether a Y is spent.
8. **The app logs nothing on drain failures by design** (the queue is the record). When debugging settlement, read the entry's `status`/`attempts`/`lastError` from the device store, or reproduce against the mint directly with the cashu-client toolchain (§6).
9. **Metro reloads reach every Metro-connected device** (Pixel via adb reverse tcp:8081 — *re-establish the reverse rule after adb/Metro churn or the Android app "fails to build"*, Max over LAN). iOS dev builds on Max are Metro-connected; the embedded bundle needs an xcodebuild rebuild instead.
10. **D13 PIN is session-scoped on the app side too**: session 1 (read+plan) never needs the PIN; session 2 verifies inside the same IsoDep session as the burns (`VERIFY_PIN` APDU precedes `SPEND_PROOF`s — test-pinned order).

## 6. Recovery tooling (field-proven)

All scripts lived in `/tmp` (ephemeral) — the two that matter, in runnable form:

**Re-sign burned proofs + settle them at the mint** (requires: card on the ACR122U, PIN 1234, cashu-client at `/Users/dread/Repos/cashu-client` with `dist/` built, cardctl venv at `cashu-javacard/tools/cardctl/.venv`):

1. Dump the card: `for i in 0 1 2 3 4 5 6 7; do ./.venv/bin/python cardctl.py proof $i 2>/dev/null; echo ---; done > /tmp/slots.txt` (from `tools/cardctl`).
2. In ONE python session (no subprocess card calls during signing): parse the dump → for each `spent` slot build the canonical secret `["P2PK",{"nonce":<lower>,"data":<pubkey>,"tags":[["sigflag","SIG_INPUTS"]]}]` → `msg = sha256(secret)` → `card.select(); card.verify_pin(b"1234"); sig = card.sign(msg).hex()` → verify with `check_signature(pubkey, msg, sig)`.
3. Swap each via cashu-client `swapProofs(MINT, [{id, amount, secret, C, witness: JSON.stringify({signatures:[sig]})}], [{id, amount, B_}])` with `createBlindedMessage(KEYSET, amount, CARD_PUBKEY)` outputs, `unblindSignature(sig.C_, b.r, keys[amount])` → recovered proofs.
4. Reload onto the card: one session — `verify_pin` → `clear_spent()` → `load_proof(keysetId, amount, nonce, C)` per proof.

**Mint ground truth**: POST `https://forge.flashapp.me/v1/checkstate` with `{"Ys": [hashToCurve(secret).toBytes(true).hex()]}` → `{states: [{state: 'SPENT'|'UNSPENT'}]}`. Space calls ≥60 s under throttle; `{"detail":"Rate limit exceeded."}` means back off, don't retry.

Known secret-variant gotcha: proofs minted by the old cashu-ts path serialize **tagless** (`"tags":[]`) — when recovering those, sign the hash of the TAGLESS secret string, not the canonical one (that is how the original 29-sat rescue worked).

## 7. Open items (in priority order)

1. **Pixel's pending 8-sat entry** (the live thread when this milestone was cut): "Settle now" reports "nothing settled to sweep" and the banner holds at "8 sat awaiting payout / 1 tapped payment". The entry's proof was already settled at the mint by hand (§2), and the new checkState pass *should* resolve it — the next diagnostic is reading the entry's `status`/`lastError` from the Pixel's store (`@cashu_settlement_queue` via AsyncStorage), because the current hypothesis is a **Y-mismatch class**: the entry's canonical secret hashes to a different Y than the one the mint issued the C against (the tagless-era lineage, §6), so checkstate legitimately answers `unspent` and every resubmit re-fails. If confirmed, the resolution is the same operator path Max used (the banner's failed line + "Settled elsewhere") once the entry exhausts retries into `failed` — or manually settling the entry's proof is unnecessary because the value is already on the card. **The deeper fix** (next milestone): a legacy-variant shim — on swap rejection, retry once with the tagless secret variant (the app holds the nonce; only the tags differ) — this would let the *app* recover old-path proofs instead of an operator.
2. **Consider storing the full secret on-card** (applet rev): the `(keyset, amount, nonce, C)` model cannot round-trip non-canonical secrets at all. A future applet version storing the serialized secret eliminates the entire reconstruction class of bugs.
3. **Sweep float semantics**: `keepReserveSat: 16` holds 16 sat in the till; the banner's `settledSat` includes float that will never sweep — consider showing "till float" separately.
4. **Roadmap (pre-existing)**: `UNBLOCK_PIN` + PUK before volume issuance; backend websocket for invoice status (prices already poll HTTP); backend sweep service; second card / fleet provisioning; `LOCK_CARD` on silicon; release-build promotion of the charge flow.
5. **Docs hygiene**: fold this report's settled knowledge into `13-cashu-card.md` (§4-5 supersede its settlement description) and `06-nfc-integration.md` (tag payload shapes).

## 8. Environment reference

| Thing | Value |
|---|---|
| Pixel 8 Pro (Android) | adb id `42201FDJG00048`; dev build `com.lnflash`; needs `adb reverse tcp:8081 tcp:8081` |
| iPhone 13 Pro Max "Max" (iOS) | udid `00008110-001E4CC014D8401E`, CoreDevice `810FE33E-9790-5BD9-AD8D-F985CBF85A23` |
| Flashcard v2 | J3R180, applet v0.2, PIN `1234`, pubkey `03ae9d74072ce6211584b2206e7b8063adce1b6faf5c89b0c928b131197b860c67` |
| Mint | forge.flashapp.me (Nutshell, NUT-07/11/12), active sat keyset `0059534ce0bfa19a`, `input_fee_ppk: 0` |
| cardctl | `cashu-javacard/tools/cardctl`, venv `./.venv/bin/python cardctl.py` — `info`, `slots`, `proof <i>`, `pubkey`, `balance`, `verify-pin <pin>`, `sign --message <hex>`, `load-file`, `clear-spent` |
| Reader | ACS ACR122U (USB); one PC/SC session at a time |
| flash-pos test suites | `npx jest --silent` (30 suites / 495 tests), `npx tsc --noEmit`, `npx eslint` |
| Session test artifacts | `/tmp/card_slots.txt`, `/tmp/card_post_charge.txt`, `/tmp/resigned_*.json`, `/tmp/recovered_proofs.jsonl`, `/tmp/verify_post.mjs`, `/tmp/checkstate.mjs` (ephemeral — recreate from §6 if gone) |

## 9. Verification state at handoff

- flash-pos `main` @ `cfff018`: 30/30 suites, 495 tests, tsc clean, eslint clean, CI green (Tests + Build Check all-jobs green since `134ce6d`).
- The complete commit chain this milestone, in order: `a86993c` (router fix) → `41b6c02`, `134ce6d` (CI) → `5463c26` (canonical secrets) → `1dbe411` (two-tap) → `69a29fd` (sheet + auto-PIN) → `d691a72` (exact-bill inline) → `873adb5` (drain self-heal + app sync) → `bae6f82` (backoff) → `a54f70b` (failedSat) → `2a56bf0` (operator dismiss) → `ab27c2d`/`cfff018` (pending checkState + honest toasts).
- Hardware-proven: the full two-tap charge (JMD$1), inline settlement of a change-bearing charge pre-fix, manual settlement + card reload twice, SIGN_ARBITRARY recovery twice, PIN flows on silicon, and the banner/banner-operator flows on both devices.
