import React from 'react';
import styled from 'styled-components/native';
import {StackScreenProps} from '@react-navigation/stack';
import {PrimaryButton} from '../components';
import Logo from '../assets/icons/logo.png';

type Props = StackScreenProps<RootStackType, 'Welcome'>;

const Welcome: React.FC<Props> = ({navigation}) => (
  <Wrapper>
    <ContentWrapper>
      <LogoWrapper>
        <Icon source={Logo} />
        <Title>flash POS</Title>
      </LogoWrapper>
      <Description>
        Welcome to Flash POS - your simple and secure point of sale solution for
        accepting Bitcoin and Lightning payments.
      </Description>
      <FeatureList>
        <FeatureItem>✓ Fast & Secure Payments</FeatureItem>
        <FeatureItem>✓ Real-time Transaction Monitoring</FeatureItem>
        <FeatureItem>✓ Simple User Interface</FeatureItem>
        <FeatureItem>✓ Built on Lightning Network</FeatureItem>
      </FeatureList>
    </ContentWrapper>
    <BtnWrapper>
      <PrimaryButton
        btnText="Get Started"
        onPress={() => navigation.navigate('Auth')}
      />
    </BtnWrapper>
  </Wrapper>
);

const Wrapper = styled.View`
  flex: 1;
  background-color: #fff;
  padding-bottom: 20px;
  justify-content: space-between;
`;

const ContentWrapper = styled.View`
  flex: 1;
  justify-content: center;
  margin-horizontal: 20px;
`;

const LogoWrapper = styled.View`
  justify-content: center;
  align-items: center;
  margin-bottom: 40px;
`;

const Title = styled.Text`
  font-family: 'Outfit-Bold';
  font-size: 32px;
  text-align: center;
  color: #061237;
  margin-top: 10px;
`;

const Description = styled.Text`
  font-family: 'Outfit-Regular';
  font-size: 16px;
  text-align: center;
  color: #333;
  margin-bottom: 30px;
  line-height: 24px;
`;

const FeatureList = styled.View`
  margin-vertical: 20px;
`;

const FeatureItem = styled.Text`
  font-family: 'Outfit-Medium';
  font-size: 16px;
  color: #333;
  margin-vertical: 8px;
`;

const Icon = styled.Image`
  width: 120px;
  height: 120px;
`;

const BtnWrapper = styled.View`
  margin-horizontal: 20px;
`;

export default Welcome;
