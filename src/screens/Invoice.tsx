import React, {useEffect, useState} from 'react';
import {Share} from 'react-native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {
  Amount,
  ExpireTime,
  InvoiceQRCode,
  PrimaryButton,
  TextButton,
} from '../components';

// hooks
import {useNfc} from '../hooks';
import {useAppSelector} from '../store/hooks';

// utils
import {toastShow} from '../utils/toast';
import {useSubscription} from '@apollo/client';

// gql
import {LnInvoicePaymentStatus} from '../graphql/subscriptions';

type Props = StackScreenProps<RootStackType, 'Invoice'>;

const Invoice: React.FC<Props> = ({navigation}) => {
  const {paymentRequest} = useAppSelector(state => state.invoice);
  const [errMessage, setErrMessage] = useState('');

  const {loading, data, error} = useSubscription(LnInvoicePaymentStatus, {
    variables: {
      input: {paymentRequest},
    },
    skip: !paymentRequest,
  });

  useNfc(paymentRequest);

  useEffect(() => {
    if (data) {
      const {status, errors} = data.lnInvoicePaymentStatus;
      if (status === 'PAID') {
        navigation.navigate('Success');
      } else if (errors.length > 0 || error?.message) {
        console.log('Payment Status Error: ', errors, error?.message);
        setErrMessage(
          'Please try again. Either the invoice has expired or it hasn’t been paid.',
        );
      }
    } else if (error) {
      console.log('Payment Status Error Message: ', error?.message);
      setErrMessage(error.message);
    }
  }, [loading, data, error]);

  const onCopy = () => {
    if (!errMessage) {
      Clipboard.setString(paymentRequest);
      toastShow({message: 'Copied!'});
    }
  };

  const onShare = async () => {
    if (!errMessage) {
      await Share.share({message: paymentRequest});
    }
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <Amount hideCurrency hideToggle />
        <ExpireTime setErrMessage={setErrMessage} />
        <InvoiceQRCode errMessage={errMessage} />
        <RowWrapper>
          <TextButton icon="clone" title="Copy" onPress={onCopy} />
          <TextButton
            icon="arrow-up-from-bracket"
            title="Share"
            onPress={onShare}
          />
        </RowWrapper>
      </InnerWrapper>
      <PrimaryButton btnText="Back" onPress={() => navigation.goBack()} />
    </Wrapper>
  );
};

export default Invoice;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 20px;
  padding-horizontal: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
`;

const RowWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  margin-horizontal: 10px;
`;
