import {
  ERROR_LINES,
  PIN_SHEET_GEOMETRY,
} from '../../../src/components/cashu/charge/PinSheet';
import {
  MAX_FONT_SCALE,
  TYPE,
} from '../../../src/components/cashu/charge/tokens';

/**
 * ENG-698: the PIN sheet's error line wraps to two lines instead of cutting
 * a long failure off. Its slot must hold two lines at the largest font
 * scale the sheet allows, between the dots and the keypad, without moving
 * either.
 */
describe('PinSheet error slot (ENG-698)', () => {
  it('wraps to two lines', () => {
    expect(ERROR_LINES).toBe(2);
  });

  it('holds two helper lines at MAX_FONT_SCALE', () => {
    expect(PIN_SHEET_GEOMETRY.errorSlotHeight).toBeGreaterThanOrEqual(
      TYPE.helper.lineHeight * 2 * MAX_FONT_SCALE,
    );
  });

  it('sits between the dots and the keypad, which stay where they were', () => {
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
