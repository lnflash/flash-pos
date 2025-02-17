import React from 'react';
import * as Animatable from 'react-native-animatable';
import styled from 'styled-components/native';
import {Icon} from '@rneui/themed';

// hooks
import {useRewards} from '../hooks';

// assets
import FlashCard from '../assets/images/flashCard.svg';

const Rewards = () => {
  useRewards();

  return (
    <Wrapper>
      <Title>Tap your card to get rewards!</Title>
      <Animatable.View
        animation="pulse"
        easing="ease-out"
        iterationCount="infinite">
        <Icon
          name={'radio-outline'}
          size={150}
          type="ionicon"
          color={'#41AC48'}
        />
      </Animatable.View>
      <Image source={FlashCard} />
    </Wrapper>
  );
};

export default Rewards;

const Wrapper = styled.View`
  flex: 1;
  background-color: #ffffff;
  align-items: center;
`;

const Title = styled.Text`
  font-size: 26px;
  font-family: 'Outfit-Medium';
  text-align: center;
  color: #002118;
  margin-top: 100px;
  margin-bottom: 30px;
`;

const Image = styled.Image``;
