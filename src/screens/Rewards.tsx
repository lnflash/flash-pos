import React, {useCallback, useMemo} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackScreenProps} from '@react-navigation/stack';
import axios from 'axios';

// hooks
import {useFlashcard, useRealtimePrice} from '../hooks';
import {useFocusEffect} from '@react-navigation/native';
import {useAppSelector} from '../store/hooks';

// assets
import Pos from '../assets/icons/pos.svg';

// env
import {BTC_PAY_SERVER, PULL_PAYMENT_ID} from '@env';

// utils
import {toastShow} from '../utils/toast';
import {
  calculateReward,
  formatRewardForDisplay,
} from '../utils/rewardCalculations';

// selectors
import {selectRewardConfig} from '../store/slices/rewardSlice';

const width = Dimensions.get('screen').width;

type Props = StackScreenProps<RootStackType, 'Rewards'>;

const Rewards: React.FC<Props> = ({navigation, route}) => {
  // Extract navigation parameters (all optional for backward compatibility)
  const {purchaseAmount, purchaseCurrency, purchaseDisplayAmount} =
    route.params || {};

  const {satsToCurrency} = useRealtimePrice();
  const {loading, balanceInSats, lnurl, resetFlashcard} = useFlashcard();
  const rewardConfig = useAppSelector(selectRewardConfig);

  // Calculate reward based on purchase context or standalone
  const rewardCalculation = useMemo(
    () => calculateReward(purchaseAmount, rewardConfig),
    [purchaseAmount, rewardConfig],
  );

  // Format reward information for display
  const rewardDisplay = useMemo(
    () => formatRewardForDisplay(rewardCalculation, satsToCurrency),
    [rewardCalculation, satsToCurrency],
  );

  // Check if rewards are enabled
  const isRewardsEnabled = rewardConfig.isEnabled;

  const onReward = useCallback(async () => {
    if (!isRewardsEnabled) {
      toastShow({
        message: 'Rewards system is currently disabled.',
        type: 'error',
      });
      return;
    }

    const requestBody = {
      destination: lnurl,
      amount: rewardCalculation.rewardAmount, // Dynamic amount based on calculation
      payoutMethodId: 'BTC-LN',
    };

    const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;

    try {
      const response = await axios.post(url, requestBody);
      console.log('Response from redeeming rewards:', response.data);

      resetFlashcard();
      if (response.data) {
        const displayAmount =
          balanceInSats !== undefined &&
          satsToCurrency(balanceInSats + rewardCalculation.rewardAmount)
            .formattedCurrency;

        // Navigate with enhanced parameters including purchase context
        navigation.navigate('RewardsSuccess', {
          rewardSatAmount: rewardCalculation.rewardAmount,
          balance: displayAmount || '',
          purchaseAmount,
          purchaseCurrency,
          purchaseDisplayAmount,
          rewardRate: rewardCalculation.rewardRate,
          calculationType: rewardCalculation.calculationType,
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
  }, [
    isRewardsEnabled,
    lnurl,
    rewardCalculation.rewardAmount,
    resetFlashcard,
    balanceInSats,
    satsToCurrency,
    navigation,
    purchaseAmount,
    purchaseCurrency,
    purchaseDisplayAmount,
    rewardCalculation.rewardRate,
    rewardCalculation.calculationType,
  ]);

  useFocusEffect(
    useCallback(() => {
      if (loading || !lnurl || !isRewardsEnabled) return;
      onReward();
    }, [loading, lnurl, isRewardsEnabled, onReward]),
  );

  // Don't render if rewards are disabled
  if (!isRewardsEnabled) {
    return (
      <Wrapper>
        <Title>Rewards System Disabled</Title>
        <DisabledMessage>
          Rewards are currently disabled. Please contact support or check your
          settings.
        </DisabledMessage>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <Title>Tap any Flashcard to receive rewards!</Title>

      {/* Show purchase context if available */}
      {purchaseDisplayAmount && (
        <PurchaseContext>Purchase: {purchaseDisplayAmount}</PurchaseContext>
      )}

      <Animatable.View
        animation="pulse"
        easing="ease-out"
        iterationCount="infinite">
        <Image source={Pos} />
      </Animatable.View>

      <Subtitle>
        {rewardDisplay.primaryText}
        {'\n'}
        {rewardDisplay.secondaryText}
      </Subtitle>

      {/* Show reward calculation details */}
      {rewardCalculation.calculationType === 'purchase-based' && (
        <RewardDetails>{rewardDisplay.description}</RewardDetails>
      )}
    </Wrapper>
  );
};

export default Rewards;

const Wrapper = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  background-color: #ffffff;
  padding-bottom: 70px;
  padding-horizontal: 20px;
`;

const Title = styled.Text`
  font-size: 30px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #000000;
`;

const PurchaseContext = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #007856;
  margin-top: 10px;
  margin-bottom: 10px;
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

const RewardDetails = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #007856;
  margin-top: 10px;
  font-style: italic;
`;

const DisabledMessage = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #747474;
  margin-top: 20px;
  padding-horizontal: 40px;
`;
