import React from 'react';
import {
  Animated,
  StyleSheet,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import {render} from '@testing-library/react-native';

import PinSheet, {
  ERROR_LINES,
  PIN_SHEET_GEOMETRY,
} from '../../../src/components/cashu/charge/PinSheet';
import type {ChargeLayout} from '../../../src/components/cashu/charge/geometry';

/**
 * ENG-698: the PIN sheet's error line wraps to two lines instead of cutting
 * a long failure off. Its slot must hold two lines at the largest font
 * scale the sheet allows (20pt helper line height x 2 x 1.15 = 46), between
 * the dots (bottom at 80) and the keypad (top at 128), without moving
 * either. The assertions read the rendered styles, so a literal slipped into
 * the stylesheet fails here even when the exported constants still agree.
 */
const LAYOUT = {
  pin: {
    cardDy: 0,
    ledgerDy: 0,
    ledgerVisible: false,
    sheetTop: 300,
    sheetH: 480,
    rowHeight: 64,
    readBadge: {cx: 0, cy: 0},
  },
} as unknown as ChargeLayout;

const ERROR = 'This card needs a connection. Nothing was taken.';

function renderSheet(errorText: string | null = ERROR) {
  const v = () => new Animated.Value(1);
  return render(
    <PinSheet
      layout={LAYOUT}
      n={{translateY: v(), opacity: v(), helper: v(), errHelper: v()}}
      green={v()}
      pin=""
      errorText={errorText}
      onDigit={jest.fn()}
      onBackspace={jest.fn()}
      onClear={jest.fn()}
      onConfirm={jest.fn()}
    />,
  );
}

const flat = (style: StyleProp<ViewStyle & TextStyle>) =>
  StyleSheet.flatten(style);

describe('PinSheet error slot (ENG-698)', () => {
  it('wraps to two lines', () => {
    expect(ERROR_LINES).toBe(2);
    const line = renderSheet().getByTestId('pin-error-text');
    expect(line.props.numberOfLines).toBe(2);
    expect(line.props.children).toBe(ERROR);
  });

  it('renders the slot between the dots and the keypad, two lines tall at MAX_FONT_SCALE', () => {
    const slot = flat(renderSheet().getByTestId('pin-error-slot').props.style);
    expect(slot.top).toBe(80);
    expect(slot.height).toBeGreaterThanOrEqual(46);
    expect((slot.top as number) + (slot.height as number)).toBeLessThanOrEqual(
      128,
    );
  });

  it('leaves the keypad where it was', () => {
    const pad = flat(renderSheet().getByTestId('pin-pad').props.style);
    expect(pad.top).toBe(128);
  });

  it('centres each wrapped line, not only the text box', () => {
    const line = flat(renderSheet().getByTestId('pin-error-text').props.style);
    expect(line.textAlign).toBe('center');
  });

  it('exports the same stops it renders', () => {
    expect(PIN_SHEET_GEOMETRY.dotsBottom).toBe(80);
    expect(PIN_SHEET_GEOMETRY.padTop).toBe(128);
    expect(PIN_SHEET_GEOMETRY.errorSlotTop).toBeGreaterThanOrEqual(
      PIN_SHEET_GEOMETRY.dotsBottom,
    );
    expect(
      PIN_SHEET_GEOMETRY.errorSlotTop + PIN_SHEET_GEOMETRY.errorSlotHeight,
    ).toBeLessThanOrEqual(PIN_SHEET_GEOMETRY.padTop);
  });
});
