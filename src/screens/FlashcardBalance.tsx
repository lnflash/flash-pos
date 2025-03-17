import React, {useEffect} from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {RecentActivity} from '../components';
import {ActivityIndicator} from '../contexts/ActivityIndicator';

// hooks
import {useFlashcard, useRealtimePrice} from '../hooks';

// assets
import Flashcard from '../assets/images/flashcard.svg';

type Props = StackScreenProps<RootStackType, 'FlashcardBalance'>;

const FlashcardBalance: React.FC<Props> = ({navigation, route}) => {
  const {satsToCurrency, loading} = useRealtimePrice();
  const {balanceInSats, transactions, resetFlashcard} = useFlashcard();

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', resetFlashcard);
    return unsubscribe;
  }, [navigation]);

  if (loading) {
    return <ActivityIndicator />;
  }

  return (
    <Wrapper>
      <Image source={Flashcard} />
      <Balance>{satsToCurrency(balanceInSats || 0).formattedCurrency}</Balance>
      <RecentActivity transactions={transactions} />
    </Wrapper>
  );
};

export default FlashcardBalance;

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-top: 200px;
`;

const Image = styled.Image`
  position: absolute;
  align-self: center;
`;

const Balance = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #212121;
  text-align: center;
  margin-top: 30px;
`;
