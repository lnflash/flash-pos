import React from 'react';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

type Props = {
  icon: string | 'message';
  onPress: () => void;
};

const FloatingButton: React.FC<Props> = ({icon, onPress}) => {
  return (
    <Wrapper onPress={onPress}>
      <Icon name={icon} size={30} solid color={'#fff'} />
    </Wrapper>
  );
};

export default FloatingButton;

const Wrapper = styled.TouchableOpacity`
  position: absolute;
  bottom: 150;
  right: 20;
  padding: 20px;
  background-color: #007856;
  border-radius: 100px;
`;
