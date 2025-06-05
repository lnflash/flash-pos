import React, {useState} from 'react';
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
        <TransactionHeader>
          <StatusContainer>
            <StatusIcon source={Check} />
            <StatusText status={item.status}>
              {item.status.toUpperCase()}
            </StatusText>

            {/* Transaction Type Badge */}
            <TransactionTypeBadge color={typeBadge.color}>
              <TransactionTypeBadgeText>
                {typeBadge.icon} {typeBadge.label}
              </TransactionTypeBadgeText>
            </TransactionTypeBadge>

            {/* Reward Badge */}
            {item.reward && (
              <RewardBadge>
                <RewardBadgeText>
                  +{item.reward.rewardAmount} points
                </RewardBadgeText>
              </RewardBadge>
            )}
          </StatusContainer>
          <DateText>
            {moment(item.timestamp).format('MMM DD, YYYY HH:mm')}
          </DateText>
        </TransactionHeader>

        <AmountContainer>
          {item.amount.isPrimaryAmountSats ? (
            <>
              <PrimaryAmount>{`${item.amount.satAmount} points`}</PrimaryAmount>
              <SecondaryAmount>{`${item.amount.currency.symbol} ${item.amount.displayAmount}`}</SecondaryAmount>
            </>
          ) : (
            <>
              <PrimaryAmount>{`${item.amount.currency.symbol} ${item.amount.displayAmount}`}</PrimaryAmount>
              <SecondaryAmount>{`≈ ${item.amount.satAmount} points`}</SecondaryAmount>
            </>
          )}
        </AmountContainer>

        <TransactionDetails>
          <DetailRow>
            <DetailLabel>Paid to:</DetailLabel>
            <DetailValue>{item.merchant.username}</DetailValue>
          </DetailRow>

          {/* Payment Method for External Payments */}
          {item.transactionType === 'rewards-only' && item.paymentMethod && (
            <DetailRow>
              <DetailLabel>Payment Method:</DetailLabel>
              <DetailValue>
                {getPaymentMethodDisplay(item.paymentMethod)}
              </DetailValue>
            </DetailRow>
          )}

          {item.memo && (
            <DetailRow>
              <DetailLabel>Description:</DetailLabel>
              <DetailValue>{item.memo}</DetailValue>
            </DetailRow>
          )}

          {/* Enhanced Reward Information Section */}
          {item.reward && (
            <>
              <RewardSection>
                <RewardSectionTitle>Reward Information</RewardSectionTitle>
                <DetailRow>
                  <DetailLabel>Reward Earned:</DetailLabel>
                  <RewardValue>{item.reward.rewardAmount} points</RewardValue>
                </DetailRow>
                <DetailRow>
                  <DetailLabel>Reward Rate:</DetailLabel>
                  <DetailValue>
                    {(item.reward.rewardRate * 100).toFixed(1)}%
                  </DetailValue>
                </DetailRow>
                {item.reward.wasMinimumApplied && (
                  <DetailRow>
                    <DetailLabel>Constraint:</DetailLabel>
                    <DetailValue>Minimum reward applied</DetailValue>
                  </DetailRow>
                )}
                {item.reward.wasMaximumApplied && (
                  <DetailRow>
                    <DetailLabel>Constraint:</DetailLabel>
                    <DetailValue>Maximum reward applied</DetailValue>
                  </DetailRow>
                )}
                <DetailRow>
                  <DetailLabel>Reward Type:</DetailLabel>
                  <DetailValue>
                    {item.reward.isStandalone ? 'Standalone' : 'Purchase-based'}
                  </DetailValue>
                </DetailRow>
              </RewardSection>
            </>
          )}

          <DetailRow>
            <DetailLabel>Transaction ID:</DetailLabel>
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

        <FlatList
          data={filteredTransactions}
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

const RewardBadge = styled.View`
  background-color: #007856;
  border-radius: 12px;
  padding-horizontal: 8px;
  padding-vertical: 2px;
  margin-left: 8px;
`;

const RewardBadgeText = styled.Text`
  font-size: 10px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
`;

const RewardSection = styled.View`
  background-color: #f8f9fa;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
`;

const RewardSectionTitle = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Bold';
  color: #007856;
  margin-bottom: 8px;
`;

const RewardValue = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #007856;
  text-align: right;
  margin-left: 16px;
`;

const FilterContainer = styled.View`
  flex-direction: row;
  padding: 10px 20px;
  background-color: #f8f9fa;
  border-bottom-width: 1px;
  border-bottom-color: #e9ecef;
`;

const FilterScrollView = styled.ScrollView`
  flex: 1;
`;

const FilterButton = styled.TouchableOpacity<{active: boolean}>`
  padding: 8px 16px;
  border-radius: 8px;
  margin-horizontal: 4px;
  background-color: ${props => (props.active ? '#007856' : 'transparent')};
`;

const FilterButtonText = styled.Text<{active: boolean}>`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: ${props => (props.active ? '#ffffff' : '#666666')};
  text-align: center;
`;

const TransactionTypeBadge = styled.View<{color: string}>`
  background-color: ${props => props.color};
  border-radius: 12px;
  padding-horizontal: 8px;
  padding-vertical: 2px;
  margin-left: 8px;
`;

const TransactionTypeBadgeText = styled.Text`
  font-size: 10px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
`;
