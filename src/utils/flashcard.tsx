import {Alert} from 'react-native';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';

export const readFlashcard = async () => {
  try {
    const isSupported = await NfcManager.isSupported();
    const isEnabled = await NfcManager.isEnabled();

    if (!isSupported) {
      Alert.alert('NFC is not supported on this device');
      dismiss();
      return;
    }

    if (!isEnabled) {
      Alert.alert('NFC is not enabled on this device.');
      dismiss();
      return;
    }

    NfcManager.start();

    await NfcManager.requestTechnology(NfcTech.Ndef);

    const tag = await NfcManager.getTag();
    dismiss();
    if (tag) return tag;
  } catch (error) {
    console.error({error}, `can't fetch the Ndef payload`);
    Alert.alert(
      'E​r​r​o​r​ ​r​e​a​d​i​n​g​ ​N​F​C​ ​t​a​g​.​ ​P​l​e​a​s​e​ ​t​r​y​ ​a​g​a​i​n​.',
    );
    dismiss();
    return;
  }

  dismiss();
};

const dismiss = () => {
  NfcManager.cancelTechnologyRequest();
};
