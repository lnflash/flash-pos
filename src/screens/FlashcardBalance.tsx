import React, {useEffect, useMemo} from 'react';
import styled from 'styled-components/native';
import {ActivityIndicator} from 'react-native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {RecentActivity} from '../components';

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
    return (
      <LoadingWrapper>
        <ActivityIndicator color={'#002118'} size={'large'} />
      </LoadingWrapper>
    );
  }

  const formattedCurrency = useMemo(
    () => satsToCurrency(balanceInSats || 0).formattedCurrency,
    [satsToCurrency, balanceInSats],
  );

  return (
    <Wrapper>
      <Image source={Flashcard} />
      <Balance>{formattedCurrency}</Balance>
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
`;

const Balance = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #212121;
  text-align: center;
  margin-top: 30px;
`;

const LoadingWrapper = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;
