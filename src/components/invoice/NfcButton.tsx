import React, {useCallback, useEffect} from 'react';
import {useNavigation} from '@react-navigation/native';
import NfcManager, {NfcTech} from 'react-native-nfc-manager';
import styled from 'styled-components/native';
import {Alert} from 'react-native';

// hooks
import {useFlashcard} from '../../hooks';

// assets
import NfcSignal from '../../assets/icons/nfc-signal.svg';

const NfcButton = () => {
  const navigation = useNavigation();
  const {handleTag} = useFlashcard();

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => renderHeaderRight(),
    });
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

      await NfcManager.requestTechnology(NfcTech.Ndef);

      const tag = await NfcManager.getTag();
      if (tag) handleTag(tag);
    } catch (error) {
      console.error({error}, `can't fetch the Ndef payload`);
      Alert.alert(
        'E​r​r​o​r​ ​r​e​a​d​i​n​g​ ​N​F​C​ ​t​a​g​.​ ​P​l​e​a​s​e​ ​t​r​y​ ​a​g​a​i​n​.',
      );
      dismiss();
      return;
    }

    dismiss();
  }, []);

  const dismiss = useCallback(() => {
    NfcManager.cancelTechnologyRequest();
  }, []);

  const renderHeaderRight = () => (
    <Wrapper onPress={readFlashcard}>
      <Text>NFC</Text>
      <Image source={NfcSignal} />
    </Wrapper>
  );

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
