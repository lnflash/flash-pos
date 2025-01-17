import React from 'react';
import styled from 'styled-components/native';

type Props = {
  btnText: string;
  onPress: () => void;
};

const PrimaryButton: React.FC<Props> = ({btnText, onPress}) => {
  return (
    <Wrapper onPress={onPress} activeOpacity={0.5}>
      <Text>{btnText}</Text>
    </Wrapper>
  );
};

export default PrimaryButton;

const Wrapper = styled.TouchableOpacity`
  background-color: #061237;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  padding-vertical: 15px;
`;

const Text = styled.Text`
  font-size: 20px;
  color: #fff;
`;
