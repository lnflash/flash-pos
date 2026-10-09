import {useCallback, useEffect, useRef, useState} from 'react';
import {Platform} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

// hooks
import {useFlashcard} from './useFlashcard';

// services
import {
  CardError,
  getSlotStatuses,
  readCard,
  type CardSummary,
} from '../services/cashuCard';
import {reconcileOwedChange, writeOwedChange} from '../services/cashuCharge';
import {
  outstandingChangeForCard,
  type OwedChangeEntry,
} from '../services/cashuSettlement';
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

const sumSat = (entries: OwedChangeEntry[]) =>
  entries.reduce((t, e) => t + e.amount, 0);

type BalanceParams = RootStackType['CashuCardBalance'];

/**
 * Change from an earlier charge that this card is still owed (ENG-630: a
 * LOAD refused mid-write, a tag lost, a killed app). A card with no PIN
 * takes it in this very session — LOAD_PROOF is only PIN-gated when a PIN
 * is set, and the keypad has no pad — and the balance is re-read so the
 * screen shows the card as it now is. A PIN card is told what is waiting;
 * the next charge writes it (`executeCharge`, after the PIN verify).
 *
 * A balance tap is a READ. The write is opportunistic, and nothing it does
 * may veto the read: the owed-change store failing, a slot read failing, or
 * the card refusing a LOAD (6A84 — full, with change owed, is exactly the
 * field case) all leave the summary true and the change recorded, and the
 * screen opens with what is still waiting. The next charge's `readAndPlan`
 * fails closed on its own.
 */
async function settleOwedChange(summary: CardSummary): Promise<BalanceParams> {
  let owed: OwedChangeEntry[] = [];
  try {
    owed = await outstandingChangeForCard(summary.pubkey);
  } catch {
    owed = [];
  }
  if (owed.length === 0) {
    return {summary};
  }
  if (summary.info.pinState !== 'unset') {
    return {summary, owedChangeSat: sumSat(owed)};
  }
  const now = Date.now();
  let remaining = owed;
  try {
    const statuses = await getSlotStatuses(
      nfcTransceiver,
      summary.info.maxSlots,
    );
    remaining = await reconcileOwedChange({
      transceive: nfcTransceiver,
      cardPubkey: summary.pubkey,
      statuses,
      now,
    });
    if (remaining.length === 0) {
      // Every piece was already on the card (a lost LOAD answer): nothing
      // was added now, so nothing is said about it.
      return {summary};
    }
    await writeOwedChange({transceive: nfcTransceiver, owed: remaining, now});
  } catch {
    // A piece may have landed before the refusal: show the balance as it is
    // now when the card will still answer, the pre-write one when it won't.
    const latest = await readCard(nfcTransceiver).catch(() => summary);
    return {
      summary: latest,
      owedChangeSat: await stillOwedSat(summary, remaining),
    };
  }
  return {
    summary: await readCard(nfcTransceiver),
    // Only what this tap put on the card — never the pieces reconcile found
    // already there.
    changeAddedSat: sumSat(remaining),
  };
}

/**
 * What the card is still owed after a write that did not finish.
 * `writeOwedChange` marks each piece as the card answers, so the store is
 * the truth when it reads; `fallback` (what the write was sent) when it
 * does not.
 */
async function stillOwedSat(
  summary: CardSummary,
  fallback: OwedChangeEntry[],
): Promise<number> {
  try {
    return sumSat(await outstandingChangeForCard(summary.pubkey));
  } catch {
    return sumSat(fallback);
  }
}

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
      // The focus generation this session belongs to. A blur mid-session
      // (Android: `cancelCardSession` kills the IsoDep channel under an
      // in-flight LOAD/GET_PROOF, which then rejects with a transceive
      // error, not UserCancel) bumps it; a session whose generation is
      // stale must neither open the balance sheet over the screen the
      // operator moved to nor toast at them there.
      const gen = focusGenRef.current;
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
        const params = await settleOwedChange(summary);
        // Close the session before the balance screen takes the foreground.
        await cancelCardSession();
        if (gen !== focusGenRef.current) {
          return 'cancelled';
        }
        navigation.navigate('CashuCardBalance', params);
        return 'routed';
      } catch (error) {
        // Our own blur/unmount cancel, or the iOS sheet's Cancel button:
        // the operator's doing, not a failure. The blur's cancel may also
        // surface as a transceive error from the APDU it cut off — a stale
        // generation says which it was.
        if (isUserCancel(error) || gen !== focusGenRef.current) {
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
