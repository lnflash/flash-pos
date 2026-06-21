import React, {useEffect} from 'react';
import {Dimensions, BackHandler} from 'react-native';
import styled from 'styled-components/native';
import * as Animatable from 'react-native-animatable';
import {StackScreenProps} from '@react-navigation/stack';
import {useFocusEffect} from '@react-navigation/native';

// components
import {PrimaryButton} from '../components';

// hooks
import {useRealtimePrice} from '../hooks';
import {useFlashcard} from '../hooks';

// assets
import Reward from '../assets/icons/reward.svg';

const width = Dimensions.get('screen').width;

type Props = StackScreenProps<RootStackType, 'RewardsSuccess'>;

const RewardsSuccess: React.FC<Props> = ({navigation, route}) => {
  const {
    rewardSatAmount,
    balance,
    purchaseDisplayAmount,
    isExternalPayment,
  } = route.params;

  const {satsToCurrency} = useRealtimePrice();
  const {setNfcEnabled} = useFlashcard();
  const {formattedCurrency} = satsToCurrency(rewardSatAmount);

  // Disable NFC on mount and re-enable on unmount
  useEffect(() => {
    setNfcEnabled(false);

    return () => {
      setNfcEnabled(true);
    };
  }, [setNfcEnabled]);

  const onDone = () => {
    navigation.reset({
      index: 0,
      routes: [{name: 'Home'}],
    });
  };

  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        return true;
      },
    );

    return () => {
      backHandler.remove();
    };
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      const backHandler = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          return true;
        },
      );

      return () => {
        backHandler.remove();
      };
    }, []),
  );

  return (
    <Wrapper>
      <InnerWrapper>
        {/* Simplified Success Header */}
        <Animatable.View animation="bounceIn" duration={1000} delay={200}>
          <SuccessHeader>
            <SuccessTitle>🎉 Reward Earned!</SuccessTitle>
          </SuccessHeader>
        </Animatable.View>

        {/* Simplified Reward Amount Card */}
        <Animatable.View animation="zoomIn" duration={800} delay={400}>
          <RewardCard>
            <Image source={Reward} />
            <RewardAmountContainer>
              <RewardAmountText>{rewardSatAmount} points</RewardAmountText>
              <RewardCurrencyText>
                {formattedCurrency || '0'}
              </RewardCurrencyText>
            </RewardAmountContainer>
          </RewardCard>
        </Animatable.View>

        {/* Simplified Purchase Context for External Payments */}
        {isExternalPayment && purchaseDisplayAmount && (
          <Animatable.View animation="fadeInUp" duration={800} delay={600}>
            <PurchaseContextCard>
              <PurchaseDetailRow>
                <PurchaseDetailLabel>Payment</PurchaseDetailLabel>
                <PurchaseDetailValue>
                  {purchaseDisplayAmount}
                </PurchaseDetailValue>
              </PurchaseDetailRow>
              <PurchaseDetailRow>
                <PurchaseDetailLabel>Bitcoin Earned</PurchaseDetailLabel>
                <PurchaseDetailValue highlight>
                  {rewardSatAmount} points
                </PurchaseDetailValue>
              </PurchaseDetailRow>
            </PurchaseContextCard>
          </Animatable.View>
        )}

        {/* Updated Balance */}
        <Animatable.View animation="fadeIn" duration={800} delay={800}>
          <BalanceContainer>
            <BalanceLabel>New Balance</BalanceLabel>
            <BalanceAmount>{balance}</BalanceAmount>
          </BalanceContainer>
        </Animatable.View>
      </InnerWrapper>

      <Animatable.View animation="slideInUp" duration={600} delay={1000}>
        <PrimaryButton
          btnText="Continue"
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
  background-color: #007856;
  padding: 20px;
  padding-top: 60px;
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

const BalanceContainer = styled.View`
  align-items: center;
  margin-top: 20px;
  margin-bottom: 40px;
`;

const BalanceLabel = styled.Text`
  font-size: 16px;
  font-family: 'Outfit-Medium';
  color: rgba(255, 255, 255, 0.9);
  margin-bottom: 4px;
`;

const BalanceAmount = styled.Text`
  font-size: 24px;
  font-family: 'Outfit-Bold';
  color: #fff;
`;
