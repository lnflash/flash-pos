import React, {useEffect} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackNavigationProp} from '@react-navigation/stack';
import axios from 'axios';

// hooks
import {useFlashcard, useRealtimePrice} from '../hooks';
import {useAppSelector} from '../store/hooks';
import {useNavigation} from '@react-navigation/native';

// assets
import Pos from '../assets/icons/pos.svg';

// env
import {BTC_PAY_SERVER, PULL_PAYMENT_ID} from '@env';

// utils
import {toastShow} from '../utils/toast';

const width = Dimensions.get('screen').width;

type Props = StackNavigationProp<RootStackType, 'Home'>;

const Rewards = () => {
  const navigation = useNavigation<Props>();

  const {satsToCurrency} = useRealtimePrice();
  const {loading, displayAmount, lnurl} = useFlashcard();

  const {currency} = useAppSelector(state => state.amount);

  useEffect(() => {
    if (!loading && !!lnurl) {
      onReward();
    }
  }, [loading, lnurl]);

  const onReward = async () => {
    const usdAmount = satsToCurrency(21, 'USD', 2).convertedCurrencyAmount;
    const requestBody = {
      destination: lnurl,
      amount: (usdAmount / 100).toFixed(2),
      payoutMethodId: 'BTC-LN',
    };

    const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;

    try {
      const response = await axios.post(url, requestBody);
      console.log('Response from redeeming rewards:', response.data);
      if (response.data) {
        navigation.navigate('RewardsSuccess', {
          rewardSatAmount: 21,
          balance: `${currency.symbol} ${displayAmount}`,
        });
      } else {
        toastShow({
          message: 'Reward is failed. Please try again.',
          type: 'error',
        });
      }
    } catch (error) {
      console.error('Error redeeming rewards', error);
      toastShow({
        message: 'Reward is failed. Please try again.',
        type: 'error',
      });
    }
  };

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
