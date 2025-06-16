import React, {useState, useEffect, useCallback} from 'react';
import {RefreshControl, Alert, Dimensions} from 'react-native';
import styled from 'styled-components/native';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {Icon} from '@rneui/themed';
import moment from 'moment';

// components
import {PrimaryButton, SecondaryButton} from '../components';

// hooks
import {useFlashcard} from '../hooks/useFlashcard';

const {width: screenWidth} = Dimensions.get('window');

// Responsive scaling functions
const scale = (size: number) => (screenWidth / 375) * size;
const isLargeDevice = screenWidth > 414;

type NavigationProp = StackNavigationProp<RootStackType>;

const RegisteredRewardCards: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const {getAllStoredCards, deleteStoredCard, clearAllStoredCards} =
    useFlashcard();
  const [storedCards, setStoredCards] = useState<StoredCardInfo[]>([]);
  const [_loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStoredCards = useCallback(async () => {
    try {
      const cards = await getAllStoredCards();
      setStoredCards(cards);
    } catch (error) {
      console.error('Failed to load stored cards:', error);
      setStoredCards([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [getAllStoredCards]);

  useEffect(() => {
    loadStoredCards();
  }, [loadStoredCards]);

  const onRefresh = () => {
    setRefreshing(true);
    loadStoredCards();
  };

  const deleteCard = async (tagId: string) => {
    Alert.alert(
      'Delete Card',
      'Are you sure you want to remove this card from your registered reward cards?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const success = await deleteStoredCard(tagId);
              if (success) {
                loadStoredCards(); // Refresh the list
              } else {
                Alert.alert(
                  'Error',
                  'Failed to delete card. Please try again.',
                );
              }
            } catch (error) {
              console.error('Failed to delete card:', error);
              Alert.alert('Error', 'Failed to delete card. Please try again.');
            }
          },
        },
      ],
    );
  };

  const clearAllCards = async () => {
    Alert.alert(
      'Clear All Cards',
      'Are you sure you want to remove all registered reward cards? This action cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              const success = await clearAllStoredCards();
              if (success) {
                setStoredCards([]);
              } else {
                Alert.alert(
                  'Error',
                  'Failed to clear cards. Please try again.',
                );
              }
            } catch (error) {
              console.error('Failed to clear all cards:', error);
              Alert.alert('Error', 'Failed to clear cards. Please try again.');
            }
          },
        },
      ],
    );
  };

  const formatTagId = (tagId: string) => {
    // Format Tag ID with spaces for better readability
    return tagId.replace(/(.{2})/g, '$1 ').trim();
  };

  const formatLnurl = (lnurl: string) => {
    // Show first 20 and last 10 characters for readability
    if (lnurl.length > 35) {
      return `${lnurl.substring(0, 20)}...${lnurl.substring(
        lnurl.length - 10,
      )}`;
    }
    return lnurl;
  };

  const renderCardItem = ({item}: {item: StoredCardInfo}) => (
    <CardContainer>
      <CardHeader>
        <CardTitle>NFC Reward Card</CardTitle>
        <DeleteButton onPress={() => deleteCard(item.tagId)}>
          <Icon
            name={'trash-outline'}
            type="ionicon"
            color="#ff4444"
            size={20}
          />
        </DeleteButton>
      </CardHeader>

      <CardDetail>
        <DetailLabel>Tag ID:</DetailLabel>
        <DetailValue>{formatTagId(item.tagId)}</DetailValue>
      </CardDetail>

      <CardDetail>
        <DetailLabel>LNURL:</DetailLabel>
        <DetailValue numberOfLines={1}>{formatLnurl(item.lnurl)}</DetailValue>
      </CardDetail>

      {item.balanceInSats !== undefined && (
        <CardDetail>
          <DetailLabel>Last Balance:</DetailLabel>
          <DetailValue>{item.balanceInSats} sats</DetailValue>
        </CardDetail>
      )}

      <CardDetail>
        <DetailLabel>Last Seen:</DetailLabel>
        <DetailValue>
          {moment(item.lastSeen).format('MMM DD, YYYY HH:mm')}
        </DetailValue>
      </CardDetail>

      <StatusBadge>
        <StatusText>✅ Registered for Rewards</StatusText>
      </StatusBadge>
    </CardContainer>
  );

  const renderEmptyState = () => (
    <EmptyContainer>
      <EmptyIcon>💳</EmptyIcon>
      <EmptyTitle>No Registered Cards</EmptyTitle>
      <EmptyText>
        To register a card for automatic rewards, scan your NFC card on the
        Balance or Keypad screen first.
      </EmptyText>
      <EmptySubtext>
        Once registered, rewards will be automatically sent to your card when
        you make payments.
      </EmptySubtext>
    </EmptyContainer>
  );

  return (
    <Wrapper>
      <Container>
        <Header>
          <HeaderTitle>Registered Reward Cards</HeaderTitle>
          <HeaderSubtitle>
            {storedCards.length} card{storedCards.length !== 1 ? 's' : ''}{' '}
            registered
          </HeaderSubtitle>
        </Header>

        <StyledFlatList
          data={storedCards}
          renderItem={renderCardItem}
          keyExtractor={(item: StoredCardInfo) => item.tagId}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={renderEmptyState}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      </Container>

      <ButtonWrapper>
        {storedCards.length > 0 && (
          <ClearAllButton btnText="Clear All Cards" onPress={clearAllCards} />
        )}
        <PrimaryButton btnText="Back" onPress={() => navigation.goBack()} />
      </ButtonWrapper>
    </Wrapper>
  );
};

export default RegisteredRewardCards;

// Styled Components
const StyledFlatList = styled.FlatList.attrs({
  contentContainerStyle: {
    paddingBottom: scale(100),
    flexGrow: 1,
  },
})`` as React.ComponentType<any>;

const ClearAllButton = styled(SecondaryButton).attrs({
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

const CardContainer = styled.View`
  background-color: #ffffff;
  margin: ${scale(8)}px ${scale(16)}px;
  border-radius: ${scale(12)}px;
  padding: ${scale(16)}px;
  shadow-color: #000;
  shadow-offset: 0px 2px;
  shadow-opacity: 0.1;
  shadow-radius: 4px;
  elevation: 3;
`;

const CardHeader = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: ${scale(12)}px;
`;

const CardTitle = styled.Text`
  font-size: ${scale(16)}px;
  font-family: 'Outfit-Bold';
  color: #000000;
`;

const DeleteButton = styled.TouchableOpacity`
  padding: ${scale(8)}px;
  border-radius: ${scale(6)}px;
  background-color: #ffebee;
`;

const CardDetail = styled.View`
  flex-direction: row;
  margin-bottom: ${scale(8)}px;
`;

const DetailLabel = styled.Text`
  font-size: ${scale(12)}px;
  font-family: 'Outfit-Medium';
  color: #666666;
  width: ${scale(80)}px;
  margin-right: ${scale(8)}px;
`;

const DetailValue = styled.Text`
  font-size: ${scale(12)}px;
  font-family: 'Outfit-Regular';
  color: #000000;
  flex: 1;
`;

const StatusBadge = styled.View`
  background-color: #e8f5e8;
  border-radius: ${scale(6)}px;
  padding: ${scale(6)}px ${scale(10)}px;
  margin-top: ${scale(8)}px;
  align-self: flex-start;
`;

const StatusText = styled.Text`
  font-size: ${scale(11)}px;
  font-family: 'Outfit-Medium';
  color: #2e7d32;
`;

const EmptyContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding: ${scale(40)}px;
`;

const EmptyIcon = styled.Text`
  font-size: ${scale(48)}px;
  margin-bottom: ${scale(16)}px;
`;

const EmptyTitle = styled.Text`
  font-size: ${scale(20)}px;
  font-family: 'Outfit-Bold';
  color: #000000;
  text-align: center;
  margin-bottom: ${scale(8)}px;
`;

const EmptyText = styled.Text`
  font-size: ${scale(16)}px;
  font-family: 'Outfit-Regular';
  color: #666666;
  text-align: center;
  line-height: ${scale(22)}px;
  margin-bottom: ${scale(12)}px;
`;

const EmptySubtext = styled.Text`
  font-size: ${scale(14)}px;
  font-family: 'Outfit-Regular';
  color: #999999;
  text-align: center;
  line-height: ${scale(18)}px;
`;
