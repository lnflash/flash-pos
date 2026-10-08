import {useCallback, useState} from 'react';
import {Alert} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech, TagEvent} from 'react-native-nfc-manager';

// hooks
import {useAppSelector} from '../store/hooks';
import {useFlashcard} from './useFlashcard';

// services
import {isAppletNotFound} from '../services/cashuCard';
import {readAndPlan} from '../services/cashuCharge';
import {
  describeCardFailure,
  extendCardTimeout,
  isUserCancel,
  nfcTransceiver,
} from '../services/cashuCardNfc';

// utils
import {hasLnurlwRecord, isIsoDepTag, mayCarryNdef} from '../utils/nfcTag';

// RootStackParamList is ambient (src/types/routes.d.ts).
type InvoiceNav = StackNavigationProp<RootStackType, 'Invoice'>;

/**
 * Reads the NDEF surface of the tag connected to the open session and, when
 * it carries an lnurlw record, returns the tag with that message attached.
 *
 * iOS hands `requestTechnology([IsoDep, Ndef])` callers an ISO7816 tag whose
 * `getTag()` NDEF read is best effort — a Flashcard v1 (BoltCard on an NTAG
 * 424 DNA) can arrive with no `ndefMessage` at all. `ndefHandler.getNdefMessage`
 * reads the same tag again inside the same session. Android attaches the
 * NDEF message to the dispatch intent, so this is rarely needed there, and
 * on a tag without an NDEF surface the bridge rejects — which is an answer,
 * not an error (ENG-614).
 */
async function readLnurlwTagInSession(
  tag: TagEvent,
): Promise<TagEvent | undefined> {
  try {
    const read = await NfcManager.ndefHandler.getNdefMessage();
    const ndefMessage = read?.ndefMessage;
    if (!ndefMessage?.length) {
      return undefined;
    }
    const withNdef: TagEvent = {...tag, ndefMessage};
    return hasLnurlwRecord(withNdef) ? withNdef : undefined;
  } catch (error) {
    console.log('[card-router] no NDEF surface on this tag', String(error));
    return undefined;
  }
}

/**
 * One NFC entry point for the invoice screen's card payments. Opens a
 * multi-tech session ([IsoDep, Ndef]) and routes by what the tapped tag
 * carries, not by what it can speak:
 *
 *   - a tag with an lnurlw NDEF record (a BoltCard; a Flashcard v1 is one on
 *     an ISO-DEP capable NTAG 424 DNA) → the lnurlw withdraw, handled in
 *     place by the Flashcard context, without ever SELECTing the Cashu
 *     applet;
 *   - an IsoDep javacard without such a record (a Cashu/Flashcard v2) is read
 *     and planned IN THIS session, then the charge screen opens straight on
 *     its PIN pad with the plan handed over — the customer's first tap is
 *     never wasted. If that SELECT answers "applet not found", the NDEF
 *     surface is read once more before giving up: an NTAG whose NDEF did not
 *     come through before the SELECT still lands on the BoltCard path.
 *
 * The session marks the Flashcard context busy so its Android
 * DiscoverTag listener (which sees the same reader-mode broadcast)
 * doesn't process the tag twice.
 *
 * Returns {routeCardPayment, isScanning}: isScanning drives the invoice's
 * CardTapSheet — on Android the armed reader is otherwise invisible.
 */
export function useCardPaymentRouter() {
  const navigation = useNavigation<InvoiceNav>();
  const {handleTag, setNfcBusy} = useFlashcard();
  const satAmount = Number(useAppSelector(state => state.amount.satAmount) ?? 0);
  const [isScanning, setIsScanning] = useState(false);

  const routeCardPayment = useCallback(async (): Promise<boolean> => {
    const isSupported = await NfcManager.isSupported();
    if (!isSupported) {
      Alert.alert('NFC is not supported on this device');
      return false;
    }
    const isEnabled = await NfcManager.isEnabled();
    if (!isEnabled) {
      Alert.alert('NFC is not enabled on this device.');
      return false;
    }
    if (!(satAmount > 0)) {
      Alert.alert('Enter an amount first');
      return false;
    }
    NfcManager.start();
    setNfcBusy(true);
    setIsScanning(true);

    try {
      const wantedTechs: NfcTech[] = [NfcTech.IsoDep, NfcTech.Ndef];
      await NfcManager.requestTechnology(wantedTechs);

      const tag = await NfcManager.getTag();
      if (!tag) {
        return false;
      }
      setIsScanning(false);

      // Evidence first: an lnurlw record makes this a BoltCard whatever
      // else the chip can do.
      if (hasLnurlwRecord(tag)) {
        handleTag(tag);
        return false;
      }

      if (isIsoDepTag(tag)) {
        if (!tag.ndefMessage && mayCarryNdef(tag)) {
          const lnurlwTag = await readLnurlwTagInSession(tag);
          if (lnurlwTag) {
            handleTag(lnurlwTag);
            return false;
          }
        }
        try {
          await extendCardTimeout();
          const preRead = await readAndPlan({
            transceive: nfcTransceiver,
            amountSat: satAmount,
          });
          // Close this session before the charge flow opens its own
          // tap → PIN → tap session.
          await NfcManager.cancelTechnologyRequest();
          navigation.navigate('CashuCardCharge', {preRead});
          return true;
        } catch (readError) {
          if (isAppletNotFound(readError)) {
            const lnurlwTag = await readLnurlwTagInSession(tag);
            if (lnurlwTag) {
              handleTag(lnurlwTag);
              return false;
            }
          }
          if (!isUserCancel(readError)) {
            Alert.alert(describeCardFailure(readError));
          }
          return false;
        }
      }
      handleTag(tag);
      return false;
    } catch (error) {
      // Cancel on the tap sheet (iOS) or our own cancelTechnologyRequest
      // rejects requestTechnology with UserCancel: the merchant backed out,
      // nothing failed.
      if (!isUserCancel(error)) {
        console.error({error}, "can't fetch the Ndef payload");
        Alert.alert(
          'E​r​r​o​r​ ​r​e​a​d​i​n​g​ ​N​F​C​ ​t​a​g​.​ ​P​l​e​a​s​e​ ​t​r​y​ ​a​g​a​i​n​.',
        );
      }
      return false;
    } finally {
      setNfcBusy(false);
      setIsScanning(false);
      NfcManager.cancelTechnologyRequest();
    }
  }, [handleTag, navigation, setNfcBusy, satAmount]);

  return {routeCardPayment, isScanning};
}
