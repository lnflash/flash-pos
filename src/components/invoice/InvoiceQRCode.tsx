import React from 'react';
import QRCode from 'react-native-qrcode-svg';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

// hooks
import {useAppSelector} from '../../store/hooks';
import {useWindowDimensions} from 'react-native';

// assets
import Logo from '../../assets/icons/logo.png';

type Props = {
  errMessage: string;
};

const InvoiceQRCode: React.FC<Props> = ({errMessage}) => {
  const {width} = useWindowDimensions();
  const {paymentRequest} = useAppSelector(state => state.invoice);

  return (
    <QrCodeWrapper>
      {!!errMessage ? (
        <ErrContainer width={width}>
          <Icon
            name={'triangle-exclamation'}
            size={80}
            solid
            color={'#db254e'}
          />
          <ErrText>{errMessage}</ErrText>
        </ErrContainer>
      ) : !paymentRequest ? (
        <ErrContainer width={width}>
          <Icon name={'clock'} size={80} solid color={'#666666'} />
          <ErrText>Generating payment request...</ErrText>
        </ErrContainer>
      ) : (
        <QRCode
          size={width - 80}
          value={paymentRequest}
          logoBackgroundColor="white"
          logo={Logo}
          logoSize={60}
          logoBorderRadius={10}
        />
      )}
    </QrCodeWrapper>
  );
};

export default InvoiceQRCode;

const QrCodeWrapper = styled.View`
  margin-top: 10px;
  background-color: #f0f0f0;
  padding: 20px;
  border-radius: 10px;
`;

const ErrContainer = styled.View<{width: number}>`
  width: 100%;
  height: ${({width}) => width - 80}px;
  align-items: center;
  justify-content: center;
`;

const ErrText = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  text-align: center;
  margin-top: 10px;
`;
