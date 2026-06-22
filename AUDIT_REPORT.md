# Flash POS — Audit Report

**Repo:** `lnflash/flash-pos` @ `main` (commit `31e0225` — "#59 invoice guard, native support chat, PIN performance, timer")
**Date:** 2026-06-22
**Stack:** React Native 0.77.1 · TypeScript · Redux Toolkit + Contexts · NFC flashcards · BTCPay/Lightning payouts
**Method:** Four parallel deep-dives — security, architecture/code-quality, dependencies/build, tests/recent-work. Tests, typecheck, and lint were run locally.

> This report supersedes the previous audit (which targeted commit range `e0afb692..815578da`, the Merchant Rewards ID System v3 work). Most of that report's critical items have since been remediated — see "What's already good" below.

## Overall verdict

**Solid and noticeably improving — not yet release-ready.** The team has already remediated nearly every "critical" item from the previous audit, the supply-chain posture is genuinely good, and recent #59 work is well-guarded and tested. The remaining material risks are **payment-flow integrity** (double-payout, NFC trust) and **process gaps** (CI broken on a clean checkout, core money paths untested) — not credential leaks.

## ✅ What's already good

- **Previous audit largely fixed:** merchant-ID input is now sanitized (`src/utils/validation.ts`); flashcard LNURL/balance and the PIN moved to **Keychain** (`src/services/secureStorage.ts`); PIN uses **PBKDF2-SHA256** with constant-time compare and iteration upgrade; reward numeric inputs are bounded (`src/utils/rewardCalculations.ts`).
- **Supply chain:** no secrets/keystores committed; release signing **fails the build** if signing vars are missing (`android/app/build.gradle`); a `resolutions` block proactively pins past transitive CVEs (`lodash`, `ws`, `node-forge`, `shell-quote`, `picomatch`). `yarn audit`: **0 high/critical**.
- **Native config correct:** iOS ATS enforced (`NSAllowsArbitraryLoads=false`), encryption-export flag set (`ITSAppUsesNonExemptEncryption=false`), scoped NFC/location usage strings; Android minimal permissions (`NFC` + `INTERNET`, `allowBackup=false`), SDK 35 / minSdk 24 / NDK 27, new-arch + Hermes.
- **Tests:** 142 real-assertion tests across utils, slices, and services; clean typecheck and lint. The Invoice payment-confirmation suite (the #59 money-guard) is excellent — it covers PAID-but-confirm-pending, confirm errors, transient subscription errors, EXPIRED, and the "store only after network-only confirm" guard.

## 🔴 Top priorities (fix before production)

### 1. No idempotency / double-payout protection on BTCPay reward payouts — *High (money loss)*
`src/screens/Invoice.tsx:130-137` and `src/screens/Rewards.tsx:237` POST to `…/api/v1/pull-payments/{id}/payouts` with **no idempotency key**. The `Invoice.tsx` reward path also has **no cooldown** (the 5s lock exists only in `Rewards.tsx`), and its only guard — `completedPaymentHashRef` (`Invoice.tsx:159-162`), in memory — does not survive a remount / app-resume / subscription re-fire, nor an axios retry on the POST. A reward can be issued twice.

**Fix:** send a deterministic idempotency key derived from `paymentHash` on the payout POST (BTCPay Greenfield supports this), and **persist** "reward already sent for paymentHash X" rather than relying on an in-memory ref.

### 2. App trusts untrusted NFC tags for outbound requests and payout destination — *High (SSRF / fraud)*
`src/contexts/Flashcard.tsx:207-230` (`getHtml`) builds a URL entirely from the scanned tag payload (`lnurlw://…` → `https://…`) with **no host allowlist**, then `axios.get`s it and scrapes the HTML for an LNURL (`src/utils/flashcardParser.ts`, which even matches a bare token) that later becomes a payout **destination**. A cloned/malicious card can point the POS at any attacker host and inject a destination the merchant then funds.

**Fix:** validate the rewritten URL host against an allowlist of known boltcard/Flash domains; require HTTPS; validate the decoded LNURL domain before using it as a payout destination.

### 3. CI is green only by accident — fails on a clean checkout — *High (process)*
`.env` is gitignored and absent from the repo; `babel-plugin-dotenv-import` hard-fails at transform time without `REWARDS_ENABLED` / `BTC_PAY_SERVER`. The CI workflow (`.github/workflows/ci.yml`) never creates a `.env`, so **CI breaks on a fresh clone**. Verified locally: 6 suites fail without `.env`; after `cp .env.example .env`, all 18 suites / 142 tests pass.

**Fix:** add a `cp .env.example .env` (or a CI-provided `.env`) step before lint/typecheck/test in `ci.yml`.

### 4. Core money paths have zero test coverage — *High (confidence)*
Reward calculation is well tested, but the **orchestration** is not: `Flashcard.tsx` NFC read/balance/pay, `Invoice.sendRewardsToCard`, and `Rewards.onReward` payout flows — the three highest-risk money paths — are untested.

**Fix:** add integration tests for these three before further feature work. Also add `requestTechnology` / `getTag` to the NFC mock in `jest.setup.js` (currently missing, which will break any test importing the new `readFlashcard` util).

## 🟠 Medium

- **Hardcoded Chatwoot widget token** (`src/services/chatwoot/config.ts:11`), passed as a URL query param (`api.ts:28`). It is a *public* widget token (low blast radius — can create/spam support conversations, not read other tenants), but it should be rotated and moved to `@env` like the other endpoints; prefer header/body over query string.
- **PIN has no attempt lockout / throttling** (`src/store/slices/pinSlice.ts:125-169`). Hashing is strong, but guesses are unlimited. Add a persisted failed-attempt counter with exponential backoff / temporary lockout; consider raising PBKDF2 iterations (≥100k) for a money app.
- **Pervasive silent error-swallowing** on NFC / axios / payment / storage paths — empty `catch {}` / `else {}` in `Flashcard.tsx` (`196`, `256-260`, `299`), `Invoice.tsx:371`, `amountSlice.ts:125`, `ApolloClient.ts:58`, and several services. Failed scans/payments produce no log and no user feedback. Route through a central logger + user-facing toast.
- **Business logic trapped in 100-200-line screen callbacks:** `Rewards.onReward` (~200 lines, 20+ dep array), `Invoice.handleSuccessfulPayment` (~100 lines), `Keypad.onCreateInvoice`. Merchant-ID validation is duplicated across `EventSettings`, `RewardsSettings`, `Rewards`, and `Invoice`. Extract into hooks (`useRewardRedemption`, `useInvoicePayment`).
- **`src/store/slices/rewardSlice.ts` is a 611-line god-slice** mixing reward config, event config, and live tracking, with ~40 `(state: any)` selectors and a ~130-line duplicated default-config block. Split into config/event/tracking; type selectors with `RootState` (as `pinSlice.ts` already does).
- **Dual source of truth:** flashcard/payment state and the "loading" concept are split across Redux, an **unmemoized** `FlashcardContext` (`Flashcard.tsx:341-358` rebuilds `value` every render → re-renders the whole app), and `ActivityIndicatorContext`. Consolidate; memoize context values.
- **Build-toolchain advisories** (8 moderate: `js-yaml`, `@babel/core`) — dev/build-time only, not shipped. Clear via `resolutions` and re-audit.
- **TypeScript pinned to `5.0.4`** (RN 0.77 expects ~5.3+); **no `.nvmrc`/JDK-17 pin** (CI uses Node 20, `engines` says `>=18`); **CI is test-only** — no native build job, no scheduled `yarn audit`, and lint runs `--max-warnings 99999`.

## 🟡 Low (quick wins)

- `src/screens/Rewards.tsx:201` — a *failed* reward still consumes the 5s cooldown (`lastRewardTime` is set before the payout). Set it only inside the success branch.
- `src/utils/transactionHelpers.ts` — IDs/timestamps from `Date.now()` in rapid succession risk collisions in POS use. Use a UUID.
- New `src/utils/flashcard.tsx` (`readFlashcard`, iOS NFC util) has **invisible Unicode characters** in its `Alert` string (line ~31) and is not covered by the NFC mock.
- ~10 stray `console.*` in production paths; 10 TODO/FIXME (notably unfinished Apollo WS reconnection in `ApolloClient.ts:30,41`); 210 hardcoded hex colors with no theme file; payment `paymentSecret` retained in plaintext AsyncStorage transaction history (`store/index.ts`, `Invoice.tsx:219`).
- The 3 `patch-package` patches (`react-native-svg`, `react-native-screens`, `react-native-print`) are legitimate RN-0.77 compat shims. Track the `react-native-screens` one for removal once upstream fixes the regression.
- Jest prints "did not exit one second after the test run" — an unclosed async handle (likely a chatwoot socket/timer). Investigate with `--detectOpenHandles`.

## Recommended order

1. **Idempotency + persistent reward-sent guard** (#1) — highest money risk.
2. **NFC host / LNURL allowlist** (#2).
3. **Fix CI `.env`** (#3) — one line; unblocks trustworthy CI.
4. **Tests for the three untested money paths** (#4).
5. Then the Medium cluster — error handling, Chatwoot token rotation, PIN lockout, `rewardSlice` split, TS/CI tooling.

---

*Audit generated with Claude Code.*
