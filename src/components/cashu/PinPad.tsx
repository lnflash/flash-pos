import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

const height = Dimensions.get('screen').height;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

/**
 * The Visa-style PIN pad: full-screen keys, masked entry, 4–8 digits.
 * Self-contained — the caller renders the dots and owns the confirm.
 */
const PinPad = ({
  onDigit,
  onBackspace,
  onClear,
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) => {
  const key = (d: string, onPress?: () => void, node?: React.ReactNode) => (
    <NumBtn key={d} onPress={onPress ?? (() => onDigit(d))}>
      {node ?? <NumText>{d}</NumText>}
    </NumBtn>
  );
  return (
    <NumbersWrapper>
      <RowWrapper>
        {key('1')}
        {key('2')}
        {key('3')}
      </RowWrapper>
      <RowWrapper>
        {key('4')}
        {key('5')}
        {key('6')}
      </RowWrapper>
      <RowWrapper>
        {key('7')}
        {key('8')}
        {key('9')}
      </RowWrapper>
      <RowWrapper>
        {key('clear', onClear, <Icon name={'xmark'} size={35} color={'#db254e'} />)}
        {key('0')}
        {key('back', onBackspace, <Icon name={'delete-left'} size={35} color={'#1f2328'} />)}
      </RowWrapper>
    </NumbersWrapper>
  );
};

export default PinPad;

const RowWrapper = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const NumbersWrapper = styled.View`
  flex: 1;
`;

const NumBtn = styled.TouchableOpacity`
  flex: 1;
  height: ${height / 8.5}px;
  justify-content: center;
  align-items: center;
`;

const NumText = styled.Text`
  font-size: 35px;
  font-weight: bold;
`;
