import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

// hooks
import {useFlashcard} from './useFlashcard';

// services
import {CardError, readCard} from '../services/cashuCard';
import {
  cancelCardSession,
  describeCardFailure,
  extendCardTimeout,
  isCardReadingSupported,
  isUserCancel,
  nfcTransceiver,
} from '../services/cashuCardNfc';

// utils
import {hasLnurlwRecord, isIsoDepTag} from '../utils/nfcTag';
import {toastShow} from '../utils/toast';

// RootStackParamList is ambient (src/types/routes.d.ts).
type KeypadNav = StackNavigationProp<RootStackType, 'Keypad'>;

/** What the keypad session claims: a v2 javacard, or a v1 BoltCard's NDEF. */
export const KEYPAD_CARD_TECHS: NfcTech[] = [NfcTech.IsoDep, NfcTech.Ndef];

/** The CoreNFC sheet's prompt for the iOS one-shot read. */
export const IOS_BALANCE_SHEET_MESSAGE = 'Hold the card to check its balance';

/**
 * Breather before re-arming after a failed session. A request that rejects
 * at once (a bridge fault, a tag the stack refuses) would otherwise spin:
 * toast, re-arm, reject, toast, ... as fast as the bridge answers.
 */
export const REARM_AFTER_ERROR_MS = 750;

/**
 * An ISO-DEP tag that does not host the Flash applet (SW 0x6A82 on SELECT):
 * a bank card, a transit card, an old BoltCard without NDEF. Not a failure of
 * anything — say so quietly instead of raising an error.
 */
function isNotAFlashCard(error: unknown): boolean {
  if (error instanceof CardError && error.sw === 0x6a82) {
    return true;
  }
  return /applet not found/i.test(error instanceof Error ? error.message : '');
}


type SessionOutcome = 'routed' | 'cancelled' | 'failed' | 'busy';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The keypad's card reader: tap a Flashcard on the POS home screen and see
 * its balance, whichever generation it is.
 *
 * One multi-tech session ([IsoDep, Ndef]) and a route by what tapped:
 *   - an NDEF record starting `lnurlw` (Flashcard v1 / BoltCard) is handed to
 *     the Flashcard context's `handleTag`, the existing path — it fetches the
 *     BTCPay balance page and opens FlashcardBalance;
 *   - an IsoDep card with no such record (Flashcard v2 / Cashu javacard) is
 *     read IN THIS SESSION (SELECT → GET_INFO → GET_PUBKEY → GET_BALANCE,
 *     nothing written) and CashuCardBalance opens with the summary;
 *   - anything else goes to `handleTag` too, which already owns the UX for
 *     odd tags ("NDEF message not found.").
 *
 * Android: armed silently for as long as the keypad is focused. There is no
 * sheet, so a pending request is invisible; it also suppresses the context's
 * DiscoverTag listener app-wide and a second request rejects with
 * ERR_MULTI_REQ (see the header of services/cashuCardNfc.ts). Hence: one
 * session at a time (`armedRef`), cancelled on blur and unmount, always, and
 * re-armed only while the screen is still the focused one.
 *
 * iOS: never armed passively — a pending request puts the system scanning
 * sheet over the app. `readOnce` runs the same session once, on demand, under
 * the sheet, and does not re-arm.
 */
export function useKeypadCardReader() {
  const navigation = useNavigation<KeypadNav>();
  const {handleTag, setNfcBusy} = useFlashcard();
  const [reading, setReading] = useState(false);

  // A request is pending or a read is in flight. The ref, not the state, is
  // what the guard reads — correct even for two calls in one render tick.
  const armedRef = useRef(false);
  // Bumped on every focus and blur; a loop whose generation is stale stops.
  const focusGenRef = useRef(0);
  // The Android arm loop in flight, awaited before a new one starts so two
  // loops never overlap across a quick blur → focus.
  const loopRef = useRef<Promise<void>>(Promise.resolve());
  const handleTagRef = useRef(handleTag);

  useEffect(() => {
    handleTagRef.current = handleTag;
  }, [handleTag]);

  const runSession = useCallback(
    async (alertMessage?: string): Promise<SessionOutcome> => {
      if (armedRef.current) {
        return 'busy';
      }
      armedRef.current = true;
      setNfcBusy(true);
      setReading(true);
      try {
        // Synchronous up to the first await: a blur that lands after this
        // line finds a request to cancel, never a gap.
        if (alertMessage) {
          await NfcManager.requestTechnology(KEYPAD_CARD_TECHS, {alertMessage});
        } else {
          await NfcManager.requestTechnology(KEYPAD_CARD_TECHS);
        }
        const tag = await NfcManager.getTag();
        if (!tag) {
          return 'failed';
        }
        if (hasLnurlwRecord(tag) || !isIsoDepTag(tag)) {
          handleTagRef.current(tag);
          return 'routed';
        }
        await extendCardTimeout();
        const summary = await readCard(nfcTransceiver);
        // Close the session before the balance screen takes the foreground.
        await cancelCardSession();
        navigation.navigate('CashuCardBalance', {summary});
        return 'routed';
      } catch (error) {
        // Our own blur/unmount cancel, or the iOS sheet's Cancel button:
        // the operator's doing, not a failure.
        if (isUserCancel(error)) {
          return 'cancelled';
        }
        if (isNotAFlashCard(error)) {
          toastShow({message: 'Not a Flash card', type: 'info'});
          return 'failed';
        }
        toastShow({message: describeCardFailure(error), type: 'error'});
        return 'failed';
      } finally {
        await cancelCardSession();
        armedRef.current = false;
        setNfcBusy(false);
        setReading(false);
      }
    },
    [navigation, setNfcBusy],
  );

  // Android only: keep one request armed while focused, re-arming after
  // every session until the screen blurs.
  const armLoop = useCallback(
    async (gen: number) => {
      if (!(await isCardReadingSupported())) {
        return;
      }
      while (gen === focusGenRef.current) {
        const outcome = await runSession();
        if (
          (outcome === 'failed' || outcome === 'busy') &&
          gen === focusGenRef.current
        ) {
          await sleep(REARM_AFTER_ERROR_MS);
        }
      }
    },
    [runSession],
  );

  useFocusEffect(
    useCallback(() => {
      const gen = ++focusGenRef.current;
      if (Platform.OS === 'android') {
        loopRef.current = loopRef.current.then(() =>
          gen === focusGenRef.current ? armLoop(gen) : undefined,
        );
      }
      return () => {
        focusGenRef.current++;
        if (armedRef.current) {
          // Rejects the pending request with UserCancel; runSession's
          // finally then clears the busy flag and the loop sees a stale gen.
          cancelCardSession();
        }
        setNfcBusy(false);
      };
    }, [armLoop, setNfcBusy]),
  );

  /** iOS: one session under the system sheet. Safe to press twice. */
  const readOnce = useCallback(async () => {
    NfcManager.start();
    await runSession(IOS_BALANCE_SHEET_MESSAGE);
  }, [runSession]);

  return {readOnce, reading};
}
