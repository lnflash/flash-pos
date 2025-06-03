import React from 'react';
import {TextStyle, ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

type Props = {
  icon?: string;
  btnText: string;
  iconColor?: string;
  textStyle?: TextStyle;
  btnStyle?: ViewStyle;
  onPress: () => void;
};

const iconStyle = {marginRight: 5};

const PrimaryButton: React.FC<Props> = ({
  icon,
  btnText,
  iconColor = '#fff',
  textStyle,
  btnStyle,
  onPress,
}) => (
  <Wrapper style={btnStyle} onPress={onPress} activeOpacity={0.5}>
    {icon && (
      <Icon name={icon} size={20} solid color={iconColor} style={iconStyle} />
    )}
    <Text style={textStyle}>{btnText}</Text>
  </Wrapper>
);

const Wrapper = styled.TouchableOpacity`
  width: 100%;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 100px;
  background-color: #002118;
  padding-vertical: 15px;
`;

const Text = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #fff;
`;

export default PrimaryButton;
