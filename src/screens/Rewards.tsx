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

  // Determine reward type for enhanced messaging
  const isPurchaseBased =
    rewardCalculation.calculationType === 'purchase-based';
  const rewardPercentage = isPurchaseBased
    ? (rewardCalculation.rewardRate! * 100).toFixed(1)
    : null;

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
        <DisabledContainer>
          <DisabledTitle>Rewards System Disabled</DisabledTitle>
          <DisabledMessage>
            Rewards are currently disabled. Please contact support or check your
            settings.
          </DisabledMessage>
        </DisabledContainer>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      {/* Enhanced Header Section */}
      <HeaderSection>
        <Title>
          {isPurchaseBased
            ? 'Claim Your Purchase Reward!'
            : 'Tap any Flashcard to receive rewards!'}
        </Title>

        {/* Purchase Context Card */}
        {purchaseDisplayAmount && (
          <Animatable.View animation="fadeInDown" duration={800}>
            <PurchaseCard>
              <PurchaseLabel>Purchase Amount</PurchaseLabel>
              <PurchaseAmount>{purchaseDisplayAmount}</PurchaseAmount>
              {rewardPercentage && (
                <RewardRateBadge>
                  <RewardRateText>{rewardPercentage}% Reward</RewardRateText>
                </RewardRateBadge>
              )}
            </PurchaseCard>
          </Animatable.View>
        )}
      </HeaderSection>

      {/* Animated Icon */}
      <IconSection>
        <Animatable.View
          animation="pulse"
          easing="ease-out"
          iterationCount="infinite"
          duration={2000}>
          <Image source={Pos} />
        </Animatable.View>
      </IconSection>

      {/* Reward Information Section */}
      <RewardSection>
        <Animatable.View animation="fadeInUp" duration={800} delay={200}>
          <RewardAmountCard>
            <RewardAmountLabel>You'll Earn</RewardAmountLabel>
            <RewardAmountText>
              {rewardCalculation.rewardAmount} sats
            </RewardAmountText>
            <RewardCurrencyText>
              (~
              {satsToCurrency(rewardCalculation.rewardAmount).formattedCurrency}
              )
            </RewardCurrencyText>
          </RewardAmountCard>
        </Animatable.View>

        {/* Reward Details */}
        <RewardDetailsContainer>
          <RewardDetailsText>{rewardDisplay.description}</RewardDetailsText>

          {/* Constraint Indicators */}
          {rewardCalculation.appliedMinimum && (
            <ConstraintBadge type="minimum">
              <ConstraintText>Minimum reward applied</ConstraintText>
            </ConstraintBadge>
          )}

          {rewardCalculation.appliedMaximum && (
            <ConstraintBadge type="maximum">
              <ConstraintText>Maximum reward applied</ConstraintText>
            </ConstraintBadge>
          )}
        </RewardDetailsContainer>

        <ActionHint>
          {isPurchaseBased
            ? 'Tap your flashcard to claim your purchase reward'
            : 'Tap your flashcard to receive sats'}
        </ActionHint>
      </RewardSection>
    </Wrapper>
  );
};

export default Rewards;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
  padding: 20px;
`;

const DisabledContainer = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 40px;
`;

const DisabledTitle = styled.Text`
  font-size: 28px;
  font-family: 'Outfit-Bold';
  text-align: center;
  color: #ff6b6b;
  margin-bottom: 16px;
`;

const DisabledMessage = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #747474;
  line-height: 24px;
`;

const HeaderSection = styled.View`
  align-items: center;
  margin-bottom: 20px;
`;

const Title = styled.Text`
  font-size: 28px;
  font-family: 'Outfit-Bold';
  text-align: center;
  color: #000000;
  margin-bottom: 20px;
  line-height: 34px;
`;

const PurchaseCard = styled.View`
  background-color: #f8f9fa;
  border-radius: 16px;
  padding: 20px;
  align-items: center;
  shadow-color: #000;
  shadow-offset: 0px 2px;
  shadow-opacity: 0.1;
  shadow-radius: 8px;
  elevation: 3;
  min-width: 280px;
`;

const PurchaseLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #666666;
  margin-bottom: 4px;
`;

const PurchaseAmount = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  color: #007856;
  margin-bottom: 8px;
`;

const RewardRateBadge = styled.View`
  background-color: #007856;
  border-radius: 20px;
  padding-horizontal: 12px;
  padding-vertical: 4px;
`;

const RewardRateText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
`;

const IconSection = styled.View`
  align-items: center;
  margin-vertical: 30px;
`;

const Image = styled.Image`
  width: ${Math.min(width - 120, 250)}px;
  height: ${Math.min(width - 120, 250)}px;
`;

const RewardSection = styled.View`
  align-items: center;
  flex: 1;
  justify-content: center;
`;

const RewardAmountCard = styled.View`
  background-color: #007856;
  border-radius: 20px;
  padding: 24px 32px;
  align-items: center;
  shadow-color: #007856;
  shadow-offset: 0px 4px;
  shadow-opacity: 0.3;
  shadow-radius: 12px;
  elevation: 8;
  min-width: 200px;
  margin-bottom: 20px;
`;

const RewardAmountLabel = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 4px;
`;

const RewardAmountText = styled.Text`
  font-size: 32px;
  font-family: 'Outfit-Bold';
  color: #ffffff;
  margin-bottom: 4px;
`;

const RewardCurrencyText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: rgba(255, 255, 255, 0.7);
`;

const RewardDetailsContainer = styled.View`
  align-items: center;
  margin-bottom: 20px;
`;

const RewardDetailsText = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #666666;
  margin-bottom: 12px;
  line-height: 22px;
`;

const ConstraintBadge = styled.View<{type: 'minimum' | 'maximum'}>`
  background-color: ${props =>
    props.type === 'minimum' ? '#FFA500' : '#FF6B6B'};
  border-radius: 12px;
  padding-horizontal: 12px;
  padding-vertical: 6px;
  margin-top: 4px;
`;

const ConstraintText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Medium';
  color: #ffffff;
`;

const ActionHint = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #888888;
  line-height: 24px;
  font-style: italic;
`;
