import React, {useCallback, useMemo, useState} from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackScreenProps} from '@react-navigation/stack';
import axios from 'axios';

// hooks
import {useFlashcard, useRealtimePrice} from '../hooks';
import {useFocusEffect} from '@react-navigation/native';
import {useAppDispatch, useAppSelector} from '../store/hooks';

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
import {
  createRewardsOnlyTransaction,
  createRewardData,
} from '../utils/transactionHelpers';

// selectors
import {selectRewardConfig} from '../store/slices/rewardSlice';
import {addTransaction} from '../store/slices/transactionHistorySlice';

const width = Dimensions.get('screen').width;

type Props = StackScreenProps<RootStackType, 'Rewards'>;

const Rewards: React.FC<Props> = ({navigation, route}) => {
  // Extract navigation parameters (all optional for backward compatibility)
  const {
    purchaseAmount,
    purchaseCurrency,
    purchaseDisplayAmount,
    isExternalPayment,
    paymentMethod,
  } = route.params || {};

  // Debug state for physical device testing
  const [debugInfo, setDebugInfo] = useState<{
    lastStep: string;
    lastError: string;
    stepCount: number;
  }>({
    lastStep: 'Initialized',
    lastError: '',
    stepCount: 0,
  });

  const dispatch = useAppDispatch();
  const {satsToCurrency} = useRealtimePrice();
  const {loading, balanceInSats, lnurl, resetFlashcard} = useFlashcard();
  const rewardConfig = useAppSelector(selectRewardConfig);
  const {username} = useAppSelector(state => state.user);
  const {currency} = useAppSelector(state => state.amount);

  // Enhanced debugging utility
  const debugLog = useCallback(
    (step: string, data: any = {}) => {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] REWARDS DEBUG - ${step}:`;
      console.log(logMessage, JSON.stringify(data, null, 2));

      // Update debug state for on-screen display
      setDebugInfo(prev => ({
        lastStep: step,
        lastError: step.includes('ERROR') ? step : prev.lastError,
        stepCount: prev.stepCount + 1,
      }));

      // Also show critical steps to user for debugging
      if (step.includes('ERROR') || step.includes('CRASH')) {
        toastShow({
          message: `Debug: ${step}`,
          type: 'error',
        });
      }
    },
    [setDebugInfo],
  );

  // Calculate reward based on purchase context or standalone
  const rewardCalculation = useMemo(
    () => calculateReward(purchaseAmount, rewardConfig),
    [purchaseAmount, rewardConfig],
  );

  // Format reward information for display with external payment context
  const rewardDisplay = useMemo(
    () =>
      formatRewardForDisplay(
        rewardCalculation,
        satsToCurrency,
        isExternalPayment,
        paymentMethod,
      ),
    [rewardCalculation, satsToCurrency, isExternalPayment, paymentMethod],
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
    try {
      debugLog('REWARD_START', {
        isRewardsEnabled,
        hasLnurl: !!lnurl,
        rewardAmount: rewardCalculation.rewardAmount,
        isExternalPayment,
        purchaseAmount,
        paymentMethod,
        username,
        currency: currency?.id,
      });

      if (!isRewardsEnabled) {
        debugLog('ERROR_REWARDS_DISABLED');
        toastShow({
          message: 'Rewards system is currently disabled.',
          type: 'error',
        });
        return;
      }

      // Validate required data before proceeding
      if (!lnurl) {
        debugLog('ERROR_MISSING_LNURL');
        console.error('LNURL is missing');
        toastShow({
          message: 'Unable to process reward. Please try again.',
          type: 'error',
        });
        return;
      }

      debugLog('CREATING_REQUEST_BODY', {
        destination: lnurl?.substring(0, 20) + '...',
        amount: rewardCalculation.rewardAmount,
      });

      const requestBody = {
        destination: lnurl,
        amount: rewardCalculation.rewardAmount, // Dynamic amount based on calculation
        payoutMethodId: 'BTC-LN',
      };

      const url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;

      console.log('Processing reward:', {
        amount: rewardCalculation.rewardAmount,
        isExternalPayment,
        purchaseAmount,
        paymentMethod,
        username,
      });

      debugLog('MAKING_API_REQUEST', {url: url.substring(0, 50) + '...'});

      const response = await axios.post(url, requestBody);

      debugLog('API_RESPONSE_RECEIVED', {
        hasData: !!response.data,
        status: response.status,
      });

      console.log('Response from redeeming rewards:', response.data);

      debugLog('RESETTING_FLASHCARD');
      resetFlashcard();

      if (response.data) {
        debugLog('PROCESSING_SUCCESS_RESPONSE', {
          isExternalPayment,
          hasPurchaseAmount: !!purchaseAmount,
          hasCurrency: !!currency,
          hasUsername: !!username,
        });

        // CRITICAL FIX: Only create external payment transactions when appropriate
        if (isExternalPayment && purchaseAmount && currency && username) {
          try {
            debugLog('CREATING_EXTERNAL_PAYMENT_TRANSACTION');

            const rewardData = createRewardData(rewardCalculation, false);

            debugLog('REWARD_DATA_CREATED', rewardData);

            // Safely extract display amount with fallback
            const cleanDisplayAmount = purchaseDisplayAmount
              ? String(purchaseDisplayAmount).replace(/[^0-9.]/g, '')
              : '0';

            debugLog('CREATING_TRANSACTION_DATA', {
              satAmount: Number(purchaseAmount) || 0,
              displayAmount: cleanDisplayAmount,
              currency: currency.id,
              username,
              paymentMethod: paymentMethod || 'external',
            });

            const transactionData = createRewardsOnlyTransaction({
              amount: {
                satAmount: Number(purchaseAmount) || 0,
                displayAmount: cleanDisplayAmount,
                currency: currency,
                isPrimaryAmountSats: false,
              },
              merchant: {
                username: username,
              },
              paymentMethod: paymentMethod || 'external',
              reward: rewardData,
            });

            debugLog('DISPATCHING_TRANSACTION', {
              transactionId: transactionData.id,
            });

            dispatch(addTransaction(transactionData));
            console.log(
              'External payment transaction created:',
              transactionData.id,
            );

            debugLog('EXTERNAL_PAYMENT_TRANSACTION_SUCCESS');
          } catch (transactionError) {
            const errorMessage =
              transactionError instanceof Error
                ? transactionError.message
                : 'Unknown transaction error';
            const errorStack =
              transactionError instanceof Error
                ? transactionError.stack?.substring(0, 200)
                : 'No stack trace';

            debugLog('ERROR_CREATING_TRANSACTION', {
              error: errorMessage,
              stack: errorStack,
            });
            console.error(
              'Error creating external payment transaction:',
              transactionError,
            );
            // Don't fail the whole reward process if transaction creation fails
            toastShow({
              message: 'Reward successful, but transaction record failed.',
              type: 'info',
            });
          }
        }

        debugLog('CALCULATING_BALANCE_DISPLAY');

        // Safely calculate balance display with error handling
        let displayAmount = '';
        try {
          if (balanceInSats !== undefined && balanceInSats !== null) {
            const balanceCalc = satsToCurrency(
              balanceInSats + rewardCalculation.rewardAmount,
            );
            displayAmount = balanceCalc?.formattedCurrency || '';

            debugLog('BALANCE_CALCULATED', {
              balanceInSats,
              rewardAmount: rewardCalculation.rewardAmount,
              displayAmount,
            });
          }
        } catch (balanceError) {
          const errorMessage =
            balanceError instanceof Error
              ? balanceError.message
              : 'Unknown balance error';

          debugLog('ERROR_CALCULATING_BALANCE', {
            error: errorMessage,
          });
          console.error('Error calculating balance display:', balanceError);
          displayAmount = '';
        }

        debugLog('PREPARING_NAVIGATION', {
          rewardSatAmount: rewardCalculation.rewardAmount,
          balance: displayAmount,
          calculationType: rewardCalculation.calculationType,
        });

        // Navigate with enhanced parameters including external payment context
        navigation.navigate('RewardsSuccess', {
          rewardSatAmount: rewardCalculation.rewardAmount,
          balance: displayAmount,
          purchaseAmount: purchaseAmount || undefined,
          purchaseCurrency: purchaseCurrency || undefined,
          purchaseDisplayAmount: purchaseDisplayAmount || undefined,
          rewardRate: rewardCalculation.rewardRate || 0,
          calculationType: rewardCalculation.calculationType,
          isExternalPayment: isExternalPayment || false,
          paymentMethod: paymentMethod || undefined,
        });

        debugLog('NAVIGATION_SUCCESS');
      } else {
        debugLog('ERROR_NO_RESPONSE_DATA');
        toastShow({
          message: 'Reward request failed. Please try again.',
          type: 'error',
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const errorStack =
        error instanceof Error
          ? error.stack?.substring(0, 500)
          : 'No stack trace';
      const errorName = error instanceof Error ? error.name : 'Unknown';

      debugLog('CRITICAL_ERROR_IN_ONREWARD', {
        error: errorMessage,
        stack: errorStack,
        name: errorName,
      });

      console.error('Critical error in onReward:', error);

      // Reset flashcard to allow retry
      resetFlashcard();

      // Show user-friendly error message
      toastShow({
        message: `Reward failed: ${errorMessage}`,
        type: 'error',
      });
    }
  }, [
    isRewardsEnabled,
    lnurl,
    rewardCalculation,
    resetFlashcard,
    balanceInSats,
    satsToCurrency,
    navigation,
    purchaseAmount,
    purchaseCurrency,
    purchaseDisplayAmount,
    isExternalPayment,
    paymentMethod,
    dispatch,
    username,
    currency,
    debugLog,
  ]);

  useFocusEffect(
    useCallback(() => {
      // CRITICAL FIX: Add safety checks before auto-processing rewards
      debugLog('FOCUS_EFFECT_TRIGGERED', {
        loading,
        hasLnurl: !!lnurl,
        isRewardsEnabled,
        hasRewardCalculation: !!rewardCalculation,
        rewardAmount: rewardCalculation?.rewardAmount,
      });

      if (loading || !lnurl || !isRewardsEnabled) {
        debugLog('SKIPPING_AUTO_REWARD_BASIC_CHECKS', {
          loading,
          hasLnurl: !!lnurl,
          isRewardsEnabled,
        });
        console.log('Skipping auto-reward:', {
          loading,
          hasLnurl: !!lnurl,
          isRewardsEnabled,
        });
        return;
      }

      // Additional safety: Don't auto-process if we're in an invalid state
      if (!rewardCalculation || rewardCalculation.rewardAmount <= 0) {
        debugLog('SKIPPING_AUTO_REWARD_INVALID_CALCULATION', {
          hasRewardCalculation: !!rewardCalculation,
          rewardAmount: rewardCalculation?.rewardAmount,
        });
        console.log('Skipping auto-reward: Invalid reward calculation');
        return;
      }

      // Log for debugging
      debugLog('AUTO_PROCESSING_REWARD', {
        rewardAmount: rewardCalculation.rewardAmount,
        calculationType: rewardCalculation.calculationType,
        isExternalPayment,
      });
      console.log('Auto-processing reward via useFocusEffect:', {
        rewardAmount: rewardCalculation.rewardAmount,
        calculationType: rewardCalculation.calculationType,
        isExternalPayment,
      });

      try {
        onReward();
      } catch (focusError) {
        const errorMessage =
          focusError instanceof Error
            ? focusError.message
            : 'Unknown focus error';
        debugLog('ERROR_IN_FOCUS_EFFECT', {error: errorMessage});
        console.error('Error in useFocusEffect onReward:', focusError);
      }
    }, [
      loading,
      lnurl,
      isRewardsEnabled,
      onReward,
      rewardCalculation,
      isExternalPayment,
      debugLog,
    ]),
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
      {/* Debug Info for Physical Device Testing */}
      <DebugContainer>
        <DebugText>
          Debug: {debugInfo.lastStep} (#{debugInfo.stepCount})
        </DebugText>
        {debugInfo.lastError && (
          <DebugErrorText>Last Error: {debugInfo.lastError}</DebugErrorText>
        )}
        <DebugText>Rewards: {isRewardsEnabled ? 'ON' : 'OFF'}</DebugText>
        <DebugText>LNURL: {lnurl ? 'OK' : 'MISSING'}</DebugText>
        <DebugText>Loading: {loading ? 'YES' : 'NO'}</DebugText>
        <DebugText>External: {isExternalPayment ? 'YES' : 'NO'}</DebugText>
        <DebugText>User: {username || 'NONE'}</DebugText>
        <DebugText>Currency: {currency?.id || 'NONE'}</DebugText>
        <DebugText>Reward: {rewardCalculation.rewardAmount} sats</DebugText>
      </DebugContainer>

      {/* Enhanced Header Section */}
      <HeaderSection>
        <Title>
          {isExternalPayment
            ? 'Claim Bitcoin Rewards for Your Payment!'
            : isPurchaseBased
            ? 'Claim Your Purchase Reward!'
            : 'Tap any Flashcard to receive rewards!'}
        </Title>

        {/* Purchase Context Card */}
        {purchaseDisplayAmount && (
          <Animatable.View animation="fadeInDown" duration={800}>
            <PurchaseCard>
              <PurchaseLabel>
                {isExternalPayment
                  ? 'External Payment Amount'
                  : 'Purchase Amount'}
              </PurchaseLabel>
              <PurchaseAmount>{purchaseDisplayAmount}</PurchaseAmount>
              {rewardPercentage && (
                <RewardRateBadge>
                  <RewardRateText>
                    {rewardPercentage}% Bitcoin Reward
                  </RewardRateText>
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
          {isExternalPayment
            ? 'Tap your flashcard to claim your Bitcoin reward'
            : isPurchaseBased
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

const DebugContainer = styled.View`
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 10px;
  background-color: rgba(0, 0, 0, 0.5);
  border-radius: 10px;
`;

const DebugText = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #ffffff;
  margin-bottom: 5px;
`;

const DebugErrorText = styled.Text`
  font-size: 12px;
  font-family: 'Outfit-Regular';
  color: #ff6b6b;
`;
