import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

// hooks
import {useAppDispatch, useAppSelector} from '../../store/hooks';

// store
import {updateAmount} from '../../store/slices/amountSlice';

const height = Dimensions.get('screen').height;

const NumPad = () => {
  const dispatch = useAppDispatch();
  const {currency, isPrimaryAmountSats} = useAppSelector(state => state.amount);

  return (
    <NumbersWrapper>
      <RowWrapper>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '1'))}>
          <NumText>1</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '2'))}>
          <NumText>2</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '3'))}>
          <NumText>3</NumText>
        </NumBtn>
      </RowWrapper>
      <RowWrapper>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '4'))}>
          <NumText>4</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '5'))}>
          <NumText>5</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '6'))}>
          <NumText>6</NumText>
        </NumBtn>
      </RowWrapper>
      <RowWrapper>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '7'))}>
          <NumText>7</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '8'))}>
          <NumText>8</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '9'))}>
          <NumText>9</NumText>
        </NumBtn>
      </RowWrapper>
      <RowWrapper>
        {currency.fractionDigits > 0 ? (
          <NumBtn
            onPress={() => dispatch(updateAmount('addDigit', '.'))}
            disabled={isPrimaryAmountSats}>
            <NumText>.</NumText>
          </NumBtn>
        ) : (
          <NumBtn
            onPress={() => dispatch(updateAmount('addDigit', '.'))}
            disabled={true}>
            <NumText></NumText>
          </NumBtn>
        )}
        <NumBtn onPress={() => dispatch(updateAmount('addDigit', '0'))}>
          <NumText>0</NumText>
        </NumBtn>
        <NumBtn onPress={() => dispatch(updateAmount('clearInput'))}>
          <Icon name={'xmark'} size={35} color={'#db254e'} />
        </NumBtn>
      </RowWrapper>
    </NumbersWrapper>
  );
};

export default NumPad;

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
