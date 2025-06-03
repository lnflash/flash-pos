import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
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
  } = route.params;

  const {satsToCurrency} = useRealtimePrice();
  const {formattedCurrency} = satsToCurrency(rewardSatAmount);

  const onDone = () => {
    navigation.reset({
      index: 0,
      routes: [{name: 'Home'}],
    });
  };

  // Create contextual reward message based on calculation type
  const renderRewardContext = () => {
    if (
      calculationType === 'purchase-based' &&
      rewardRate &&
      purchaseDisplayAmount
    ) {
      const percentage = (rewardRate * 100).toFixed(1);
      return (
        <RewardContext>
          You earned {percentage}% on your {purchaseDisplayAmount} purchase!
        </RewardContext>
      );
    }

    if (calculationType === 'standalone') {
      return <RewardContext>Standalone reward earned!</RewardContext>;
    }

    return null;
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <Title>{balance}</Title>
        <Image source={Reward} />
        <Subtitle>The Reward has been given!</Subtitle>

        {/* Purchase context information */}
        {renderRewardContext()}

        <PrimaryAmount>{`${formattedCurrency || 0}`}</PrimaryAmount>
        <SecondaryAmount>{`≈ ${rewardSatAmount || 0} sats`}</SecondaryAmount>

        {/* Additional purchase details if available */}
        {purchaseDisplayAmount && calculationType === 'purchase-based' && (
          <PurchaseDetails>
            Original purchase: {purchaseDisplayAmount}
          </PurchaseDetails>
        )}
      </InnerWrapper>
      <PrimaryButton
        btnText="Done"
        textStyle={{color: '#002118'}}
        btnStyle={{backgroundColor: '#fff'}}
        onPress={onDone}
      />
    </Wrapper>
  );
};

export default RewardsSuccess;

const Wrapper = styled.View`
  flex: 1;
  background-color: #007856;
  padding-bottom: 20px;
  padding-horizontal: 20px;
`;

const InnerWrapper = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const Title = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #fff;
  margin-bottom: 20px;
`;

const Subtitle = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #fff;
  margin-top: 20px;
`;

const RewardContext = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #fff;
  margin-top: 10px;
  margin-bottom: 15px;
  opacity: 0.9;
`;

const PrimaryAmount = styled.Text`
  font-size: 40px;
  font-family: 'Outfit-Regular';
  color: #fff;
`;

const SecondaryAmount = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Regular';
  color: #fff;
  opacity: 0.8;
`;

const PurchaseDetails = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Regular';
  text-align: center;
  color: #fff;
  margin-top: 15px;
  opacity: 0.7;
`;

const Image = styled.Image`
  width: ${width - 80}px;
  height: ${width - 80}px;
`;
