import React from 'react';
import {ViewStyle} from 'react-native';
import styled from 'styled-components/native';

type Props = {
  btnText: string;
  btnStyle?: ViewStyle;
  onPress: () => void;
};

const PrimaryButton: React.FC<Props> = ({btnText, btnStyle, onPress}) => {
  return (
    <Wrapper style={btnStyle} onPress={onPress} activeOpacity={0.5}>
      <Text>{btnText}</Text>
    </Wrapper>
  );
};

export default PrimaryButton;

const Wrapper = styled.TouchableOpacity`
  width: 100%;
  background-color: #061237;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  padding-vertical: 15px;
`;

const Text = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-Bold';
  color: #fff;
`;
