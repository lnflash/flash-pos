import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {PrimaryButton} from '../components';

// hooks
import {useRealtimePrice} from '../hooks';

// assets
import Reward from '../assets/icons/reward.svg';

const width = Dimensions.get('screen').width;

type Props = StackScreenProps<RootStackType, 'RewardsSuccess'>;

const RewardsSuccess: React.FC<Props> = ({navigation, route}) => {
  const {
    rewardSatAmount,
    balance,
    purchaseDisplayAmount,
    rewardRate,
    calculationType,
    isExternalPayment,
    paymentMethod,
  } = route.params;

  const {satsToCurrency} = useRealtimePrice();
  const {formattedCurrency} = satsToCurrency(rewardSatAmount);

  const onDone = () => {
    navigation.reset({
      index: 0,
      routes: [{name: 'Home'}],
    });
  };

  // Determine reward context
  const isPurchaseBased = calculationType === 'purchase-based';
  const rewardPercentage =
    isPurchaseBased && rewardRate ? (rewardRate * 100).toFixed(1) : null;

  // Get payment method display info
  const getPaymentMethodInfo = () => {
    switch (paymentMethod) {
      case 'cash':
        return {icon: '💵', name: 'Cash Payment'};
      case 'card':
        return {icon: '💳', name: 'Card Payment'};
      case 'check':
        return {icon: '📄', name: 'Check Payment'};
      default:
        return {icon: '🏪', name: 'External Payment'};
    }
  };

  const paymentInfo = getPaymentMethodInfo();

  return (
    <Wrapper>
      <InnerWrapper>
        {/* Success Header */}
        <Animatable.View animation="bounceIn" duration={1000} delay={200}>
          <SuccessHeader>
            <SuccessTitle>🎉 Reward Earned!</SuccessTitle>
            <SuccessSubtitle>
              {isExternalPayment
                ? 'Your Bitcoin reward for external payment has been added'
                : isPurchaseBased
                ? 'Your purchase reward has been added to your balance'
                : 'Your flashcard reward has been added to your balance'}
            </SuccessSubtitle>
          </SuccessHeader>
        </Animatable.View>

        {/* Reward Amount Card */}
        <Animatable.View animation="zoomIn" duration={800} delay={400}>
          <RewardCard>
            <Image source={Reward} />
            <RewardAmountContainer>
              <RewardAmountText>{rewardSatAmount} sats</RewardAmountText>
              <RewardCurrencyText>
                {formattedCurrency || '0'}
              </RewardCurrencyText>
            </RewardAmountContainer>
          </RewardCard>
        </Animatable.View>

        {/* External Payment Context Section */}
        {isExternalPayment && isPurchaseBased && purchaseDisplayAmount && (
          <Animatable.View animation="fadeInUp" duration={800} delay={600}>
            <PurchaseContextCard>
              <PurchaseContextHeader>
                <PurchaseIcon>{paymentInfo.icon}</PurchaseIcon>
                <PurchaseContextTitle>
                  External Payment Reward Details
                </PurchaseContextTitle>
              </PurchaseContextHeader>

              <PurchaseDetailRow>
                <PurchaseDetailLabel>Payment Method</PurchaseDetailLabel>
                <PurchaseDetailValue>{paymentInfo.name}</PurchaseDetailValue>
              </PurchaseDetailRow>

              <PurchaseDetailRow>
                <PurchaseDetailLabel>Payment Amount</PurchaseDetailLabel>
                <PurchaseDetailValue>
                  {purchaseDisplayAmount}
                </PurchaseDetailValue>
              </PurchaseDetailRow>

              {rewardPercentage && (
                <PurchaseDetailRow>
                  <PurchaseDetailLabel>Bitcoin Reward Rate</PurchaseDetailLabel>
                  <PurchaseDetailValue>{rewardPercentage}%</PurchaseDetailValue>
                </PurchaseDetailRow>
              )}

              <PurchaseDetailRow>
                <PurchaseDetailLabel>Bitcoin Earned</PurchaseDetailLabel>
                <PurchaseDetailValue highlight>
                  {rewardSatAmount} sats
                </PurchaseDetailValue>
              </PurchaseDetailRow>
            </PurchaseContextCard>
          </Animatable.View>
        )}

        {/* Lightning Purchase Context Section */}
        {!isExternalPayment && isPurchaseBased && purchaseDisplayAmount && (
          <Animatable.View animation="fadeInUp" duration={800} delay={600}>
            <PurchaseContextCard>
              <PurchaseContextHeader>
                <PurchaseIcon>🛍️</PurchaseIcon>
                <PurchaseContextTitle>
                  Purchase Reward Details
                </PurchaseContextTitle>
              </PurchaseContextHeader>

              <PurchaseDetailRow>
                <PurchaseDetailLabel>Purchase Amount</PurchaseDetailLabel>
                <PurchaseDetailValue>
                  {purchaseDisplayAmount}
                </PurchaseDetailValue>
              </PurchaseDetailRow>

              {rewardPercentage && (
                <PurchaseDetailRow>
                  <PurchaseDetailLabel>Reward Rate</PurchaseDetailLabel>
                  <PurchaseDetailValue>{rewardPercentage}%</PurchaseDetailValue>
                </PurchaseDetailRow>
              )}

              <PurchaseDetailRow>
                <PurchaseDetailLabel>Earned</PurchaseDetailLabel>
                <PurchaseDetailValue highlight>
                  {rewardSatAmount} sats
                </PurchaseDetailValue>
              </PurchaseDetailRow>
            </PurchaseContextCard>
          </Animatable.View>
        )}

        {/* Standalone Reward Message */}
        {!isPurchaseBased && (
          <Animatable.View animation="fadeInUp" duration={800} delay={600}>
            <StandaloneCard>
              <StandaloneIcon>⚡</StandaloneIcon>
              <StandaloneTitle>Flashcard Reward</StandaloneTitle>
              <StandaloneMessage>
                You've received a standalone reward for using your flashcard!
              </StandaloneMessage>
            </StandaloneCard>
          </Animatable.View>
        )}

        {/* Updated Balance */}
        <Animatable.View animation="fadeIn" duration={800} delay={800}>
          <BalanceContainer>
            <BalanceLabel>Your New Balance</BalanceLabel>
            <BalanceAmount>{balance}</BalanceAmount>
          </BalanceContainer>
        </Animatable.View>
      </InnerWrapper>

      <Animatable.View animation="slideInUp" duration={600} delay={1000}>
        <PrimaryButton
          btnText="Continue Shopping"
          textStyle={{
            color: '#007856',
            fontSize: 18,
            fontFamily: 'Outfit-Bold',
          }}
          btnStyle={{
            backgroundColor: '#fff',
            borderRadius: 16,
            paddingVertical: 16,
            shadowColor: '#000',
            shadowOffset: {width: 0, height: 4},
            shadowOpacity: 0.2,
            shadowRadius: 8,
            elevation: 8,
          }}
          onPress={onDone}
        />
      </Animatable.View>
    </Wrapper>
  );
};

export default RewardsSuccess;

const Wrapper = styled.View`
  flex: 1;
  background: linear-gradient(135deg, #007856 0%, #005940 100%);
  background-color: #007856;
  padding: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding-bottom: 40px;
`;

const SuccessHeader = styled.View`
  align-items: center;
  margin-bottom: 30px;
`;

const SuccessTitle = styled.Text`
  font-size: 32px;
  font-family: 'Outfit-Bold';
  text-align: center;
  color: #fff;
  margin-bottom: 12px;
`;

const SuccessSubtitle = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: rgba(255, 255, 255, 0.9);
  line-height: 22px;
  max-width: 300px;
`;

const RewardCard = styled.View`
  background-color: rgba(255, 255, 255, 0.95);
  border-radius: 24px;
  padding: 32px;
  align-items: center;
  shadow-color: #000;
  shadow-offset: 0px 8px;
  shadow-opacity: 0.3;
  shadow-radius: 16px;
  elevation: 12;
  margin-bottom: 24px;
  min-width: 280px;
`;

const Image = styled.Image`
  width: ${Math.min(width - 200, 120)}px;
  height: ${Math.min(width - 200, 120)}px;
  margin-bottom: 16px;
`;

const RewardAmountContainer = styled.View`
  align-items: center;
`;

const RewardAmountText = styled.Text`
  font-size: 36px;
  font-family: 'Outfit-Bold';
  color: #007856;
  margin-bottom: 4px;
`;

const RewardCurrencyText = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Medium';
  color: #666666;
`;

const PurchaseContextCard = styled.View`
  background-color: rgba(255, 255, 255, 0.9);
  border-radius: 20px;
  padding: 20px;
  margin-bottom: 20px;
  shadow-color: #000;
  shadow-offset: 0px 4px;
  shadow-opacity: 0.2;
  shadow-radius: 8px;
  elevation: 6;
  min-width: 300px;
`;

const PurchaseContextHeader = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: 16px;
`;

const PurchaseIcon = styled.Text`
  font-size: 24px;
  margin-right: 8px;
`;

const PurchaseContextTitle = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #007856;
  flex: 1;
`;

const PurchaseDetailRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
`;

const PurchaseDetailLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: #666666;
`;

const PurchaseDetailValue = styled.Text<{highlight?: boolean}>`
  font-size: 14px;
  font-family: 'Outfit-Bold';
  color: ${props => (props.highlight ? '#007856' : '#000000')};
`;

const StandaloneCard = styled.View`
  background-color: rgba(255, 255, 255, 0.9);
  border-radius: 20px;
  padding: 24px;
  align-items: center;
  margin-bottom: 20px;
  shadow-color: #000;
  shadow-offset: 0px 4px;
  shadow-opacity: 0.2;
  shadow-radius: 8px;
  elevation: 6;
  min-width: 280px;
`;

const StandaloneIcon = styled.Text`
  font-size: 48px;
  margin-bottom: 12px;
`;

const StandaloneTitle = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-Bold';
  color: #007856;
  margin-bottom: 8px;
`;

const StandaloneMessage = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Regular';
  color: #666666;
  text-align: center;
  line-height: 20px;
`;

const BalanceContainer = styled.View`
  align-items: center;
  margin-top: 20px;
`;

const BalanceLabel = styled.Text`
  font-size: 14px;
  font-family: 'Outfit-Medium';
  color: rgba(255, 255, 255, 0.8);
  margin-bottom: 4px;
`;

const BalanceAmount = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  color: #fff;
`;
