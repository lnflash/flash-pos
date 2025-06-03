import React, {useEffect} from 'react';
import {ViewStyle, Dimensions} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';
import {useNavigation} from '@react-navigation/native';
import {StackNavigationProp} from '@react-navigation/stack';
import {CurrencyPicker} from '../modals';
import {useRealtimePrice} from '../../hooks';
import {useAppDispatch, useAppSelector} from '../../store/hooks';
import {
  setDisplayAmount,
  setIsPrimaryAmountSats,
  setSatAmount,
} from '../../store/slices/amountSlice';

const {height} = Dimensions.get('screen');

type Props = {
  hideCurrency?: boolean;
  hideToggle?: boolean;
  hideSecondary?: boolean;
  hideTransactionHistory?: boolean;
  style?: ViewStyle;
};

type NavigationProp = StackNavigationProp<RootStackType, 'Home'>;

const Amount: React.FC<Props> = ({
  hideCurrency,
  hideToggle,
  hideSecondary,
  hideTransactionHistory,
  style,
}) => {
  const navigation = useNavigation<NavigationProp>();
  const {currencyToSats, satsToCurrency, loading} = useRealtimePrice();
  const dispatch = useAppDispatch();
  const {currency, isPrimaryAmountSats, displayAmount, satAmount} =
    useAppSelector(state => state.amount);

  useEffect(() => {
    if (!loading && isPrimaryAmountSats) {
      const {convertedCurrencyAmount} = satsToCurrency(Number(satAmount));
      let displayAmount = Number(convertedCurrencyAmount).toFixed(2);
      if (
        convertedCurrencyAmount.toString().includes('NaN') ||
        displayAmount === '0.00'
      ) {
        displayAmount = '0';
      }
      dispatch(setDisplayAmount(displayAmount));
    }
  }, [
    isPrimaryAmountSats,
    satAmount,
    loading,
    currency,
    dispatch,
    satsToCurrency,
  ]);

  useEffect(() => {
    if (!loading && !isPrimaryAmountSats) {
      const {convertedCurrencyAmount} = currencyToSats(Number(displayAmount));
      let satAmount = Math.round(convertedCurrencyAmount).toString();
      if (convertedCurrencyAmount.toString().includes('NaN')) {
        satAmount = '0';
      }
      dispatch(setSatAmount(satAmount));
    }
  }, [
    isPrimaryAmountSats,
    displayAmount,
    loading,
    currency,
    dispatch,
    currencyToSats,
  ]);

  const onToggle = () => {
    dispatch(setIsPrimaryAmountSats(!isPrimaryAmountSats));
  };

  const onTransactionHistory = () => {
    navigation.navigate('TransactionHistory');
  };

  // Calculate dynamic font size based on text length
  const calculateFontSize = (text: string, baseFontSize: number): number => {
    const textLength = text.length;
    let fontSize = baseFontSize;

    // Reduce font size based on text length
    if (textLength > 20) {
      fontSize = Math.max(baseFontSize * 0.5, 20); // Minimum 20px
    } else if (textLength > 15) {
      fontSize = Math.max(baseFontSize * 0.6, 24); // Minimum 24px
    } else if (textLength > 12) {
      fontSize = Math.max(baseFontSize * 0.7, 28); // Minimum 28px
    } else if (textLength > 10) {
      fontSize = Math.max(baseFontSize * 0.8, 32); // Minimum 32px
    } else if (textLength > 8) {
      fontSize = Math.max(baseFontSize * 0.9, 36); // Minimum 36px
    }

    return Math.round(fontSize);
  };

  // Calculate font sizes for current display
  const primaryText = !isPrimaryAmountSats
    ? `${currency.symbol} ${displayAmount || 0}`
    : `${satAmount || 0}`;

  const secondaryText = !isPrimaryAmountSats
    ? `≈ ${satAmount || 0} sats`
    : `${currency.symbol} ${displayAmount || 0}`;

  const primaryFontSize = calculateFontSize(primaryText, 48);
  const secondaryFontSize = calculateFontSize(secondaryText, 36);

  return (
    <Wrapper style={style}>
      {!hideCurrency && (
        <CurrencyPickerWrapper>
          <CurrencyPicker />
        </CurrencyPickerWrapper>
      )}
      {!isPrimaryAmountSats ? (
        <AmountWrapper>
          <Primary
            fontSize={primaryFontSize}
            numberOfLines={1}
            adjustsFontSizeToFit>
            {`${currency.symbol} ${displayAmount || 0}`}
          </Primary>
          {!hideSecondary && (
            <Secondary
              fontSize={secondaryFontSize}
              numberOfLines={1}
              adjustsFontSizeToFit>
              ≈ {satAmount || 0} sats
            </Secondary>
          )}
        </AmountWrapper>
      ) : (
        <AmountWrapper>
          <Primary
            fontSize={primaryFontSize}
            numberOfLines={1}
            adjustsFontSizeToFit>
            {satAmount || 0} sats
          </Primary>
          {!hideSecondary && (
            <Secondary
              fontSize={secondaryFontSize}
              numberOfLines={1}
              adjustsFontSizeToFit>
              {`${currency.symbol} ${displayAmount || 0}`}
            </Secondary>
          )}
        </AmountWrapper>
      )}
      {!hideTransactionHistory && (
        <IconWrapper keypadRowHeight={height / 8.5}>
          {!hideToggle ? (
            <IconBtn hitSlop={10} onPress={onToggle}>
              <Icon name={'rotate'} size={25} solid />
            </IconBtn>
          ) : (
            <IconBtn hitSlop={10} onPress={onTransactionHistory}>
              <Icon name={'clock-rotate-left'} size={25} solid />
            </IconBtn>
          )}
        </IconWrapper>
      )}
    </Wrapper>
  );
};

const Wrapper = styled.View`
  flex-direction: row;
  align-items: center;
  margin-bottom: 20px;
`;

const CurrencyPickerWrapper = styled.View`
  flex: 1;
  flex-wrap: wrap;
`;

const AmountWrapper = styled.View`
  flex: 3;
  align-items: center;
  justify-content: center;
  padding-horizontal: 10px;
`;

const Primary = styled.Text<{fontSize: number}>`
  font-size: ${({fontSize}) => fontSize}px;
  font-family: 'Outfit-Bold';
  color: #000;
  text-align: center;
`;

const Secondary = styled.Text<{fontSize: number}>`
  font-size: ${({fontSize}) => fontSize}px;
  font-family: 'Outfit-Regular';
  color: #000;
  text-align: center;
`;

const IconWrapper = styled.View<{keypadRowHeight: number}>`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const IconBtn = styled.TouchableOpacity``;

export default Amount;
