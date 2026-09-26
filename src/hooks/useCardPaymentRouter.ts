import {useCallback, useState} from 'react';
import {Alert} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

// hooks
import {useAppSelector} from '../store/hooks';
import {useFlashcard} from './useFlashcard';

// services
import {readAndPlan} from '../services/cashuCharge';
import {
  beginCardDispatch,
  describeCardFailure,
  endCardDispatch,
  isUserCancel,
  nfcTransceiver,
} from '../services/cashuCardNfc';

// utils
import {isIsoDepTag} from '../utils/nfcTag';

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
      await beginCardDispatch();
      await NfcManager.requestTechnology(wantedTechs);

      const tag = await NfcManager.getTag();
      if (!tag) {
        return false;
      }
      setIsScanning(false);

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
      setIsScanning(false);
      NfcManager.cancelTechnologyRequest();
      await endCardDispatch();
    }
  }, [handleTag, navigation, setNfcBusy, satAmount]);

  return {routeCardPayment, isScanning};
}
