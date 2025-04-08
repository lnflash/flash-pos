import React, {useCallback, useEffect, useState} from 'react';
import {Share} from 'react-native';
import styled from 'styled-components/native';
import Clipboard from '@react-native-clipboard/clipboard';
import {StackScreenProps} from '@react-navigation/stack';
import {useFocusEffect} from '@react-navigation/native';
import {URL} from 'react-native-url-polyfill';

// components
import {
  Amount,
  ExpireTime,
  InvoiceQRCode,
  PrimaryButton,
  TextButton,
} from '../components';
import {ActivityIndicator} from '../contexts/ActivityIndicator';

// hooks
import {useFlashcard} from '../hooks';
import {useAppDispatch, useAppSelector} from '../store/hooks';

// utils
import {toastShow} from '../utils/toast';
import {useSubscription} from '@apollo/client';

// gql
import {LnInvoicePaymentStatus} from '../graphql/subscriptions';

// store
import {resetInvoice} from '../store/slices/invoiceSlice';

type Props = StackScreenProps<RootStackType, 'Invoice'>;

const Invoice: React.FC<Props> = ({navigation}) => {
  const dispatch = useAppDispatch();
  const {paymentRequest} = useAppSelector(state => state.invoice);

  const [paymentLoading, setPaymentLoading] = useState(false);
  const [errMessage, setErrMessage] = useState('');

  const {k1, callback, loading, resetFlashcard} = useFlashcard();

  const {data, error} = useSubscription(LnInvoicePaymentStatus, {
    variables: {
      input: {paymentRequest},
    },
    skip: !paymentRequest,
  });

  useEffect(() => {
    if (data) {
      const {status, errors} = data.lnInvoicePaymentStatus;
      if (status === 'PAID') {
        setPaymentLoading(false);
        dispatch(resetInvoice());
        navigation.replace('Success');
      } else if (errors?.length > 0) {
        console.error('Payment Status Error:', errors);
        setPaymentLoading(false);
        setErrMessage(
          'Please try again. Either the invoice has expired or it hasn’t been paid.',
        );
      }
    } else if (error) {
      console.error('Payment Status Error Message:', error?.message);
      setPaymentLoading(false);
      setErrMessage(error.message || 'An unexpected error occurred.');
    }
  }, [data, error]);

  useFocusEffect(
    useCallback(() => {
      if (loading || !k1 || !callback || !paymentRequest) return;
      payUsingFlashcard();
    }, [loading, k1, callback, paymentRequest]),
  );

  const payUsingFlashcard = async () => {
    if (!k1 || !callback) return;

    try {
      setPaymentLoading(true);
      const urlObject = new URL(callback);
      urlObject.searchParams.set('k1', k1);
      urlObject.searchParams.set('pr', paymentRequest);
      const url = urlObject.toString();

      const result = await fetch(url);
      const lnurlResponse = await result.json();
      console.log('LNURL Response:', lnurlResponse);

      resetFlashcard();
      if (lnurlResponse.status === 'ERROR') {
        setPaymentLoading(false);
        toastShow({message: lnurlResponse.reason, type: 'error'});
      }
    } catch (error) {
      console.error('Error processing payment:', error);
      setPaymentLoading(false);
      toastShow({message: 'Payment failed. Please try again.', type: 'error'});
    }
  };

  const onCopy = () => {
    if (!errMessage) {
      Clipboard.setString(paymentRequest);
      toastShow({message: 'Copied!'});
    }
  };

  const onShare = async () => {
    if (!errMessage) {
      try {
        await Share.share({message: paymentRequest});
      } catch (error) {
        console.error('Error sharing invoice:', error);
      }
    }
  };

  if (paymentLoading) return <ActivityIndicator />;

  return (
    <Wrapper>
      <InnerWrapper>
        <Amount hideCurrency hideToggle />
        <ExpireTime setErrMessage={setErrMessage} />
        <InvoiceQRCode errMessage={errMessage} />
        {!errMessage && (
          <RowWrapper>
            <TextButton icon="clone" title="Copy" onPress={onCopy} />
            <TextButton
              icon="arrow-up-from-bracket"
              title="Share"
              onPress={onShare}
            />
          </RowWrapper>
        )}
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
