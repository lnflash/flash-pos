import {useCallback} from 'react';
import {Alert} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

// hooks
import {useFlashcard} from './useFlashcard';

// utils
import {isIsoDepTag} from '../utils/nfcTag';

// RootStackParamList is ambient (src/types/routes.d.ts).
type InvoiceNav = StackNavigationProp<RootStackType, 'Invoice'>;

/**
 * One NFC entry point for the invoice screen's card payments. Opens a
 * multi-tech session ([IsoDep, Ndef]) and routes by the tapped tag:
 *
 *   - an IsoDep javacard (a Cashu/Flashcard v2) → navigate to the charge
 *     flow, which runs its own tap → PIN → tap sessions;
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
    NfcManager.start();
    setNfcBusy(true);

    try {
      const wantedTechs: NfcTech[] = [NfcTech.IsoDep, NfcTech.Ndef];
      await NfcManager.requestTechnology(wantedTechs);

      const tag = await NfcManager.getTag();
      if (!tag) {
        return false;
      }

      if (isIsoDepTag(tag)) {
        // Close this session first so the charge flow can open its own
        // tap → PIN → tap session.
        await NfcManager.cancelTechnologyRequest();
        navigation.navigate('CashuCardCharge');
        return true;
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
  }, [handleTag, navigation, setNfcBusy]);
}
