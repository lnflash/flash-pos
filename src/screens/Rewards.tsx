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
  // DIAGNOSTIC: Check environment variables immediately
  console.log('=== REWARDS COMPONENT INITIALIZING ===');
  console.log('BTC_PAY_SERVER exists:', !!BTC_PAY_SERVER);
  console.log('PULL_PAYMENT_ID exists:', !!PULL_PAYMENT_ID);

  // Extract navigation parameters (all optional for backward compatibility)
  const {
    purchaseAmount,
    purchaseCurrency,
    purchaseDisplayAmount,
    isExternalPayment,
    paymentMethod,
  } = route.params || {};

  // Debug state for physical device testing (temporarily disabled)
  const [_debugInfo, _setDebugInfo] = useState<{
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

  // onReward callback for both auto-trigger and manual NFC tapping
  const onReward = useCallback(async () => {
    try {
      console.log('=== REWARD PROCESS START ===');

      if (!isRewardsEnabled) {
        toastShow({
          message: 'Rewards system is currently disabled.',
          type: 'error',
        });
        return;
      }

      // Validate required data before proceeding
      if (!lnurl) {
        console.error('LNURL is missing');
        toastShow({
          message: 'Unable to process reward. Please try again.',
          type: 'error',
        });
        return;
      }

      console.log('=== CREATING REQUEST BODY ===');

      const requestBody = {
        destination: lnurl,
        amount: rewardCalculation.rewardAmount, // Dynamic amount based on calculation
        payoutMethodId: 'BTC-LN',
      };

      // Safer URL construction with fallbacks
      let url = '';
      try {
        if (!BTC_PAY_SERVER || !PULL_PAYMENT_ID) {
          console.log('Environment variables missing');
          throw new Error('BTCPay server configuration missing');
        }
        url = `${BTC_PAY_SERVER}/api/v1/pull-payments/${PULL_PAYMENT_ID}/payouts`;
        console.log('=== URL CREATED ===');
      } catch (urlError) {
        console.log('URL creation failed');
        resetFlashcard();
        toastShow({
          message: 'Configuration error. Please contact support.',
          type: 'error',
        });
        return;
      }

      try {
        console.log('=== PROCESSING REWARD ===');
      } catch (consoleError) {
        console.log('Console logging failed, proceeding...');
      }

      console.log('=== MAKING API REQUEST ===');

      let response;
      try {
        // Ultra-safe debug step - minimal data exposure
        console.log('=== STARTING API CALL ===');

        // Check environment variables safely
        const hasBtcPayServer =
          typeof BTC_PAY_SERVER === 'string' && BTC_PAY_SERVER.length > 0;
        const hasPullPaymentId =
          typeof PULL_PAYMENT_ID === 'string' && PULL_PAYMENT_ID.length > 0;

        console.log('Environment check:', {
          hasBtcPayServer,
          hasPullPaymentId,
          hasUrl: typeof url === 'string',
          hasRequestBody: typeof requestBody === 'object',
        });

        if (!hasBtcPayServer || !hasPullPaymentId) {
          console.log('Environment variables missing');
          throw new Error(
            'Environment variables not configured for physical device',
          );
        }

        response = await axios.post(url, requestBody, {
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        });

        // Simple debug step immediately after API success
        console.log('=== API CALL COMPLETED ===');

        console.log('API response status:', response?.status);
      } catch (apiError) {
        const errorMessage =
          apiError instanceof Error ? apiError.message : 'Unknown API error';
        const errorCode = (apiError as any)?.code;
        const errorStatus = (apiError as any)?.response?.status;

        console.log('API Request failed:', {
          error: errorMessage,
          code: errorCode,
          status: errorStatus,
        });

        // Reset flashcard to allow retry
        resetFlashcard();

        // Show specific error message based on error type
        let userMessage =
          'Network error. Please check connection and try again.';
        if (
          errorCode === 'NETWORK_ERROR' ||
          errorMessage.includes('Network Error')
        ) {
          userMessage = 'No internet connection. Please check your network.';
        } else if (
          errorCode === 'ECONNABORTED' ||
          errorMessage.includes('timeout')
        ) {
          userMessage = 'Request timed out. Please try again.';
        } else if (errorStatus) {
          userMessage = `Server error (${errorStatus}). Please try again later.`;
        }

        toastShow({
          message: userMessage,
          type: 'error',
        });
        return;
      }

      console.log('=== API RESPONSE RECEIVED ===');

      try {
        console.log('Response exists:', !!response?.data);
      } catch (logError) {
        console.log(
          'Response logging failed, response exists:',
          !!response?.data,
        );
      }

      console.log('=== RESETTING FLASHCARD ===');
      resetFlashcard();

      if (response.data) {
        console.log('=== PROCESSING SUCCESS RESPONSE ===');

        // CRITICAL FIX: Only create external payment transactions when appropriate
        if (isExternalPayment && purchaseAmount && currency && username) {
          try {
            console.log('=== CREATING EXTERNAL PAYMENT TRANSACTION ===');

            const rewardData = createRewardData(rewardCalculation, false);

            // Safely extract display amount with fallback
            const cleanDisplayAmount = purchaseDisplayAmount
              ? String(purchaseDisplayAmount).replace(/[^0-9.]/g, '')
              : '0';

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

            dispatch(addTransaction(transactionData));
            console.log(
              'External payment transaction created:',
              transactionData.id,
            );

            console.log('=== EXTERNAL PAYMENT TRANSACTION SUCCESS ===');
          } catch (transactionError) {
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

        console.log('=== CALCULATING BALANCE DISPLAY ===');

        // Safely calculate balance display with error handling
        let displayAmount = '';
        try {
          if (balanceInSats !== undefined && balanceInSats !== null) {
            const balanceCalc = satsToCurrency(
              balanceInSats + rewardCalculation.rewardAmount,
            );
            displayAmount = balanceCalc?.formattedCurrency || '';

            console.log('Balance calculated successfully');
          }
        } catch (balanceError) {
          console.error('Error calculating balance display:', balanceError);
          displayAmount = '';
        }

        console.log('=== PREPARING NAVIGATION ===');

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

        console.log('=== NAVIGATION SUCCESS ===');
      } else {
        console.log('=== ERROR: NO RESPONSE DATA ===');
        toastShow({
          message: 'Reward request failed. Please try again.',
          type: 'error',
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

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
  ]);

  useFocusEffect(
    useCallback(() => {
      // RE-ENABLED: Auto-reward processing (crash was API-related, not auto-trigger)
      console.log('=== FOCUS EFFECT TRIGGERED ===');

      if (loading || !lnurl || !isRewardsEnabled) {
        console.log('=== SKIPPING AUTO REWARD BASIC CHECKS ===');
        console.log('Skipping auto-reward:', {
          loading,
          hasLnurl: !!lnurl,
          isRewardsEnabled,
        });
        return;
      }

      // Additional safety: Don't auto-process if we're in an invalid state
      if (!rewardCalculation || rewardCalculation.rewardAmount <= 0) {
        console.log('=== SKIPPING AUTO REWARD INVALID CALCULATION ===');
        console.log('Skipping auto-reward: Invalid reward calculation');
        return;
      }

      // Log for debugging
      console.log('=== AUTO PROCESSING REWARD ===');
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
        console.error(
          'Error in useFocusEffect onReward:',
          errorMessage,
          focusError,
        );
      }
    }, [
      loading,
      lnurl,
      isRewardsEnabled,
      onReward,
      rewardCalculation,
      isExternalPayment,
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
      {/* Debug Info temporarily disabled to isolate crash 
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
      */}

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
