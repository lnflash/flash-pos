import React, {useEffect} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackNavigationProp} from '@react-navigation/stack';

// hooks
import {useFlashcard} from '../hooks';
import {useAppSelector} from '../store/hooks';
import {useNavigation} from '@react-navigation/native';

// assets
import Pos from '../assets/icons/pos.svg';

const width = Dimensions.get('screen').width;

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Rewards = () => {
  const navigation = useNavigation<Props>();

  const {lnurl, satAmount, displayAmount} = useFlashcard();

  const {currency} = useAppSelector(state => state.amount);

  useEffect(() => {
    setTimeout(() => {
      navigation.navigate('RewardsSuccess', {
        satAmount: 21,
        displayAmount: 4,
        balance: `${currency.symbol} ${123}`,
      });
    }, 1000);
  }, []);

  return (
    <Wrapper>
      <Title>Tap any Flashcard to receive rewards!</Title>
      <Animatable.View
        animation="pulse"
        easing="ease-out"
        iterationCount="infinite">
        <Image source={Pos} />
      </Animatable.View>
      <Subtitle>{`21 sats (~J$ 3.19)\nwill be applied to reward balance`}</Subtitle>
    </Wrapper>
  );
};

export default Rewards;

const Wrapper = styled.View`
  flex: 1;
  align-items: center;
  background-color: #ffffff;
  padding-top: 100px;
  padding-horizontal: 40px;
`;

const Title = styled.Text`
  font-size: 30px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #000000;
`;

const Image = styled.Image`
  width: ${width - 80}px;
  height: ${width - 80}px;
`;

const Subtitle = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #747474;
`;
