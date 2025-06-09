import React from 'react';
import {FlatList, RefreshControl} from 'react-native';
import styled from 'styled-components/native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {StackScreenProps} from '@react-navigation/stack';
import moment from 'moment';

// components
import {PrimaryButton, SecondaryButton} from '../components';

// hooks
import {useAppDispatch, useAppSelector} from '../store/hooks';
import {usePrint} from '../hooks';

// assets
import Check from '../assets/icons/check.svg';
import Refresh from '../assets/icons/refresh.svg';

// store
import {clearTransactionHistory} from '../store/slices/transactionHistorySlice';

type Props = StackScreenProps<RootStackType, 'TransactionHistory'>;
type NavigationProp = StackNavigationProp<RootStackType>;

const TransactionHistory: React.FC<Props> = ({navigation}) => {
  const navigations = useNavigation<NavigationProp>();
  const {printReceipt} = usePrint();
  const dispatch = useAppDispatch();
  const {transactions} = useAppSelector(state => state.transactionHistory);

  const onClearHistory = () => {
    dispatch(clearTransactionHistory());
  };

  const onReprintTransaction = (transaction: TransactionData) => {
    const receiptData: ReceiptData = {
      id: transaction.id,
      timestamp: transaction.timestamp,
      satAmount: transaction.amount.satAmount,
      displayAmount: transaction.amount.displayAmount,
      currency: transaction.amount.currency,
      isPrimaryAmountSats: transaction.amount.isPrimaryAmountSats,
      username: transaction.merchant.username,
      memo: transaction.memo,
      paymentHash: transaction.invoice.paymentHash,
      status: transaction.status,
    };

    printReceipt(receiptData);
  };

  const renderTransactionItem = ({item}: {item: TransactionData}) => (
    <TransactionCard>
      <TransactionHeader>
        <StatusContainer>
          <StatusIcon source={Check} />
          <StatusText status={item.status}>
            {item.status.toUpperCase()}
          </StatusText>
        </StatusContainer>
        <DateText>
          {moment(item.timestamp).format('MMM DD, YYYY HH:mm')}
        </DateText>
      </TransactionHeader>

      <AmountContainer>
        {item.amount.isPrimaryAmountSats ? (
          <>
            <PrimaryAmount>{`${item.amount.satAmount} sats`}</PrimaryAmount>
            <SecondaryAmount>{`${item.amount.currency.symbol} ${item.amount.displayAmount}`}</SecondaryAmount>
          </>
        ) : (
          <>
            <PrimaryAmount>{`${item.amount.currency.symbol} ${item.amount.displayAmount}`}</PrimaryAmount>
            <SecondaryAmount>{`≈ ${item.amount.satAmount} sats`}</SecondaryAmount>
          </>
        )}
      </AmountContainer>

      <TransactionDetails>
        <DetailRow>
          <DetailLabel>Paid to:</DetailLabel>
          <DetailValue>{item.merchant.username}</DetailValue>
        </DetailRow>
        {item.memo && (
          <DetailRow>
            <DetailLabel>Description:</DetailLabel>
            <DetailValue>{item.memo}</DetailValue>
          </DetailRow>
        )}
        <DetailRow>
          <DetailLabel>Payment ID:</DetailLabel>
          <DetailValue numberOfLines={1} ellipsizeMode="middle">
            {item.invoice.paymentHash || item.id}
          </DetailValue>
        </DetailRow>
      </TransactionDetails>

      <ButtonContainer>
        <ReprintButton onPress={() => onReprintTransaction(item)}>
          <ButtonIcon source={Refresh} />
          <ButtonText>Reprint Receipt</ButtonText>
        </ReprintButton>
      </ButtonContainer>
    </TransactionCard>
  );

  const renderEmptyState = () => (
    <EmptyContainer>
      <EmptyText>No transactions found</EmptyText>
      <EmptySubtext>Completed transactions will appear here</EmptySubtext>
    </EmptyContainer>
  );

  return (
    <Wrapper>
      <Container>
        <Header>
          <HeaderTitle>Transaction History</HeaderTitle>
          <HeaderSubtitle>{transactions.length} transactions</HeaderSubtitle>
        </Header>

        <FlatList
          data={transactions}
          renderItem={renderTransactionItem}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: 100,
            flexGrow: 1,
          }}
          ListEmptyComponent={renderEmptyState}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => {}} // Could add refresh functionality here
            />
          }
        />
      </Container>
      <ButtonWrapper>
        {transactions.length > 0 && (
          <SecondaryButton
            btnText="Clear History"
            textStyle={{color: '#FF6B6B'}}
            btnStyle={{borderColor: '#FF6B6B'}}
            onPress={onClearHistory}
          />
        )}
        <PrimaryButton btnText="Back" onPress={() => navigations.goBack()} />
      </ButtonWrapper>
    </Wrapper>
  );
};

export default TransactionHistory;

const ButtonWrapper = styled.View`
  padding: 20px;
  padding-bottom: 40px;
`;

const Wrapper = styled.View`
  flex: 1;
  background-color: #f5f5f5;
`;

const Container = styled.View`
  flex: 1;
  background-color: #ffffff;
`;

const Header = styled.View`
  padding: 20px;
  background-color: #007856;
`;

const HeaderTitle = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const HeaderSubtitle = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #ffffff;
  opacity: 0.8;
  margin-top: 4px;
`;

const TransactionCard = styled.View`
  background-color: #ffffff;
  margin: 10px 20px;
  border-radius: 12px;
  padding: 16px;
  shadow-color: #000;
  shadow-offset: 0px 2px;
  shadow-opacity: 0.1;
  shadow-radius: 4px;
  elevation: 3;
`;

const TransactionHeader = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
`;

const StatusContainer = styled.View`
  flex-direction: row;
  align-items: center;
`;

const StatusIcon = styled.Image`
  width: 16px;
  height: 16px;
  margin-right: 6px;
  tint-color: #007856;
`;

const StatusText = styled.Text<{status: string}>`
  font-size: 12px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.status === 'completed' ? '#007856' : '#FF6B6B')};
`;

const DateText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #666666;
`;

const AmountContainer = styled.View`
  align-items: center;
  margin-bottom: 16px;
`;

const PrimaryAmount = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

const SecondaryAmount = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #666666;
  margin-top: 2px;
`;

const TransactionDetails = styled.View`
  margin-bottom: 16px;
`;

const DetailRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-bottom: 8px;
`;

const DetailLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #666666;
`;

const DetailValue = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #000000;
  flex: 1;
  text-align: right;
  margin-left: 16px;
`;

const ButtonContainer = styled.View`
  border-top-width: 1px;
  border-top-color: #f0f0f0;
  padding-top: 12px;
`;

const ReprintButton = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  background-color: #f8f9fa;
  border-radius: 8px;
  padding: 12px;
`;

const ButtonIcon = styled.Image`
  width: 16px;
  height: 16px;
  margin-right: 8px;
  tint-color: #007856;
`;

const ButtonText = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Medium';
  color: #007856;
`;

const EmptyContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding: 40px;
`;

const EmptyText = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Medium';
  color: #666666;
  text-align: center;
`;

const EmptySubtext = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #999999;
  text-align: center;
  margin-top: 8px;
`;

const FooterContainer = styled.View`
  position: absolute;
  bottom: 20px;
  left: 20px;
  right: 20px;
  background-color: #ffffff;
  padding: 16px;
  border-radius: 12px;
  shadow-color: #000;
  shadow-offset: 0px -2px;
  shadow-opacity: 0.1;
  shadow-radius: 4px;
  elevation: 5;
`;
