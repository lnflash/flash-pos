/**
 * Cashu NFC card — React Native IsoDep transport.
 *
 * Puts the phone into NFC *reader* mode and exchanges ISO 7816 APDUs with a
 * cashu-javacard applet. This is a different NFC role from the existing
 * Flashcard/BoltCard path in `contexts/Flashcard.tsx`, which reads NDEF text
 * off a tag — here we drive a smartcard conversation.
 *
 * Platform notes:
 *  - Android: `NfcTech.IsoDep`, no extra manifest entry needed for reader mode.
 *  - iOS: requires the `com.apple.developer.nfc.readersession.iso7816.select-identifiers`
 *    entitlement listing our AID (`D2760000850102`) in Info.plist, or
 *    `requestTechnology` rejects. See `docs/06-nfc-integration.md`.
 *
 * Why every path below is wrapped in try/finally — and why an abandoned session
 * is a payment bug, not just a leak:
 *
 * `requestTechnology` sets a pending `techRequest` inside the native module and
 * never times out on Android; it stays pending until a tag arrives. While it is
 * pending, `parseNfcIntent` claims every discovered tag for the IsoDep session
 * and returns without emitting `NfcManagerDiscoverTag`. That event is what
 * `FlashcardProvider` (contexts/Flashcard.tsx) listens on, so a session left
 * open here silently swallows BoltCard taps app-wide, on the live payment path.
 *
 * Note we are *not* in Android reader mode: `FlashcardProvider` already calls
 * `registerTagEvent()` at app start, so `NfcManagerAndroid.requestTechnology`
 * skips its own registration and `enableReaderMode` is never called. The
 * suppression above comes from the pending `techRequest`, not from reader mode.
 *
 * Anything that can start a session must therefore also be able to end one —
 * see `cancelCardSession`, which screens call on unmount.
 */
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

import {
  CardError,
  readCard,
  type CardSummary,
  type Transceiver,
} from './cashuCard';

/** Bridges our protocol layer onto nfc-manager's IsoDep handler. */
export const nfcTransceiver: Transceiver = async (apdu: number[]) => {
  const response = await NfcManager.isoDepHandler.transceive(apdu);
  // Android returns a byte array; iOS resolves [...data, sw1, sw2]. Both land
  // here as a plain array, which is what parseResponse expects.
  return Array.from(response as ArrayLike<number>);
};

export interface CardSessionOptions {
  /** iOS-only prompt shown in the system NFC sheet. */
  alertMessage?: string;
}

/**
 * Ends any in-flight IsoDep session, from outside the `withCardSession` frame.
 *
 * `withCardSession`'s `finally` only runs once a tag arrives or the read fails.
 * If the user starts a read and walks away — navigating back, backgrounding the
 * screen — nothing resolves and the pending `techRequest` keeps swallowing
 * BoltCard taps. Call this from an unmount cleanup and from any Cancel control.
 *
 * Safe to call when no session is open: cancelling nothing rejects with
 * `ERR_NO_TECH_REQ`, which is not an error worth surfacing.
 */
export async function cancelCardSession(): Promise<void> {
  try {
    await NfcManager.cancelTechnologyRequest();
  } catch {
    // No session to cancel, or the bridge is gone. Either way there is nothing
    // left to clean up and nobody to tell.
  }
}

/**
 * Runs `fn` inside an IsoDep reader session, always tearing the session down.
 *
 * The technology request resolves when a card enters the field, so the promise
 * is pending for as long as the user takes to tap.
 */
export async function withCardSession<T>(
  fn: (transceive: Transceiver) => Promise<T>,
  {alertMessage = 'Hold the Flash card to the phone'}: CardSessionOptions = {},
): Promise<T> {
  await NfcManager.requestTechnology(NfcTech.IsoDep, {alertMessage});
  try {
    return await fn(nfcTransceiver);
  } finally {
    // Never let a failed read strand the session — a pending techRequest
    // swallows every subsequent tap app-wide, including BoltCard payments.
    // cancelCardSession never throws, so it cannot mask the original error.
    await cancelCardSession();
  }
}

/**
 * Tap a card and read its public state. Touches nothing — no proof is spent.
 *
 * This is the hardware bring-up check: if this returns, the applet is installed,
 * the AID selects, and the card's crypto is answering.
 */
export async function readCardOverNfc(
  options?: CardSessionOptions,
): Promise<CardSummary> {
  return withCardSession(readCard, options);
}

/** True when the device can actually do this — check before offering card payment. */
export async function isCardReadingSupported(): Promise<boolean> {
  try {
    return (await NfcManager.isSupported()) && (await NfcManager.isEnabled());
  } catch {
    return false;
  }
}

/** Turns any thrown value into something worth showing a merchant. */
export function describeCardFailure(error: unknown): string {
  if (error instanceof CardError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message || 'Card read failed';
  }
  return 'Card read failed';
}
