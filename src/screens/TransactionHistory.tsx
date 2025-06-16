import React, {useState} from 'react';
import {RefreshControl, Dimensions} from 'react-native';
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

const {width: screenWidth} = Dimensions.get('window');

// Responsive scaling functions
const scale = (size: number) => (screenWidth / 375) * size;
const isLargeDevice = screenWidth > 414;

type Props = StackScreenProps<RootStackType, 'TransactionHistory'>;
type NavigationProp = StackNavigationProp<RootStackType>;

type FilterType =
  | 'all'
  | 'with-rewards'
  | 'lightning'
  | 'external'
  | 'standalone';

const TransactionHistory: React.FC<Props> = ({navigation: _navigation}) => {
  const navigations = useNavigation<NavigationProp>();
  const {printReceipt} = usePrint();
  const dispatch = useAppDispatch();
  const {transactions} = useAppSelector(state => state.transactionHistory);

  // Enhanced filter state for transaction types
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

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
      transactionType: transaction.transactionType,
      paymentMethod: transaction.paymentMethod,
      rewardAmount: transaction.reward?.rewardAmount,
      rewardRate: transaction.reward?.rewardRate,
    };

    printReceipt(receiptData);
  };

  // Enhanced transaction filtering
  const filteredTransactions = React.useMemo(() => {
    switch (activeFilter) {
      case 'with-rewards':
        return transactions.filter(transaction => transaction.reward);
      case 'lightning':
        return transactions.filter(
          transaction => transaction.transactionType === 'lightning',
        );
      case 'external':
        return transactions.filter(
          transaction => transaction.transactionType === 'rewards-only',
        );
      case 'standalone':
        return transactions.filter(
          transaction => transaction.transactionType === 'standalone',
        );
      default:
        return transactions;
    }
  }, [transactions, activeFilter]);

  // Enhanced statistics calculation
  const statistics = React.useMemo(() => {
    const lightningCount = transactions.filter(
      t => t.transactionType === 'lightning',
    ).length;
    const externalCount = transactions.filter(
      t => t.transactionType === 'rewards-only',
    ).length;
    const standaloneCount = transactions.filter(
      t => t.transactionType === 'standalone',
    ).length;
    const withRewardsCount = transactions.filter(t => t.reward).length;
    const totalRewardsGiven = transactions.reduce(
      (sum, transaction) => sum + (transaction.reward?.rewardAmount || 0),
      0,
    );

    return {
      total: transactions.length,
      lightning: lightningCount,
      external: externalCount,
      standalone: standaloneCount,
      withRewards: withRewardsCount,
      totalRewards: totalRewardsGiven,
    };
  }, [transactions]);

  // Get transaction type badge info
  const getTransactionTypeBadge = (transaction: TransactionData) => {
    switch (transaction.transactionType) {
      case 'lightning':
        return {icon: '⚡', label: 'Lightning', color: '#007856'};
      case 'rewards-only':
        return {icon: '💳', label: 'External Payment', color: '#FF9500'};
      case 'standalone':
        return {icon: '🏷️', label: 'Reward Only', color: '#6C757D'};
      default:
        return {icon: '📄', label: 'Transaction', color: '#6C757D'};
    }
  };

  // Get payment method display
  const getPaymentMethodDisplay = (paymentMethod?: PaymentMethod) => {
    switch (paymentMethod) {
      case 'cash':
        return 'Cash';
      case 'card':
        return 'Card';
      case 'check':
        return 'Check';
      case 'lightning':
        return 'Lightning';
      default:
        return 'External';
    }
  };

  const renderTransactionItem = ({item}: {item: TransactionData}) => {
    const typeBadge = getTransactionTypeBadge(item);

    return (
      <TransactionCard>
        {/* Compact header with amount and status/badges in one row */}
        <CompactHeader>
          <AmountAndMerchant>
            <PrimaryAmount>
              {item.amount.isPrimaryAmountSats
                ? `${item.amount.satAmount} points`
                : `${item.amount.currency.symbol} ${item.amount.displayAmount}`}
            </PrimaryAmount>
            <MerchantText>to {item.merchant.username}</MerchantText>
          </AmountAndMerchant>

          <HeaderBadges>
            <StatusIcon source={Check} />
            <TransactionTypeBadge color={typeBadge.color}>
              <TransactionTypeBadgeText>
                {typeBadge.icon} {typeBadge.label}
              </TransactionTypeBadgeText>
            </TransactionTypeBadge>
            {item.reward && (
              <RewardBadge>
                <RewardBadgeText>
                  +{item.reward.rewardAmount} sats
                  {item.reward.sentToCard ? ' 💳' : ''}
                </RewardBadgeText>
              </RewardBadge>
            )}
          </HeaderBadges>
        </CompactHeader>

        {/* Compact details section */}
        <CompactDetails>
          <DetailItem>
            <DetailIcon>📅</DetailIcon>
            <DetailText>
              {moment(item.timestamp).format('MMM DD, HH:mm')}
            </DetailText>
          </DetailItem>

          {item.transactionType === 'rewards-only' && item.paymentMethod && (
            <DetailItem>
              <DetailIcon>💳</DetailIcon>
              <DetailText>
                {getPaymentMethodDisplay(item.paymentMethod)}
              </DetailText>
            </DetailItem>
          )}

          {item.memo && (
            <DetailItem>
              <DetailIcon>📝</DetailIcon>
              <DetailText numberOfLines={1}>{item.memo}</DetailText>
            </DetailItem>
          )}

          {item.reward && (
            <DetailItem>
              <DetailIcon>🎁</DetailIcon>
              <DetailText>
                {(item.reward.rewardRate * 100).toFixed(1)}% rate
                {item.reward.wasMinimumApplied && ' (min applied)'}
                {item.reward.wasMaximumApplied && ' (max applied)'}
                {item.reward.sentToCard && ' • Sent to NFC card'}
              </DetailText>
            </DetailItem>
          )}

          {/* Show NFC card reward transfer status */}
          {item.reward?.sentToCard && (
            <DetailItem>
              <DetailIcon>💳</DetailIcon>
              <DetailText>
                Rewards automatically sent to customer's NFC card
              </DetailText>
            </DetailItem>
          )}
        </CompactDetails>

        {/* Minimal reprint button */}
        <ReprintButton onPress={() => onReprintTransaction(item)}>
          <ButtonIcon source={Refresh} />
          <ButtonText>Reprint</ButtonText>
        </ReprintButton>
      </TransactionCard>
    );
  };

  const renderEmptyState = () => (
    <EmptyContainer>
      <EmptyText>
        {activeFilter === 'with-rewards'
          ? 'No transactions with rewards found'
          : activeFilter === 'lightning'
          ? 'No Lightning transactions found'
          : activeFilter === 'external'
          ? 'No external payment transactions found'
          : activeFilter === 'standalone'
          ? 'No standalone reward transactions found'
          : 'No transactions found'}
      </EmptyText>
      <EmptySubtext>
        {activeFilter === 'all'
          ? 'Completed transactions will appear here'
          : 'Matching transactions will appear here'}
      </EmptySubtext>
    </EmptyContainer>
  );

  return (
    <Wrapper>
      <Container>
        <Header>
          <HeaderTitle>Transaction History</HeaderTitle>
          <HeaderSubtitle>
            {statistics.total} transactions
            {statistics.totalRewards > 0 && (
              <>
                {' • '}
                {statistics.totalRewards} points rewarded
              </>
            )}
          </HeaderSubtitle>
        </Header>

        {/* Enhanced Filter Controls */}
        {statistics.total > 0 && (
          <FilterContainer>
            <FilterScrollView horizontal showsHorizontalScrollIndicator={false}>
              <FilterButton
                active={activeFilter === 'all'}
                onPress={() => setActiveFilter('all')}>
                <FilterButtonText active={activeFilter === 'all'}>
                  All ({statistics.total})
                </FilterButtonText>
              </FilterButton>

              {statistics.withRewards > 0 && (
                <FilterButton
                  active={activeFilter === 'with-rewards'}
                  onPress={() => setActiveFilter('with-rewards')}>
                  <FilterButtonText active={activeFilter === 'with-rewards'}>
                    With Rewards ({statistics.withRewards})
                  </FilterButtonText>
                </FilterButton>
              )}

              {statistics.lightning > 0 && (
                <FilterButton
                  active={activeFilter === 'lightning'}
                  onPress={() => setActiveFilter('lightning')}>
                  <FilterButtonText active={activeFilter === 'lightning'}>
                    ⚡ Lightning ({statistics.lightning})
                  </FilterButtonText>
                </FilterButton>
              )}

              {statistics.external > 0 && (
                <FilterButton
                  active={activeFilter === 'external'}
                  onPress={() => setActiveFilter('external')}>
                  <FilterButtonText active={activeFilter === 'external'}>
                    💳 External ({statistics.external})
                  </FilterButtonText>
                </FilterButton>
              )}

              {statistics.standalone > 0 && (
                <FilterButton
                  active={activeFilter === 'standalone'}
                  onPress={() => setActiveFilter('standalone')}>
                  <FilterButtonText active={activeFilter === 'standalone'}>
                    🏷️ Rewards ({statistics.standalone})
                  </FilterButtonText>
                </FilterButton>
              )}
            </FilterScrollView>
          </FilterContainer>
        )}

        <StyledFlatList
          data={filteredTransactions}
          renderItem={renderTransactionItem}
          keyExtractor={(item: TransactionData) => item.id}
          showsVerticalScrollIndicator={false}
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
          <ClearHistoryButton
            btnText="Clear History"
            onPress={onClearHistory}
          />
        )}
        <PrimaryButton btnText="Back" onPress={() => navigations.goBack()} />
      </ButtonWrapper>
    </Wrapper>
  );
};

export default TransactionHistory;

const StyledFlatList = styled.FlatList.attrs({
  contentContainerStyle: {
    paddingBottom: scale(100),
    flexGrow: 1,
  },
})`` as React.ComponentType<any>;

const ClearHistoryButton = styled(SecondaryButton).attrs({
  textStyle: {color: '#FF6B6B'},
  btnStyle: {borderColor: '#FF6B6B'},
})``;

const ButtonWrapper = styled.View`
  padding: ${scale(20)}px;
  padding-bottom: ${scale(40)}px;
`;

const Wrapper = styled.View`
  flex: 1;
  background-color: #f5f5f5;
`;

const Container = styled.View`
  flex: 1;
  background-color: #ffffff;
  max-width: ${isLargeDevice ? '600px' : '500px'};
  align-self: center;
  width: 100%;
`;

const Header = styled.View`
  padding: ${scale(20)}px ${scale(16)}px;
  background-color: #007856;
`;

const HeaderTitle = styled.Text`
  font-size: ${scale(20)}px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
  text-align: center;
`;

const HeaderSubtitle = styled.Text`
  font-size: ${scale(14)}px;
  font-family: 'Outfit-Regular';
  color: #ffffff;
  opacity: 0.8;
  margin-top: ${scale(4)}px;
  text-align: center;
`;

const TransactionCard = styled.View`
  background-color: #ffffff;
  margin: ${scale(8)}px ${scale(16)}px;
  border-radius: ${scale(8)}px;
  padding: ${scale(12)}px;
  shadow-color: #000;
  shadow-offset: 0px 1px;
  shadow-opacity: 0.05;
  shadow-radius: 2px;
  elevation: 2;
`;

const CompactHeader = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: ${scale(8)}px;
`;

const AmountAndMerchant = styled.View`
  flex: 1;
  margin-right: ${scale(12)}px;
  min-width: 0;
`;

const MerchantText = styled.Text`
  font-size: ${scale(12)}px;
  font-family: 'Outfit-Regular';
  color: #666666;
  margin-top: ${scale(2)}px;
`;

const HeaderBadges = styled.View`
  flex-direction: row;
  align-items: flex-start;
  flex-wrap: wrap;
  max-width: 40%;
  justify-content: flex-end;
`;

const CompactDetails = styled.View`
  margin-bottom: ${scale(8)}px;
`;

const DetailItem = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: ${scale(4)}px;
`;

const DetailIcon = styled.Text`
  font-size: ${scale(12)}px;
  margin-right: ${scale(6)}px;
  width: ${scale(16)}px;
`;

const DetailText = styled.Text`
  font-size: ${scale(12)}px;
  font-family: 'Outfit-Regular';
  color: #555555;
  flex: 1;
`;

const PrimaryAmount = styled.Text`
  font-size: ${scale(16)}px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

const StatusIcon = styled.Image`
  width: ${scale(14)}px;
  height: ${scale(14)}px;
  margin-right: ${scale(4)}px;
  tint-color: #007856;
`;

const ReprintButton = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
  background-color: #f8f9fa;
  border-radius: ${scale(6)}px;
  padding: ${scale(8)}px;
`;

const ButtonIcon = styled.Image`
  width: ${scale(14)}px;
  height: ${scale(14)}px;
  margin-right: ${scale(6)}px;
  tint-color: #007856;
`;

const ButtonText = styled.Text`
  font-size: ${scale(12)}px;
  font-family: 'Outfit-Medium';
  color: #007856;
`;

const EmptyContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding: ${scale(40)}px;
`;

const EmptyText = styled.Text`
  font-size: ${scale(18)}px;
  font-family: 'Outfit-Medium';
  color: #666666;
  text-align: center;
`;

const EmptySubtext = styled.Text`
  font-size: ${scale(14)}px;
  font-family: 'Outfit-Regular';
  color: #999999;
  text-align: center;
  margin-top: ${scale(8)}px;
`;

const RewardBadge = styled.View`
  background-color: #007856;
  border-radius: ${scale(12)}px;
  padding-horizontal: ${scale(6)}px;
  padding-vertical: ${scale(2)}px;
  margin-left: ${scale(4)}px;
  margin-top: ${scale(2)}px;
  max-width: ${scale(120)}px;
`;

const RewardBadgeText = styled.Text`
  font-size: ${scale(9)}px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
  text-align: center;
`;

const FilterContainer = styled.View`
  flex-direction: row;
  padding: ${scale(10)}px ${scale(20)}px;
  background-color: #f8f9fa;
  border-bottom-width: 1px;
  border-bottom-color: #e9ecef;
`;

const FilterScrollView = styled.ScrollView`
  flex: 1;
`;

const FilterButton = styled.TouchableOpacity<{active: boolean}>`
  padding: ${scale(8)}px ${scale(16)}px;
  border-radius: ${scale(8)}px;
  margin-horizontal: ${scale(4)}px;
  background-color: ${props => (props.active ? '#007856' : 'transparent')};
`;

const FilterButtonText = styled.Text<{active: boolean}>`
  font-size: ${scale(14)}px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.active ? '#ffffff' : '#666666')};
  text-align: center;
`;

const TransactionTypeBadge = styled.View<{color: string}>`
  background-color: ${props => props.color};
  border-radius: ${scale(12)}px;
  padding-horizontal: ${scale(6)}px;
  padding-vertical: ${scale(2)}px;
  margin-left: ${scale(4)}px;
  margin-top: ${scale(2)}px;
`;

const TransactionTypeBadgeText = styled.Text`
  font-size: ${scale(9)}px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
`;