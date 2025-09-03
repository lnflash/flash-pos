import React, {useRef} from 'react';
import {bech32} from 'bech32';
import {Dimensions} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import styled from 'styled-components/native';
import {usePrint} from '../hooks';
import {PrimaryButton} from '../components';
import {useAppSelector} from '../store/hooks';
import Logo from '../assets/icons/logo.png';
import {FLASH_LN_ADDRESS_URL, FLASH_LN_ADDRESS} from '@env';

global.Buffer = require('buffer').Buffer;

const {width} = Dimensions.get('screen');

const Paycode = () => {
  const {printPaycode} = usePrint();
  const {username} = useAppSelector(state => state.user);
  const qrCodeRef = useRef<string>();

  const lnurl = bech32.encode(
    'lnurl',
    bech32.toWords(
      Buffer.from(
        `${FLASH_LN_ADDRESS_URL}/.well-known/lnurlp/${username}`,
        'utf8',
      ),
    ),
    1500,
  );

  const qrCode = `${FLASH_LN_ADDRESS_URL}/${username}?lightning=${lnurl}`;

  const handleQRRef = (c: any) => {
    if (c?.toDataURL) {
      setTimeout(() => {
        c.toDataURL((base64Image: string) => {
          qrCodeRef.current = base64Image;
        });
      }, 100);
    }
  };

  return (
    <Wrapper>
      <Title>{`Pay ${username}@${FLASH_LN_ADDRESS}`}</Title>
      <Subtitle>
        {`Display this static QR code online or in person to allow anybody to pay ${username.toLowerCase()}.`}
      </Subtitle>
      <QrCodeWrapper>
        <QRCode
          size={width - 80}
          value={qrCode}
          logoBackgroundColor="white"
          logo={Logo}
          logoSize={60}
          logoBorderRadius={10}
          getRef={handleQRRef}
        />
      </QrCodeWrapper>
      <Description>
        Having trouble scanning this QR code with your wallet? Some wallets do
        not support printed QR codes like this one. Scan with the camera app on
        your phone to be taken to a webpage where you can create a fresh invoice
        for paying from any Lightning wallet.
      </Description>
      <PrimaryButton
        icon="print"
        btnText="Print QR code"
        onPress={() => printPaycode(qrCodeRef.current)}
      />
    </Wrapper>
  );
};

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-top: 20px;
  padding-horizontal: 20px;
`;

const QrCodeWrapper = styled.View`
  border-radius: 10px;
  background-color: #f0f0f0;
  padding: 20px;
  margin-vertical: 10px;
`;

const Title = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  text-align: center;
  color: #000;
  margin-bottom: 10px;
`;

const Subtitle = styled.Text`
  font-size: 15px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #939998;
`;

const Description = styled.Text`
  font-size: 11px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #939998;
  margin-bottom: 20px;
`;

export default Paycode;
