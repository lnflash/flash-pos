import React, {useRef} from 'react';
import {bech32} from 'bech32';
import {Dimensions} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import styled from 'styled-components/native';

// hooks
import {usePrint} from '../hooks';

// components
import {PrimaryButton} from '../components';

// store
import {useAppSelector} from '../store/hooks';

// assets
import Logo from '../assets/icons/logo.png';

// env
import {FLASH_LN_ADDRESS_URL, FLASH_LN_ADDRESS} from '@env';

global.Buffer = require('buffer').Buffer;

const width = Dimensions.get('screen').width;

const Paycode = () => {
  const {printPaycode} = usePrint();
  const {username} = useAppSelector(state => state.user);

  const qrCodeRef = useRef();

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
          getRef={c => {
            if (c?.toDataURL) {
              c?.toDataURL((base64Image: any) => {
                qrCodeRef.current = base64Image;
              });
            }
          }}
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

export default Paycode;

const Wrapper = styled.View`
  flex: 1;
  align-items: center;
  background-color: #fff;
  padding-top: 20px;
  padding-horizontal: 20px;
`;

const QrCodeWrapper = styled.View`
  border-radius: 10px;
  background-color: #f0f0f0;
  padding: 20px;
  margin-vertical: 20px;
`;

const Title = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  text-align: center;
  color: #000;
  margin-bottom: 10px;
`;

const Subtitle = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #939998;
`;

const Description = styled.Text`
  font-size: 13px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #939998;
  margin-bottom: 20px;
`;
