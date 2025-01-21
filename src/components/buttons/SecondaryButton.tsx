import React from 'react';
import {ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

type Props = {
  icon: string;
  btnText: string;
  btnStyle?: ViewStyle;
  onPress: () => void;
};

const SecondaryButton: React.FC<Props> = ({
  icon,
  btnText,
  btnStyle,
  onPress,
}) => {
  return (
    <Wrapper style={btnStyle} onPress={onPress} activeOpacity={0.5}>
      <Icon name={icon} size={20} solid />
      <Text>{btnText}</Text>
    </Wrapper>
  );
};

export default SecondaryButton;

const Wrapper = styled.TouchableOpacity`
  width: 90%;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid #061237;
  padding-vertical: 10px;
`;

const Text = styled.Text`
  font-size: 20px;
  font-family: 'Outfit-Bold';
  color: #000;
  margin-left: 5px;
`;
