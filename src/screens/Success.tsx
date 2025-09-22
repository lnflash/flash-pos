import React, {useEffect} from 'react';
import {Platform} from 'react-native';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {PrimaryButton, SecondaryButton} from '../components';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {usePrint} from '../hooks';
import {useFlashcard} from '../hooks';

// assets
import Check from '../assets/icons/check.svg';

// store
import {resetAmount} from '../store/slices/amountSlice';
import {resetInvoice} from '../store/slices/invoiceSlice';
import {addTransaction} from '../store/slices/transactionHistorySlice';

type Props = StackScreenProps<RootStackType, 'Success'>;

const Success: React.FC<Props> = ({navigation, route}) => {
  const {print, printSilently, printReceipt, printReceiptHTML} = usePrint();
  const {setNfcEnabled} = useFlashcard();

  const dispatch = useAppDispatch();
  const {displayAmount, currency} = useAppSelector(state => state.amount);
  const {lastTransaction} = useAppSelector(state => state.transactionHistory);

  // Track whether receipt has been printed
  const [hasBeenPrinted, setHasBeenPrinted] = React.useState(false);

  // Disable NFC on mount and re-enable on unmount
  useEffect(() => {
    setNfcEnabled(false);

    return () => {
      setNfcEnabled(true);
    };
  }, [setNfcEnabled]);

  // Note: Transaction creation is now handled in the Invoice screen to include reward information
  // This prevents duplicate transactions and ensures reward data is properly recorded

  const onDone = () => {
    dispatch(resetInvoice());
    dispatch(resetAmount());
    navigation.reset({
      index: 0,
      routes: [{name: 'Home'}],
    });
  };

  const onPrintReceipt = () => {
    if (!hasBeenPrinted) {
      // First print - use silent printing
      if (Platform.OS === 'ios') {
        print();
      } else {
        printSilently();
      }
      setHasBeenPrinted(true);
    } else if (lastTransaction) {
      // Subsequent prints - use reprint functionality
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
      if (Platform.OS === 'ios') {
        printReceiptHTML(receiptData);
      } else {
        printReceipt(receiptData);
      }
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
          icon={hasBeenPrinted ? 'rotate' : 'print'}
          btnText={hasBeenPrinted ? 'Reprint' : 'Print'}
          iconColor="#002118"
          textStyle={{color: '#002118'}}
          btnStyle={{backgroundColor: '#fff'}}
          onPress={onPrintReceipt}
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

const BtnsWrapper = styled.View`
  align-items: center;
`;
