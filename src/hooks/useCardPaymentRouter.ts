import {useCallback} from 'react';
import {Alert, Platform} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

// hooks
import {useAppSelector} from '../store/hooks';
import {useFlashcard} from './useFlashcard';

// services
import {readAndPlan} from '../services/cashuCharge';
import {
  describeCardFailure,
  isUserCancel,
  nfcTransceiver,
} from '../services/cashuCardNfc';

// utils
import {isIsoDepTag} from '../utils/nfcTag';
import {toastShow} from '../utils/toast';

// RootStackParamList is ambient (src/types/routes.d.ts).
type InvoiceNav = StackNavigationProp<RootStackType, 'Invoice'>;

/**
 * One NFC entry point for the invoice screen's card payments. Opens a
 * multi-tech session ([IsoDep, Ndef]) and routes by the tapped tag:
 *
 *   - an IsoDep javacard (a Cashu/Flashcard v2) is read and planned IN THIS
 *     session, then the charge screen opens straight on its PIN pad with the
 *     plan handed over — the customer's first tap is never wasted;
 *   - an NDEF BoltCard → the lnurlw withdraw, handled in place by the
 *     Flashcard context.
 *
 * The session marks the Flashcard context busy so its Android
 * DiscoverTag listener (which sees the same reader-mode broadcast)
 * doesn't process the tag twice.
 *
 * Returns true when the tap routed to the Cashu charge flow (the caller may
 * want to stop rendering its own payment prompts), false otherwise.
 */
export function useCardPaymentRouter() {
  const navigation = useNavigation<InvoiceNav>();
  const {handleTag, setNfcBusy} = useFlashcard();
  const satAmount = Number(useAppSelector(state => state.amount.satAmount) ?? 0);

  return useCallback(async (): Promise<boolean> => {
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
    if (Platform.OS === 'android') {
      // Android arms the reader silently — no system sheet like iOS — so
      // say what the press did, or the merchant reads the button as dead.
      toastShow({
        message: `Charge ${satAmount} sat — hold the customer's card to the reader`,
        type: 'info',
      });
    }

    try {
      const wantedTechs: NfcTech[] = [NfcTech.IsoDep, NfcTech.Ndef];
      await NfcManager.requestTechnology(wantedTechs);

      const tag = await NfcManager.getTag();
      if (!tag) {
        return false;
      }

      if (isIsoDepTag(tag)) {
        try {
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
          if (!isUserCancel(readError)) {
            Alert.alert(describeCardFailure(readError));
          }
          return false;
        }
      }
      handleTag(tag);
      return false;
    } catch (error) {
      console.error({error}, "can't fetch the Ndef payload");
      Alert.alert(
        'E​r​r​o​r​ ​r​e​a​d​i​n​g​ ​N​F​C​ ​t​a​g​.​ ​P​l​e​a​s​e​ ​t​r​y​ ​a​g​a​i​n​.',
      );
      return false;
    } finally {
      setNfcBusy(false);
      NfcManager.cancelTechnologyRequest();
    }
  }, [handleTag, navigation, setNfcBusy, satAmount]);
}
