import React from 'react';
import {ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

type Props = {
  icon?: string;
  title: string;
  btnStyle?: ViewStyle;
  disabled?: boolean;
  onPress: () => void;
};

const TextButton: React.FC<Props> = ({
  icon,
  title,
  btnStyle,
  disabled = false,
  onPress,
}) => {
  const tint = disabled ? '#C6C6D0' : '#9292A0';
  return (
    <Btn
      style={btnStyle}
      disabled={disabled}
      accessibilityState={{disabled}}
      onPress={onPress}>
      {icon && <Icon name={icon} size={15} solid color={tint} />}
      <BtnText $disabled={disabled}>{title}</BtnText>
    </Btn>
  );
};

export default TextButton;

const Btn = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
`;

const BtnText = styled.Text<{$disabled: boolean}>`
  font-size: 15px;
  font-family: 'Outfit-SemiBold';
  color: ${({$disabled}) => ($disabled ? '#c6c6d0' : '#9292a0')};
  margin-left: 5px;
`;
