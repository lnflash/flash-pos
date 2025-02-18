import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';

// components
import {PrimaryButton} from '../components';

// hooks
import {useAppSelector} from '../store/hooks';

// assets
import Reward from '../assets/icons/reward.svg';

const width = Dimensions.get('screen').width;

type Props = StackScreenProps<RootStackType, 'RewardsSuccess'>;

const RewardsSuccess: React.FC<Props> = ({navigation, route}) => {
  const {satAmount, displayAmount, balance} = route.params;
  const {currency} = useAppSelector(state => state.amount);

  const onDone = () => {
    navigation.popToTop();
  };

  return (
    <Wrapper>
      <InnerWrapper>
        <Title>{balance}</Title>
        <Image source={Reward} />
        <Subtitle>The Reward has been given!</Subtitle>
        <PrimaryAmount>{`${currency.symbol} ${
          displayAmount || 0
        }`}</PrimaryAmount>
        <SecondaryAmount>{`≈ ${satAmount || 0} sats`}</SecondaryAmount>
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

const Image = styled.Image`
  width: ${width - 80}px;
  height: ${width - 80}px;
`;
