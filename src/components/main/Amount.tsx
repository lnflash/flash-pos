import React, {useEffect} from 'react';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

// components
import {CurrencyPicker} from '../modals';

// hooks
import {useRealtimePrice} from '../../hooks';
import {useAppDispatch, useAppSelector} from '../../store/hooks';

// store
import {
  setDisplayAmount,
  setIsPrimaryAmountSats,
  setSatAmount,
} from '../../store/slices/amountSlice';

const Amount = () => {
  const {currencyToSats, satsToCurrency, loading} = useRealtimePrice();
  const dispatch = useAppDispatch();
  const {currency, isPrimaryAmountSats, displayAmount, satAmount} =
    useAppSelector(state => state.amount);

  useEffect(() => {
    if (!loading && isPrimaryAmountSats) {
      const {convertedCurrencyAmount} = satsToCurrency(
        Number(satAmount),
        currency.id,
        currency.fractionDigits,
      );
      let displayAmount = Number(convertedCurrencyAmount).toFixed(2);
      if (
        convertedCurrencyAmount.toString().includes('NaN') ||
        displayAmount === '0.00'
      ) {
        displayAmount = '0';
      }
      dispatch(setDisplayAmount(displayAmount));
    }
  }, [isPrimaryAmountSats, satAmount, loading, currency]);

  useEffect(() => {
    if (!loading && !isPrimaryAmountSats) {
      const {convertedCurrencyAmount} = currencyToSats(
        Number(displayAmount),
        currency.id,
        currency.fractionDigits,
      );
      let satAmount = Math.round(convertedCurrencyAmount).toString();
      if (convertedCurrencyAmount.toString().includes('NaN')) {
        satAmount = '0';
      }
      dispatch(setSatAmount(satAmount));
    }
  }, [isPrimaryAmountSats, displayAmount, loading, currency]);

  const onToggle = () => {
    dispatch(setIsPrimaryAmountSats(!isPrimaryAmountSats));
  };

  return (
    <Wrapper>
      <CurrencyPickerWrapper>
        <CurrencyPicker />
      </CurrencyPickerWrapper>
      {!isPrimaryAmountSats ? (
        <AmountWrapper>
          <Primary>{`${currency.symbol} ${displayAmount || 0}`}</Primary>
          <Secondary>
            {satAmount || 0}
            <Secondary fontSize={15}> sats</Secondary>
          </Secondary>
        </AmountWrapper>
      ) : (
        <AmountWrapper>
          <Primary>
            {satAmount || 0}
            <Primary fontSize={15}> sats</Primary>
          </Primary>
          <Secondary>{`${currency.symbol} ${displayAmount || 0}`}</Secondary>
        </AmountWrapper>
      )}
      <IconWrapper>
        <IconBtn hitSlop={10} onPress={onToggle}>
          <Icon name={'rotate'} size={25} solid />
        </IconBtn>
      </IconWrapper>
    </Wrapper>
  );
};

export default Amount;

const Wrapper = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: 30px;
`;

const CurrencyPickerWrapper = styled.View`
  flex: 1;
  flex-wrap: wrap;
`;

const AmountWrapper = styled.View`
  flex: 3;
  align-items: center;
  justify-content: center;
`;

const Primary = styled.Text<{fontSize?: number}>`
  font-size: ${({fontSize}) => fontSize || 26}px;
  font-family: 'Outfit-Bold';
`;

const Secondary = styled.Text<{fontSize?: number}>`
  font-size: ${({fontSize}) => fontSize || 18}px;
  font-family: 'Outfit-Regular';
`;

const IconWrapper = styled.View`
  flex: 1;
  align-items: flex-end;
`;

const IconBtn = styled.TouchableOpacity``;
