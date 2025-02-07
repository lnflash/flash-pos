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

const PrimaryButton: React.FC<Props> = ({
  icon,
  btnText,
  iconColor,
  textStyle,
  btnStyle,
  onPress,
}) => {
  return (
    <Wrapper style={btnStyle} onPress={onPress} activeOpacity={0.5}>
      {icon && (
        <Icon
          name={icon}
          size={20}
          solid
          color={iconColor || '#fff'}
          style={{marginRight: 5}}
        />
      )}
      <Text style={textStyle}>{btnText}</Text>
    </Wrapper>
  );
};

export default PrimaryButton;

const Wrapper = styled.TouchableOpacity`
  width: 100%;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  border-radius: 100px;
  background-color: #002118;
  padding-vertical: 10px;
`;

const Text = styled.Text`
  font-size: 18px;
  font-family: 'Outfit-Bold';
  color: #fff;
`;
