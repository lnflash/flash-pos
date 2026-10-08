import React, {useCallback, useEffect} from 'react';
import {useNavigation} from '@react-navigation/native';
import styled from 'styled-components/native';

// hooks
import {useCardPaymentRouter} from '../../hooks/useCardPaymentRouter';

// assets
import NfcSignal from '../../assets/icons/nfc-signal.svg';

const NfcButton = () => {
  const navigation = useNavigation();
  const {routeCardPayment} = useCardPaymentRouter();

  // The router owns the whole tap: the support/enabled checks, NfcManager
  // start, the session, the alerts and the merchant-cancel handling. Nothing
  // is caught here because routeCardPayment does not reject on tap failures
  // (it can still reject if the isSupported/isEnabled bridge calls throw).
  const readFlashcard = useCallback(async () => {
    await routeCardPayment();
  }, [routeCardPayment]);

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
