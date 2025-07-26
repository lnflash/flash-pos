import React from 'react';
import {ViewStyle} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

type Props = {
  icon?: string;
  title: string;
  btnStyle?: ViewStyle;
  onPress: () => void;
};

const TextButton: React.FC<Props> = ({icon, title, btnStyle, onPress}) => {
  return (
    <Btn style={btnStyle} onPress={onPress}>
      {icon && <Icon name={icon} size={15} solid color={'#9292A0'} />}
      <BtnText>{title}</BtnText>
    </Btn>
  );
};

export default TextButton;

const Btn = styled.TouchableOpacity`
  flex-direction: row;
  align-items: center;
  justify-content: center;
`;

const BtnText = styled.Text`
  font-size: 15px;
  font-family: 'Outfit-SemiBold';
  color: #9292a0;
  margin-left: 5px;
`;
