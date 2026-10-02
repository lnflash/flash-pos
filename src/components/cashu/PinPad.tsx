import React from 'react';
import {Dimensions} from 'react-native';
import styled from 'styled-components/native';
import Icon from 'react-native-vector-icons/FontAwesome6';

const height = Dimensions.get('screen').height;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

/** 'ink' is the charge sheet's quiet pad; 'classic' the original big one. */
export type PinPadTone = 'classic' | 'ink';

const TONES = {
  classic: {clear: '#db254e', back: '#1f2328', icon: 35},
  ink: {clear: '#5f6270', back: '#002118', icon: 22},
} as const;

/**
 * The Visa-style PIN pad: masked entry, 4–8 digits. Self-contained — the
 * caller renders the dots and owns the confirm.
 */
const PinPad = ({
  onDigit,
  onBackspace,
  onClear,
  rowHeight,
  tone = 'classic',
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  /** Fixed row height (dp); defaults to 1/8.5 of the screen. */
  rowHeight?: number;
  tone?: PinPadTone;
}) => {
  const colors = TONES[tone];
  const rowH = rowHeight ?? height / 8.5;
  const key = (d: string, onPress?: () => void, node?: React.ReactNode, label?: string) => (
    <NumBtn
      key={d}
      $h={rowH}
      accessibilityRole="button"
      accessibilityLabel={label ?? d}
      onPress={onPress ?? (() => onDigit(d))}>
      {node ??
        (tone === 'ink' ? (
          <InkText maxFontSizeMultiplier={1.15}>{d}</InkText>
        ) : (
          <NumText>{d}</NumText>
        ))}
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
        {key('clear', onClear, <Icon name={'xmark'} size={colors.icon} color={colors.clear} />, 'Clear')}
        {key('0')}
        {key('back', onBackspace, <Icon name={'delete-left'} size={colors.icon} color={colors.back} />, 'Delete')}
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

const NumBtn = styled.TouchableOpacity<{$h: number}>`
  flex: 1;
  height: ${p => p.$h}px;
  justify-content: center;
  align-items: center;
`;

const NumText = styled.Text`
  font-size: 35px;
  font-weight: bold;
`;

const InkText = styled.Text`
  font-size: 28px;
  line-height: 34px;
  font-family: 'Outfit-Medium';
  color: #002118;
`;
