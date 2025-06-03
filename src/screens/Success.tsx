import React, {useEffect} from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {PrimaryButton, SecondaryButton} from '../components';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {usePrint} from '../hooks';

// assets
import Check from '../assets/icons/check.svg';

// store
import {resetAmount} from '../store/slices/amountSlice';
import {resetInvoice} from '../store/slices/invoiceSlice';
import {addTransaction} from '../store/slices/transactionHistorySlice';

type Props = StackScreenProps<RootStackType, 'Success'>;

const Success: React.FC<Props> = ({navigation, route}) => {
  const {printSilently, printReceipt} = usePrint();

  const dispatch = useAppDispatch();
  const {satAmount, displayAmount, currency, isPrimaryAmountSats, memo} =
    useAppSelector(state => state.amount);
  const {username} = useAppSelector(state => state.user);
  const {paymentHash, paymentRequest, paymentSecret} = useAppSelector(
    state => state.invoice,
  );
  const {lastTransaction} = useAppSelector(state => state.transactionHistory);

  // Create and store transaction data when component mounts
  useEffect(() => {
    const transactionData: TransactionData = {
      id: paymentHash || `tx_${Date.now()}`,
      timestamp: new Date().toISOString(),
      amount: {
        satAmount: Number(satAmount) || 0,
        displayAmount: displayAmount || '0',
        currency,
        isPrimaryAmountSats: isPrimaryAmountSats || false,
      },
      merchant: {
        username: username || 'Unknown',
      },
      invoice: {
        paymentHash: paymentHash || '',
        paymentRequest: paymentRequest || '',
        paymentSecret: paymentSecret || '',
      },
      memo,
      status: 'completed',
    };

    dispatch(addTransaction(transactionData));
  }, [
    dispatch,
    satAmount,
    displayAmount,
    currency,
    isPrimaryAmountSats,
    username,
    paymentHash,
    paymentRequest,
    paymentSecret,
    memo,
  ]);

  const onDone = () => {
    dispatch(resetInvoice());
    dispatch(resetAmount());
    navigation.popToTop();
  };

  const onReprintReceipt = () => {
    if (lastTransaction) {
      const receiptData: ReceiptData = {
        id: lastTransaction.id,
        timestamp: lastTransaction.timestamp,
        satAmount: lastTransaction.amount.satAmount,
        displayAmount: lastTransaction.amount.displayAmount,
        currency: lastTransaction.amount.currency,
        isPrimaryAmountSats: lastTransaction.amount.isPrimaryAmountSats,
        username: lastTransaction.merchant.username,
        memo: lastTransaction.memo,
        paymentHash: lastTransaction.invoice.paymentHash,
        status: lastTransaction.status,
      };

      printReceipt(receiptData);
    }
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <IconWrapper>
          <Icon source={Check} />
        </IconWrapper>
        <Title>{route.params?.title || `The invoice has been paid`}</Title>
        <PrimaryAmount>{`${currency.symbol} ${
          displayAmount || 0
        }`}</PrimaryAmount>
      </InnerWrapper>
      <BtnsWrapper>
        <PrimaryButton
          icon="print"
          btnText="Print"
          iconColor="#002118"
          textStyle={{color: '#002118'}}
          btnStyle={{backgroundColor: '#fff'}}
          onPress={printSilently}
        />
        <SecondaryButton
          icon="refresh"
          btnText="Reprint"
          iconColor="#fff"
          textStyle={{color: '#fff'}}
          btnStyle={{borderColor: '#fff', marginTop: 10}}
          onPress={onReprintReceipt}
        />
        <SecondaryButton
          btnText="Done"
          iconColor="#fff"
          textStyle={{color: '#fff'}}
          btnStyle={{borderColor: '#fff', marginTop: 10}}
          onPress={onDone}
        />
      </BtnsWrapper>
    </Wrapper>
  );
};

export default Success;

const Wrapper = styled.View`
  flex: 1;
  background-color: #007856;
  padding-bottom: 20px;
  padding-horizontal: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const IconWrapper = styled.View`
  background-color: #fff;
  border-radius: 100px;
  padding: 15px;
`;

const Icon = styled.Image`
  width: 50px;
  height: 50px;
`;

const Title = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #fff;
  margin-top: 32px;
`;

const PrimaryAmount = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #fff;
`;

const SecondaryAmount = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Regular';
  color: #fff;
  opacity: 0.8;
`;

const BtnsWrapper = styled.View`
  align-items: center;
`;
