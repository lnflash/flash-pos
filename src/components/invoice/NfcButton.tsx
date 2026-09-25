import React, {useCallback, useEffect} from 'react';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';
import styled from 'styled-components/native';
import {Alert} from 'react-native';

// hooks
import {useFlashcard} from '../../hooks';

// RootStackParamList is ambient (src/types/routes.d.ts).
type InvoiceNav = StackNavigationProp<RootStackType, 'Invoice'>;

// One NFC icon, two card families: the multi-tech session lets the tap
// decide — an IsoDep javacard routes to the Cashu charge flow, an NDEF
// BoltCard to the lnurlw withdraw.

// assets
import NfcSignal from '../../assets/icons/nfc-signal.svg';

const NfcButton = () => {
  const navigation = useNavigation<InvoiceNav>();
  const {handleTag} = useFlashcard();

  const dismiss = useCallback(() => {
    NfcManager.cancelTechnologyRequest();
  }, []);

  const readFlashcard = useCallback(async () => {
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

      const wantedTechs: NfcTech[] = [NfcTech.IsoDep, NfcTech.Ndef];
      await NfcManager.requestTechnology(wantedTechs);

      const tag = await NfcManager.getTag();
      if (tag) {
        // Route by the detected tech: an IsoDep javacard is a Cashu card
        // (the charge flow runs its own tap→PIN→tap sessions); an NDEF tag
        // is a BoltCard — the lnurlw withdraw handles it in place.
        const techs = (tag.techTypes ?? []) as string[];
        if (techs.includes('IsoDep')) {
          await NfcManager.cancelTechnologyRequest();
          navigation.navigate('CashuCardCharge');
          return;
        }
        handleTag(tag);
      }
    } catch (error) {
      console.error({error}, 'can\'t fetch the Ndef payload');
      Alert.alert(
        'E​r​r​o​r​ ​r​e​a​d​i​n​g​ ​N​F​C​ ​t​a​g​.​ ​P​l​e​a​s​e​ ​t​r​y​ ​a​g​a​i​n​.',
      );
      dismiss();
      return;
    }

    dismiss();
  }, [dismiss, handleTag, navigation]);

  const renderHeaderRight = useCallback(
    () => (
      <Wrapper onPress={readFlashcard}>
        <Text>NFC</Text>
        <Image source={NfcSignal} />
      </Wrapper>
    ),
    [readFlashcard],
  );

  useEffect(() => {
    navigation.setOptions({
      headerRight: renderHeaderRight,
    });
  }, [navigation, renderHeaderRight]);

  return null;
};

export default NfcButton;

const Wrapper = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  border-radius: 8px;
  background-color: #f2f2f4;
  margin-right: 8px;
  padding-horizontal: 8px;
  padding-vertical: 5px;
`;

const Text = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  line-height: 24px;
  margin-right: 3px;
`;

const Image = styled.Image``;
