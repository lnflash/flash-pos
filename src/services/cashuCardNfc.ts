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
 * Reader mode and Host Card Emulation are mutually exclusive on Android — a
 * session started here suppresses HCE until `cancelTechnologyRequest` runs,
 * which is why every path below is wrapped in try/finally.
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
    // Never let a failed read strand the reader session — that blocks HCE and
    // every subsequent tap until the app restarts.
    try {
      await NfcManager.cancelTechnologyRequest();
    } catch {
      // Teardown failure must not mask the original error.
    }
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
