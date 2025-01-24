import React from 'react';
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

type Props = StackScreenProps<RootStackType, 'Success'>;

const Success: React.FC<Props> = ({navigation}) => {
  const {print} = usePrint();

  const dispatch = useAppDispatch();
  const {satAmount, displayAmount, currency, isPrimaryAmountSats} =
    useAppSelector(state => state.amount);

  const onPrint = async () => {
    await print();
    onDone();
  };

  const onDone = () => {
    dispatch(resetInvoice());
    dispatch(resetAmount());
    navigation.popToTop();
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <IconWrapper>
          <Icon source={Check} />
        </IconWrapper>
        <Title>The invoice has been paid</Title>
        {isPrimaryAmountSats ? (
          <>
            <PrimaryAmount>{`${satAmount} sats`}</PrimaryAmount>
            <SecondaryAmount>{`${currency.symbol} ${
              displayAmount || 0
            }`}</SecondaryAmount>
          </>
        ) : (
          <>
            <PrimaryAmount>{`${currency.symbol} ${
              displayAmount || 0
            }`}</PrimaryAmount>
            <SecondaryAmount>{`≈ ${satAmount} sats`}</SecondaryAmount>
          </>
        )}
      </InnerWrapper>
      <BtnsWrapper>
        <PrimaryButton
          icon="print"
          btnText="Print"
          iconColor="#002118"
          textStyle={{color: '#002118'}}
          btnStyle={{backgroundColor: '#fff'}}
          onPress={onPrint}
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
  padding-bottom: 30px;
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
  padding: 23px;
`;

const Icon = styled.Image`
  width: 50px;
  height: 50px;
`;

const Title = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Regular';
  color: #fff;
  margin-top: 32px;
`;

const PrimaryAmount = styled.Text`
  font-size: 44px;
  font-family: 'Outfit-Regular';
  color: #fff;
`;

const SecondaryAmount = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Regular';
  color: #fff;
  opacity: 0.8;
`;

const BtnsWrapper = styled.View`
  align-items: center;
`;
